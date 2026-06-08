// ============================================================
// ALTA VISTA RP — altavista-server.js  (VERSÃO ATOMS.DEV FINAL)
// WebSocket PURO — compatível com NativeWebSocket (Unity)
//                  e com o painel admin HTML nativo
//
// npm install ws express
// node altavista-server.js
// PORT=3000 (ou defina env PORT)
// ============================================================

const http    = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const path    = require('path');
const crypto  = require('crypto');

// ─── Config ───────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const TICK_RATE     = 50;          // ms  → 20 Hz
const INCOME_RATE   = 30_000;      // ms  → renda a cada 30s
const JAIL_CHECK    = 1_000;       // ms  → verifica timers de cadeia
const SPEED_LIMIT   = 16;          // unidades/tick (runSpeed×2)
const MAX_WANTED    = 5;

const FACTIONS = ['civil', 'vermelho', 'azul', 'verde', 'policia'];

const FACTION_INCOME = {
  civil:    100,
  vermelho: 150,
  azul:     150,
  verde:    150,
  policia:  200,
};

const WEATHER_CYCLE = ['clear', 'cloudy', 'rainy', 'foggy', 'storm'];

// ─── Estado global ────────────────────────────────────────
const players = {};   // id → PlayerData
let   gameTime = 0;
let   weatherIdx = 0;
let   tickCount  = 0;

// ─── Helpers ─────────────────────────────────────────────
function uid() { return crypto.randomBytes(6).toString('hex'); }

function send(ws, type, payload = {}) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type, payload }));
  } catch(e) { /* ignore */ }
}

function broadcast(type, payload = {}, exceptId = null) {
  const msg = JSON.stringify({ type, payload });
  for (const [id, p] of Object.entries(players)) {
    if (id === exceptId) continue;
    if (p.ws.readyState !== WebSocket.OPEN) continue;
    try { p.ws.send(msg); } catch(e) { /* ignore */ }
  }
}

