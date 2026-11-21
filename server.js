const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 7778;

const state = {
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
  players: []
};

function pushEv(tp, x, y, txt) {
  state.evSeq++;
  state.evType = tp;
  state.evX = x;
  state.evY = y;
  state.evText = txt;
}

function setSpawn(p) {
  if (p.role === 1) { p.x = 395; p.y = 152; p.room = 0; }
  else if (p.role === 2) { p.x = 525; p.y = 152; p.room = 0; }
  else if (p.role === 3) { p.x = 765; p.y = 375; p.room = -1; }
  else if (p.role === 4) { p.x = 145; p.y = 320; p.room = -1; }
}

function resetMatch() {
  state.gen++;
  state.gameOver = false;
  state.won = false;
  state.endReason = "";
  state.timeRemaining = state.configDuration;
  state.hunger = 100;
  state.doorLocked = false;
  state.doorBar = state.configLockSecs;
  state.windowClosed = false;
  state.windowBar = state.configLockSecs;
  for (const p of state.players) {
    p.moving = false;
    p.carryingFood = false;
    p.stunnedTimer = 0;
    p.noiseCooldown = 0;
    setSpawn(p);
  }
  pushEv("reset", 470, 320, "PARTIDA REINICIADA!");
}

function ensureBots() {
  state.players = state.players.filter(p => !p.token.startsWith("BOT_"));
  const limit = state.maxPlayers >= 4 ? 4 : 3;
  for (let r = 1; r <= limit; r++) {
    if (!state.players.some(p => p.role === r)) {
      const names = ["", "IrmaoVelho(IA)", "IrmaoNovo(IA)", "Sequestrador(IA)", "Amigo(IA)"];
      const b = {
        token: "BOT_" + r, nick: names[r], role: r, isHost: false,
        x: 440, y: 220, room: 0, moving: false, carryingFood: false,
        stunnedTimer: 0, noiseCooldown: 0, doorEntryCooldown: 15, aiTimer: 1, aiTarget: { x: 765, y: 150 }
      };
      setSpawn(b);
      state.players.push(b);
    }
  }
}

function serializeState() {
  const head = [
    state.phase, state.maxPlayers, Math.round(state.configDuration), state.configDiff, state.gen,
    state.gameOver ? 1 : 0, state.won ? 1 : 0, state.endReason.replace(/;/g, " "),
    state.timeRemaining.toFixed(1), state.hunger.toFixed(1),
    state.doorLocked ? 1 : 0, state.doorBar.toFixed(1),
    state.windowClosed ? 1 : 0, state.windowBar.toFixed(1),
    state.evSeq, state.evType, state.evX.toFixed(1), state.evY.toFixed(1), state.evText.replace(/;/g, " "),
    state.radioSeq, state.radioSender.replace(/;/g, " "), state.radioMsg.replace(/;/g, " ")
  ].join(";");

  const plist = state.players.map(p => [
    p.nick.replace(/:/g, ""), p.role, p.isHost ? 1 : 0,
    p.x.toFixed(1), p.y.toFixed(1), p.room,
    p.moving ? 1 : 0, p.carryingFood ? 1 : 0,
    p.stunnedTimer.toFixed(1), p.noiseCooldown.toFixed(1)
  ].join(":")).join(",");

  return head + "#" + plist;
}

