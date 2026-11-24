const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 7778;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();       // roomCode -> roomState
const tokenToRoom = new Map(); // token -> roomCode
const wsClients = new Set();   // { socket, token, roomCode }

function makeRoomCode() {
  for (let tries = 0; tries < 50; tries++) {
    const bytes = crypto.randomBytes(6);
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function createRoom(code) {
  return {
    code,
    lastActivity: Date.now(),
    phase: "lobby",
    maxPlayers: 2,
    configDuration: 510,
    configDiff: "Normal",
    configHungerMode: 0,
    configLockSecs: 10,
    gen: 0,
    gameOver: false,
    won: false,
    endReason: "",
    timeRemaining: 510,
    hunger: 100,
    doorLocked: false,
    doorBar: 10,
    windowClosed: false,
    windowBar: 10,
    evSeq: 0,
    evType: "",
    evX: 0,
    evY: 0,
    evText: "",
    radioSeq: 0,
    radioSender: "",
    radioMsg: "",
    voiceSeq: 0,
    voiceFromRole: 0,
    voiceSender: "",
    voiceB64: "",
    players: []
  };
}

function pushEv(st, tp, x, y, txt) {
  st.evSeq++; st.evType = tp; st.evX = x; st.evY = y; st.evText = txt;
}

function setSpawn(p) {
  if (p.role === 1) { p.x = 395; p.y = 152; p.room = 0; }
  else if (p.role === 2) { p.x = 525; p.y = 152; p.room = 0; }
  else if (p.role === 3) { p.x = 765; p.y = 375; p.room = -1; }
  else if (p.role === 4) { p.x = 145; p.y = 320; p.room = -1; }
}

function resetMatch(st) {
  st.gen++; st.gameOver = false; st.won = false; st.endReason = "";
  st.timeRemaining = st.configDuration; st.hunger = 100;
  st.doorLocked = false; st.doorBar = st.configLockSecs;
  st.windowClosed = false; st.windowBar = st.configLockSecs;
  for (const p of st.players) {
    p.moving = false; p.carryingFood = false; p.stunnedTimer = 0; p.noiseCooldown = 0;
    setSpawn(p);
  }
  pushEv(st, "reset", 470, 320, "PARTIDA REINICIADA!");
}

function ensureBots(st) {
  st.players = st.players.filter(p => !p.token.startsWith("BOT_"));
  const limit = st.maxPlayers >= 4 ? 4 : 3;
  for (let r = 1; r <= limit; r++) {
    if (!st.players.some(p => p.role === r)) {
      const names = ["", "Irmao Mais Velho", "Irmao Mais Novo", "Sequestrador", "Amigo"];
      const b = {
        token: "BOT_" + r, nick: names[r], role: r, isHost: false,
        x: 440, y: 220, room: 0, moving: false, carryingFood: false,
        stunnedTimer: 0, noiseCooldown: 0, doorEntryCooldown: 30, aiTimer: 1
      };
      setSpawn(b);
      st.players.push(b);
    }
  }
}

function serializeState(st) {
  const head = [
    st.phase, st.maxPlayers, Math.round(st.configDuration), st.configDiff, st.gen,
    st.gameOver ? 1 : 0, st.won ? 1 : 0, st.endReason.replace(/;/g, " "),
    st.timeRemaining.toFixed(1), st.hunger.toFixed(1),
    st.doorLocked ? 1 : 0, st.doorBar.toFixed(1),
    st.windowClosed ? 1 : 0, st.windowBar.toFixed(1),
    st.evSeq, st.evType, st.evX.toFixed(1), st.evY.toFixed(1), st.evText.replace(/;/g, " "),
    st.radioSeq, st.radioSender.replace(/;/g, " "), st.radioMsg.replace(/;/g, " "),
    st.voiceSeq, st.voiceFromRole, st.voiceSender.replace(/;/g, " ")
  ].join(";");

  const plist = st.players.map(p => [
    p.nick.replace(/:/g, ""), p.role, p.isHost ? 1 : 0,
    p.x.toFixed(1), p.y.toFixed(1), p.room,
    p.moving ? 1 : 0, p.carryingFood ? 1 : 0,
    p.stunnedTimer.toFixed(1), p.noiseCooldown.toFixed(1)
  ].join(":")).join(",");

  return head + "#" + plist;
}

function getRoomByToken(tok) {
  const code = tokenToRoom.get(tok);
  return code ? rooms.get(code) : null;
}

// === ZERO-DEPENDENCY RFC 6455 WEBSOCKET FRAME ENCODER/DECODER ===
function wsSendText(socket, text) {
  if (!socket || socket.destroyed) return;
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}

function broadcastRoom(st) {
  const msg = serializeState(st);
  for (const cl of wsClients) {
    if (cl.roomCode === st.code && cl.socket && !cl.socket.destroyed) {
      wsSendText(cl.socket, msg);
    }
  }
}

function processCommand(line, wsClient) {
  const parts = line.trim().split("|");
  const op = parts[0];

  if (op === "PING") return "PONG";

  if (op === "HOST") {
    const nick = parts[1] || "Anfitriao";
    const code = makeRoomCode();
    const st = createRoom(code);
    const tok = crypto.randomBytes(5).toString("hex");
    st.players.push({
      token: tok, nick, role: 1, isHost: true, x: 440, y: 220, room: 0,
      moving: false, carryingFood: false, stunnedTimer: 0, noiseCooldown: 0
    });
    rooms.set(code, st);
    tokenToRoom.set(tok, code);
    if (wsClient) { wsClient.token = tok; wsClient.roomCode = code; }
    return `OK|${tok}|${code}`;
  }

  if (op === "JOIN") {
    const nick = parts[1] || "Jogador";
    const reqCode = (parts[2] || "").trim().toUpperCase();
    let st = reqCode ? rooms.get(reqCode) : null;
    if (!st && !reqCode && rooms.size > 0) {
      st = Array.from(rooms.values())[rooms.size - 1];
    }
    if (!st) return reqCode ? `ERR|Sala '${reqCode}' nao encontrada!` : "ERR|Digite o codigo de 6 letras da sala!";
    st.lastActivity = Date.now();
    if (st.players.length >= st.maxPlayers) return `ERR|Partida ja esta lotada! (${st.players.length}/${st.maxPlayers})`;
    if (st.phase !== "lobby") return "ERR|A partida ja comecou!";
    const tok = crypto.randomBytes(5).toString("hex");
    const r = st.players.length + 1;
    st.players.push({
      token: tok, nick, role: r, isHost: false, x: 440 + (r - 1) * 42, y: 220, room: 0,
      moving: false, carryingFood: false, stunnedTimer: 0, noiseCooldown: 0
    });
    tokenToRoom.set(tok, st.code);
    if (wsClient) { wsClient.token = tok; wsClient.roomCode = st.code; }
    broadcastRoom(st);
    return `OK|${tok}|${r}|${st.maxPlayers}|${st.code}`;
  }

  if (op === "STATE") {
    const key = parts[1] || "";
    const st = getRoomByToken(key) || rooms.get(key.toUpperCase());
    if (!st) return "ONLINE_OK";
    st.lastActivity = Date.now();
    if (wsClient && key) { wsClient.token = key; wsClient.roomCode = st.code; }
    return serializeState(st);
  }

  const tok = parts[1] || "";
  const st = getRoomByToken(tok);
  if (!st) return "ERR|Sala encerrada.";
  if (wsClient) { wsClient.token = tok; wsClient.roomCode = st.code; }
  st.lastActivity = Date.now();
  const me = st.players.find(p => p.token === tok);

  if (op === "CFG" && parts.length >= 5) {
    if (me && me.isHost) {
      const curHumans = st.players.filter(p => !p.token.startsWith("BOT_")).length;
      st.maxPlayers = Math.max(curHumans, Math.max(2, Math.min(4, parseInt(parts[2], 10) || 2)));
      st.configDuration = parseFloat(parts[3]) || 510;
      st.configDiff = parts[4] || "Normal";
      if (parts.length >= 6) st.configHungerMode = parseInt(parts[5], 10) || 0;
      if (parts.length >= 7) {
        st.configLockSecs = parseFloat(parts[6]) || 10;
        st.doorBar = st.configLockSecs;
        st.windowBar = st.configLockSecs;
      }
      broadcastRoom(st);
    }
    return serializeState(st);
  }
  if (op === "BEGIN_SELECT") {
    if (me && me.isHost) {
      const humans = st.players.filter(p => !p.token.startsWith("BOT_"));
      if (humans.length < st.maxPlayers) return `ERR|Faltam jogadores! (${humans.length}/${st.maxPlayers} na sala)`;
      st.players = humans;
      for (const p of st.players) p.role = 0;
      st.phase = "select";
      broadcastRoom(st);
    }
    return serializeState(st);
  }
  if (op === "PICK" && parts.length >= 3) {
    const wanted = parseInt(parts[2], 10);
    if (me && st.phase === "select" && wanted >= 1 && wanted <= st.maxPlayers) {
      const owner = st.players.find(o => o !== me && o.role === wanted);
      if (owner) return "ERR|Ja foi pego por " + owner.nick + "!";
      me.role = wanted;
      setSpawn(me);
      const humans = st.players.filter(p => !p.token.startsWith("BOT_"));
      if (humans.length === st.maxPlayers && humans.every(p => p.role >= 1 && p.role <= st.maxPlayers)) {
        resetMatch(st);
        ensureBots(st);
        st.phase = "playing";
      }
      broadcastRoom(st);
    }
    return serializeState(st);
  }
  if (op === "START_MATCH" || op === "RESET") {
    if (me && me.isHost) {
      const humans = st.players.filter(p => !p.token.startsWith("BOT_"));
      if (op === "START_MATCH" && humans.length < st.maxPlayers) return `ERR|Faltam jogadores! (${humans.length}/${st.maxPlayers} na sala)`;
      resetMatch(st); ensureBots(st); st.phase = "playing";
      broadcastRoom(st);
    }
    return serializeState(st);
  }
  if (op === "LOBBY_BACK") {
    if (me && me.isHost) {
      st.phase = "lobby";
      st.players = st.players.filter(p => !p.token.startsWith("BOT_"));
      st.players.forEach((p, idx) => { p.x = 440 + idx * 42; p.y = 220; p.room = 0; });
      broadcastRoom(st);
    }
    return serializeState(st);
  }
  if (op === "SYNC" && parts.length >= 7) {
    if (me) {
      me.x = parseFloat(parts[2]) || me.x;
      me.y = parseFloat(parts[3]) || me.y;
      me.room = parseInt(parts[4], 10) || 0;
      me.moving = parts[5] === "1";
      me.carryingFood = parts[6] === "1";
    }
    return serializeState(st);
  }
  if (op === "ACT" && parts.length >= 3) {
    const act = parts[2];
    if (me && st.phase === "playing" && !st.gameOver) {
      if (act === "door" && me.role === 1 && !st.doorLocked && !st.windowClosed && st.doorBar >= st.configLockSecs - 0.1) {
        st.doorLocked = true; pushEv(st, "door_lock", 700, 375, "PORTA TRANCADA!");
      } else if (act === "window" && me.role === 2 && !st.windowClosed && !st.doorLocked && st.windowBar >= st.configLockSecs - 0.1) {
        st.windowClosed = true; pushEv(st, "window_close", 700, 150, "JANELA FECHADA!");
      } else if (act === "food" && me.role === 1) {
        me.carryingFood = false; st.hunger = Math.min(100, st.hunger + 45); pushEv(st, "food", me.x, me.y, "+45% COMIDA!");
      } else if (act === "noise" && me.noiseCooldown <= 0 && me.stunnedTimer <= 0) {
        me.noiseCooldown = 12; pushEv(st, "noise", me.role <= 2 ? 700 : me.x, me.role <= 2 ? 150 : me.y, "BARULHO DE DISTRACAO!");
      } else if (act === "radio" && parts.length >= 4) {
        st.radioSeq++; st.radioSender = me.nick; st.radioMsg = parts[3];
      }
      broadcastRoom(st);
    }
    return serializeState(st);
  }
  if (op === "VOICE" && parts.length >= 3) {
    if (me && (st.phase === "lobby" || me.role !== 3)) {
      st.voiceSeq++; st.voiceFromRole = me.role; st.voiceSender = me.nick; st.voiceB64 = parts[2];
      broadcastRoom(st);
    }
    return "OK_VOICE|" + st.voiceSeq;
  }
  if (op === "GET_VOICE") {
    return st.voiceB64 || "";
  }
  return serializeState(st);
}

// 20 Hz Real-Time Tick & Instant WebSocket Broadcast for ALL rooms (zero polling lag!)
setInterval(() => {
  const now = Date.now();
  for (const [code, st] of rooms.entries()) {
    if (now - st.lastActivity > 30 * 60 * 1000) { rooms.delete(code); continue; }
    if (st.phase === "playing" && !st.gameOver) {
      const dt = 0.05;
      st.timeRemaining -= dt;
      if (st.timeRemaining <= 0) { st.timeRemaining = 0; st.gameOver = true; st.won = true; st.endReason = "06:00 DA MANHA! Vitoria!"; }
      const hRate = st.configHungerMode === 1 ? 1.85 : (st.configHungerMode === 2 ? 0 : 1.05);
      st.hunger -= dt * hRate;
      if (st.hunger <= 0) { st.hunger = 0; st.gameOver = true; st.won = false; st.endReason = "Os irmaos desmaiaram de fome!"; }
      if (st.doorLocked) {
        st.doorBar -= dt;
        if (st.doorBar <= 0) { st.doorBar = 0; st.doorLocked = false; pushEv(st, "door_open", 700, 375, "PORTA DESTRANCOU!"); }
      } else st.doorBar = Math.min(st.configLockSecs, st.doorBar + dt);
      if (st.windowClosed) {
        st.windowBar -= dt;
        if (st.windowBar <= 0) { st.windowBar = 0; st.windowClosed = false; pushEv(st, "window_open", 700, 150, "JANELA ABRIU!"); }
      } else st.windowBar = Math.min(st.configLockSecs, st.windowBar + dt);
      for (const p of st.players) {
        if (p.stunnedTimer > 0) p.stunnedTimer = Math.max(0, p.stunnedTimer - dt);
        if (p.noiseCooldown > 0) p.noiseCooldown = Math.max(0, p.noiseCooldown - dt);
      }
    }
    broadcastRoom(st);
  }
}, 50);

const server = http.createServer((req, res) => {
  if (req.socket) req.socket.setNoDelay(true);
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/cmd" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(processCommand(body, null));
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("NoPolice Real-Time WebSocket + HTTP Server v1.3 OK! Salas ativas: " + rooms.size);
});

// Native RFC 6455 WebSocket upgrade on the exact same Render URL (wss://nopolice-server.onrender.com)
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.setNoDelay(true);
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  const cl = { socket, token: "", roomCode: "" };
  wsClients.add(cl);
  let buf = Buffer.alloc(0);

  socket.on("data", chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.slice(off, off + 4) : null;
      const payload = Buffer.from(buf.slice(off + maskLen, off + maskLen + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.slice(off + maskLen + len);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0x00])); } catch {} continue; }
      if (opcode === 0x1) {
        const text = payload.toString("utf8");
        const reply = processCommand(text, cl);
        if (reply && !text.startsWith("SYNC|")) wsSendText(socket, reply);
      }
    }
  });
  socket.on("close", () => wsClients.delete(cl));
  socket.on("error", () => wsClients.delete(cl));
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, () => console.log("NoPolice Real-Time WebSocket Server v1.3 na porta", PORT));