function broadcastAll(type, payload = {}) {
  broadcast(type, payload, null);
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function dist3D(a, b) {
  return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
}

// ─── Express + HTTP + WS ─────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// Serve o painel admin estático
app.use(express.static(path.join(__dirname, '../AdminPanel')));

// API REST para o painel admin (leitura)
app.get('/api/status', (req, res) => {
  res.json({
    gameTime,
    weather: WEATHER_CYCLE[weatherIdx],
    playerCount: Object.keys(players).length,
    players: Object.values(players).map(p => ({
      id:       p.id,
      name:     p.name,
      faction:  p.faction,
      health:   p.health,
      money:    p.money,
      bank:     p.bank,
      wanted:   p.wanted,
      jailed:   p.jailed,
      jailTime: p.jailTime,
      x: p.x, y: p.y, z: p.z,
    })),
  });
});

// API REST — ações do painel admin
app.use(express.json());

app.post('/api/admin/arrest', (req, res) => {
  const { id, seconds = 60 } = req.body;
  if (!players[id]) return res.status(404).json({ error: 'player not found' });
  arrestPlayer(id, seconds);
  res.json({ ok: true });
});

app.post('/api/admin/release', (req, res) => {
  const { id } = req.body;
  if (!players[id]) return res.status(404).json({ error: 'player not found' });
  releasePlayer(id);
  res.json({ ok: true });
});

app.post('/api/admin/fine', (req, res) => {
  const { id, amount = 500 } = req.body;
  if (!players[id]) return res.status(404).json({ error: 'player not found' });
  const p = players[id];
  p.money = Math.max(0, p.money - amount);
  send(p.ws, 'economy_update', { money: p.money, bank: p.bank });
  send(p.ws, 'notification', { msg: `💸 Multa de $${amount} aplicada.` });
  res.json({ ok: true });
});

app.post('/api/admin/kill', (req, res) => {
  const { id } = req.body;
  if (!players[id]) return res.status(404).json({ error: 'player not found' });
  killPlayer(id, 'admin');
  res.json({ ok: true });
});

app.post('/api/admin/wanted', (req, res) => {
  const { id, level = 0 } = req.body;
  if (!players[id]) return res.status(404).json({ error: 'player not found' });
  setWanted(id, level);
  res.json({ ok: true });
});

// ─── Lógica de jogo ───────────────────────────────────────
function arrestPlayer(id, seconds) {
  const p = players[id];
  if (!p) return;
  p.jailed   = true;
  p.jailTime = seconds;
  p.wanted   = 0;
  send(p.ws, 'arrested', { time: seconds });
  send(p.ws, 'wanted_update', { id, level: 0 });
  broadcast('wanted_update', { id, level: 0 });
  console.log(`[AV] ${p.name} preso por ${seconds}s`);
}

function releasePlayer(id) {
  const p = players[id];
  if (!p) return;
  p.jailed   = false;
  p.jailTime = 0;
  send(p.ws, 'released', '');      // string vazia — FIX-S5
  console.log(`[AV] ${p.name} solto`);
}

function killPlayer(id, killerId) {
  const p = players[id];
  if (!p || p.dead) return;
  p.dead   = true;
  p.health = 0;
  p.money  = Math.floor(p.money * 0.5); // perde 50% do dinheiro em mão
  broadcastAll('player_died', { id, killerId });
  send(p.ws, 'economy_update', { money: p.money, bank: p.bank });
  // Respawn em 5s
  setTimeout(() => {
    if (!players[id]) return;
    p.dead   = false;
    p.health = 100;
    p.x = 0; p.y = 0; p.z = 0;
    send(p.ws, 'respawn', { x: 0, y: 0, z: 0 });
  }, 5000);
}

function setWanted(id, level) {
  const p = players[id];
  if (!p) return;
  p.wanted = Math.min(MAX_WANTED, Math.max(0, level));
  broadcastAll('wanted_update', { id, level: p.wanted });
}

// ─── Conexão WebSocket ────────────────────────────────────
wss.on('connection', (ws) => {
  const id = uid();

  players[id] = {
    id, ws,
    name: null, faction: 'civil',
    health: 100, money: 500, bank: 0,
    wanted: 0, jailed: false, jailTime: 0, dead: false,
    x: 0, y: 0, z: 0,
    rx: 0, ry: 0, rz: 0, rw: 1,
    lastPos: { x: 0, y: 0, z: 0 },
    lastUpdate: Date.now(),
    loggedIn: false,
  };

  // Registra o ID no cliente
  send(ws, 'register', { id });
  console.log(`[AV] Conexão: ${id}`);

  ws.on('message', (raw) => {
    let packet;
    try { packet = JSON.parse(raw); }
    catch { return; }

    const { type, payload } = packet;
    let data = {};
    if (typeof payload === 'string' && payload.length > 0) {
      data = safeParseJSON(payload) ?? {};
    } else if (typeof payload === 'object' && payload !== null) {
      data = payload;
    }

    dispatch(id, type, data);
  });

  ws.on('close', () => {
    const p = players[id];
    if (p) {
      console.log(`[AV] Desconectado: ${p.name ?? id}`);
      broadcast('player_left', { id }, id);
    }
    delete players[id];
  });

  ws.on('error', (err) => console.error(`[AV] WS error ${id}:`, err.message));
});

// ─── Dispatcher central ───────────────────────────────────
function dispatch(id, type, data) {
  const p = players[id];
  if (!p) return;

  try {
    switch (type) {

      case 'login': {
        if (p.loggedIn) return;
        const name    = (data.name ?? '').trim().slice(0, 20);
        const faction = FACTIONS.includes(data.faction) ? data.faction : 'civil';
        if (name.length < 3) {
          send(p.ws, 'error', { msg: 'Nome inválido (mín 3 chars).' });
          return;
        }
        p.name     = name;
        p.faction  = faction;
        p.loggedIn = true;

        // Envia estado completo ao próprio jogador
        send(p.ws, 'login_ok', {
          id: p.id, name: p.name, faction: p.faction,
          health: p.health, money: p.money, bank: p.bank,
          wanted: p.wanted, jailed: p.jailed,
          x: p.x, y: p.y, z: p.z,
        });

        // Envia jogadores já conectados
        for (const [oid, op] of Object.entries(players)) {
          if (oid === id || !op.loggedIn) continue;
          send(p.ws, 'player_joined', {
            id: op.id, name: op.name, faction: op.faction,
            x: op.x, y: op.y, z: op.z,
          });
        }

        // Anuncia novo jogador para todos
        broadcast('player_joined', {
          id: p.id, name: p.name, faction: p.faction,
          x: p.x, y: p.y, z: p.z,
        }, id);

        console.log(`[AV] Login: ${name} [${faction}]`);
        break;
      }

      case 'move': {
        if (!p.loggedIn || p.jailed || p.dead) return;

        const nx = data.x ?? p.x;
        const ny = data.y ?? p.y;
        const nz = data.z ?? p.z;

        // Anti-speedhack — FIX-S4
        const d = dist3D({ x: nx, y: ny, z: nz }, { x: p.x, y: p.y, z: p.z });
        if (d > SPEED_LIMIT) {
          send(p.ws, 'correction', { x: p.x, y: p.y, z: p.z });
          return;
        }

        p.x = nx; p.y = ny; p.z = nz;
        p.rx = data.rx ?? p.rx;
        p.ry = data.ry ?? p.ry;
        p.rz = data.rz ?? p.rz;
        p.rw = data.rw ?? p.rw;
        p.lastUpdate = Date.now();

        // Broadcast só para outros — FIX-S3
        broadcast('player_moved', {
          id, x: p.x, y: p.y, z: p.z,
          rx: p.rx, ry: p.ry, rz: p.rz, rw: p.rw,
        }, id);
        break;
      }

      case 'rp_chat': {
        if (!p.loggedIn) return;
        const text = (data.text ?? '').trim().slice(0, 200);
        if (!text) return;
        broadcastAll('rp_chat', { id, name: p.name, type: data.type ?? 'say', text });
        break;
      }

      case 'gesture': {
        if (!p.loggedIn) return;
        broadcastAll('gesture', { id, gesture: data.gesture });
        break;
      }

      case 'shoot': {
        if (!p.loggedIn || p.dead) return;
        const target = players[data.targetId];
        if (!target || target.dead) return;

        const dmg = data.hitbox === 'head' ? 80 : 35;
        target.health = Math.max(0, target.health - dmg);

        broadcastAll('hit', { targetId: target.id, shooter: id, health: target.health });

        if (target.health <= 0) {
          killPlayer(target.id, id);
          // Aumenta wanted do atirador fora da policia
          if (p.faction !== 'policia') setWanted(id, p.wanted + 1);
        }
        break;
      }

      case 'arrest': {
        if (!p.loggedIn || p.faction !== 'policia') return;
        const target = players[data.targetId];
        if (!target || target.jailed || target.wanted < 1) return;
        arrestPlayer(target.id, 60 + target.wanted * 30);
        break;
      }

      case 'fine': {
        if (!p.loggedIn || p.faction !== 'policia') return;
        const target = players[data.targetId];
        if (!target) return;
        const amount = Math.min(data.amount ?? 500, 5000);
        target.money = Math.max(0, target.money - amount);
        send(target.ws, 'economy_update', { money: target.money, bank: target.bank });
        send(target.ws, 'notification', { msg: `🚔 Multado em $${amount} pela PM.` });
        send(p.ws,      'notification', { msg: `✅ Multa de $${amount} aplicada.` });
        break;
      }

      case 'search': {
        if (!p.loggedIn || p.faction !== 'policia') return;
        const target = players[data.targetId];
        if (!target) return;
        send(p.ws, 'notification', { msg: `🔍 ${target.name}: $${target.money} em mão, procurado: ${target.wanted}★` });
        break;
      }

      case 'deposit': {
        if (!p.loggedIn) return;
        const amt = Math.min(data.amount ?? 0, p.money);
        if (amt <= 0) return;
        p.money -= amt;
        p.bank  += amt;
        send(p.ws, 'economy_update', { money: p.money, bank: p.bank });
        break;
      }

      case 'withdraw': {
        if (!p.loggedIn) return;
        const amt = Math.min(data.amount ?? 0, p.bank);
        if (amt <= 0) return;
        p.bank  -= amt;
        p.money += amt;
        send(p.ws, 'economy_update', { money: p.money, bank: p.bank });
        break;
      }

      case 'pay': {
        if (!p.loggedIn) return;
        const target = players[data.targetId];
        if (!target) return;
        const amt = Math.min(data.amount ?? 0, p.money);
        if (amt <= 0) return;
        p.money      -= amt;
        target.money += amt;
        send(p.ws,      'economy_update', { money: p.money,      bank: p.bank });
        send(target.ws, 'economy_update', { money: target.money, bank: target.bank });
        send(target.ws, 'notification',   { msg: `💰 Recebeu $${amt} de ${p.name}` });
        break;
      }

      case 'enter_zone': {
        if (!p.loggedIn) return;
        // Stub — implemente lógica de territórios aqui
        break;
      }

      case 'leave_zone': break;

      default:
        if (process.env.DEBUG) console.log(`[AV] Unknown packet: ${type}`);
    }
  } catch(err) {
    console.error(`[AV] Dispatch error [${type}]:`, err.message);
  }
}

// ─── World Tick (20 Hz) ───────────────────────────────────
setInterval(() => {
  gameTime += TICK_RATE;
  tickCount++;

  // Troca clima a cada 5 min de jogo
  if (tickCount % (6000) === 0) {
    weatherIdx = (weatherIdx + 1) % WEATHER_CYCLE.length;
    broadcastAll('weather_change', { weather: WEATHER_CYCLE[weatherIdx] });
  }

  const snapshot = Object.values(players)
    .filter(p => p.loggedIn)
    .map(p => ({ id: p.id, name: p.name, faction: p.faction, x: p.x, y: p.y, z: p.z }));

  broadcastAll('world_tick', {
    gameTime,
    weather:  WEATHER_CYCLE[weatherIdx],
    players:  snapshot,
  });
}, TICK_RATE);

// ─── Timer de cadeia (1 Hz) ───────────────────────────────
setInterval(() => {
  for (const p of Object.values(players)) {
    if (!p.jailed || p.jailTime <= 0) continue;   // FIX-S9
    p.jailTime -= 1;
    send(p.ws, 'jail_tick', { remaining: p.jailTime });
    if (p.jailTime <= 0) releasePlayer(p.id);
  }
}, JAIL_CHECK);

// ─── Renda territorial (30s) ──────────────────────────────
setInterval(() => {
  for (const p of Object.values(players)) {        // FIX-S10: só online
    if (!p.loggedIn) continue;
    const income = FACTION_INCOME[p.faction] ?? 100;
    p.money += income;
    send(p.ws, 'economy_update', { money: p.money, bank: p.bank });
    send(p.ws, 'notification', { msg: `💰 +$${income} de renda recebido.` });
  }
}, INCOME_RATE);

// ─── Start ────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🎮 Alta Vista RP — rodando na porta ${PORT}`);
  console.log(`   WebSocket : ws://localhost:${PORT}`);
  console.log(`   Admin     : http://localhost:${PORT}`);
});