function processCommand(line) {
  const parts = line.trim().split("|");
  const op = parts[0];
  const findTok = tok => state.players.find(p => p.token === tok);

  if (op === "HOST") {
    const nick = parts[1] || "Anfitriao";
    state.maxPlayers = 2; state.phase = "lobby"; state.configDuration = 510; state.configDiff = "Normal";
    state.configHungerMode = 0; state.configLockSecs = 10;
    state.players = [];
    resetMatch();
    const tok = crypto.randomBytes(5).toString("hex");
    state.players.push({
      token: tok, nick, role: 1, isHost: true, x: 440, y: 220, room: 0,
      moving: false, carryingFood: false, stunnedTimer: 0, noiseCooldown: 0
    });
    return "OK|" + tok + "|ONLINE";
  }
  if (op === "JOIN") {
    const nick = parts[1] || "Jogador";
    if (state.players.length === 0) return "ERR|Nenhuma sala aberta no servidor.";
    if (state.players.length >= state.maxPlayers) return `ERR|Partida ja esta lotada! (${state.players.length}/${state.maxPlayers})`;
    if (state.phase !== "lobby") return "ERR|A partida ja comecou!";
    const tok = crypto.randomBytes(5).toString("hex");
    const r = state.players.length + 1;
    state.players.push({
      token: tok, nick, role: r, isHost: false, x: 440 + (r - 1) * 42, y: 220, room: 0,
      moving: false, carryingFood: false, stunnedTimer: 0, noiseCooldown: 0
    });
    return `OK|${tok}|${r}|${state.maxPlayers}`;
  }
  if (op === "CFG" && parts.length >= 5) {
    const h = findTok(parts[1]);
    if (h && h.isHost && state.phase === "lobby") {
      state.maxPlayers = Math.max(2, Math.min(4, parseInt(parts[2], 10) || 2));
      state.configDuration = parseFloat(parts[3]) || 510;
      state.configDiff = parts[4] || "Normal";
      if (parts.length >= 6) state.configHungerMode = parseInt(parts[5], 10) || 0;
      if (parts.length >= 7) {
        state.configLockSecs = parseFloat(parts[6]) || 10;
        state.doorBar = state.configLockSecs;
        state.windowBar = state.configLockSecs;
      }
    }
    return serializeState();
  }
  if (op === "BEGIN_SELECT") {
    const h = findTok(parts[1]);
    if (h && h.isHost) state.phase = "select";
    return serializeState();
  }
  if (op === "PICK" && parts.length >= 3) {
    const me = findTok(parts[1]);
    const wanted = parseInt(parts[2], 10);
    if (me && state.phase === "select" && wanted >= 1 && wanted <= state.maxPlayers) {
      if (!state.players.some(o => o !== me && o.role === wanted)) {
        me.role = wanted;
        setSpawn(me);
      }
    }
    return serializeState();
  }
  if (op === "START_MATCH" || op === "RESET") {
    const h = findTok(parts[1]);
    if (h && h.isHost) { resetMatch(); ensureBots(); state.phase = "playing"; }
    return serializeState();
  }
  if (op === "LOBBY_BACK") {
    const h = findTok(parts[1]);
    if (h && h.isHost) {
      state.phase = "lobby";
      state.players = state.players.filter(p => !p.token.startsWith("BOT_"));
      state.players.forEach((p, idx) => { p.x = 440 + idx * 42; p.y = 220; p.room = 0; });
    }
    return serializeState();
  }
  if (op === "SYNC" && parts.length >= 7) {
    const me = findTok(parts[1]);
    if (me) {
      me.x = parseFloat(parts[2]) || me.x;
      me.y = parseFloat(parts[3]) || me.y;
      me.room = parseInt(parts[4], 10) || 0;
      me.moving = parts[5] === "1";
      me.carryingFood = parts[6] === "1";
    }
    return serializeState();
  }
  if (op === "ACT" && parts.length >= 3) {
    const me = findTok(parts[1]);
    const act = parts[2];
    if (me && state.phase === "playing" && !state.gameOver) {
      if (act === "door" && me.role === 1 && !state.doorLocked && !state.windowClosed && state.doorBar >= state.configLockSecs - 0.1) {
        state.doorLocked = true; pushEv("door_lock", 700, 375, "PORTA TRANCADA!");
      } else if (act === "window" && me.role === 2 && !state.windowClosed && !state.doorLocked && state.windowBar >= state.configLockSecs - 0.1) {
        state.windowClosed = true; pushEv("window_close", 700, 150, "JANELA FECHADA!");
      } else if (act === "food" && me.role === 1) {
        me.carryingFood = false; state.hunger = Math.min(100, state.hunger + 45); pushEv("food", me.x, me.y, "+45% COMIDA!");
      } else if (act === "noise" && me.noiseCooldown <= 0 && me.stunnedTimer <= 0) {
        me.noiseCooldown = 12; pushEv("noise", me.role <= 2 ? 700 : me.x, me.role <= 2 ? 150 : me.y, "BARULHO!");
      } else if (act === "radio" && parts.length >= 4) {
        state.radioSeq++; state.radioSender = me.nick; state.radioMsg = parts[3];
      }
    }
    return serializeState();
  }
  return serializeState();
}

// Tick de simulacao do servidor online (20 Hz)
setInterval(() => {
  if (state.phase !== "playing" || state.gameOver) return;
  const dt = 0.05;
  state.timeRemaining -= dt;
  if (state.timeRemaining <= 0) { state.timeRemaining = 0; state.gameOver = true; state.won = true; state.endReason = "06:00 DA MANHA! Vitoria!"; return; }
  const hRate = state.configHungerMode === 1 ? 1.85 : (state.configHungerMode === 2 ? 0 : 1.05);
  state.hunger -= dt * hRate;
  if (state.hunger <= 0) { state.hunger = 0; state.gameOver = true; state.won = false; state.endReason = "Os irmaos desmaiaram de fome!"; return; }

  if (state.doorLocked) {
    state.doorBar -= dt;
    if (state.doorBar <= 0) { state.doorBar = 0; state.doorLocked = false; pushEv("door_open", 700, 375, "PORTA DESTRANCOU!"); }
  } else state.doorBar = Math.min(state.configLockSecs, state.doorBar + dt);

  if (state.windowClosed) {
    state.windowBar -= dt;
    if (state.windowBar <= 0) { state.windowBar = 0; state.windowClosed = false; pushEv("window_open", 700, 150, "JANELA ABRIU!"); }
  } else state.windowBar = Math.min(state.configLockSecs, state.windowBar + dt);

  for (const p of state.players) {
    if (p.stunnedTimer > 0) p.stunnedTimer = Math.max(0, p.stunnedTimer - dt);
    if (p.noiseCooldown > 0) p.noiseCooldown = Math.max(0, p.noiseCooldown - dt);
  }
}, 50);

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/cmd" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(processCommand(body));
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("NoPolice Online Server OK! Use POST /cmd pelo PC (.exe) ou Android (.apk).");
});

server.listen(PORT, () => console.log("NoPolice Online Server rodando na porta", PORT));
