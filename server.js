const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const COINS_FILE = path.join(DATA_DIR, 'coins.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Secret for signed balance tokens. Set COINS_SECRET in Render env for production.
const COINS_SECRET = process.env.COINS_SECRET || 'chupasaken-coins-v1-change-on-render';

function loadCoinStore() {
  try {
    if (fs.existsSync(COINS_FILE)) return JSON.parse(fs.readFileSync(COINS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}
function saveCoinStore(store) {
  // Atomic write — survives crashes better than direct overwrite
  try {
    const tmp = COINS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, COINS_FILE);
  } catch (e) {
    try { fs.writeFileSync(COINS_FILE, JSON.stringify(store, null, 2)); } catch (e2) {
      console.error('coins save', e2);
    }
  }
}
let coinStore = loadCoinStore();

function isValidPlayerId(id) {
  return typeof id === 'string' && /^p_[a-z0-9]{8,48}$/i.test(id);
}

function getCoins(playerId) {
  if (!playerId) return 0;
  return (coinStore[playerId] && coinStore[playerId].coins) || 0;
}

function setCoins(playerId, coins, meta) {
  if (!playerId) return 0;
  const n = Math.max(0, Math.floor(Number(coins) || 0));
  if (!coinStore[playerId]) coinStore[playerId] = { coins: 0 };
  coinStore[playerId].coins = n;
  coinStore[playerId].updatedAt = Date.now();
  if (meta && meta.device) coinStore[playerId].device = String(meta.device).slice(0, 80);
  // IP stored only as metadata log, NEVER as identity key
  if (meta && meta.ip) coinStore[playerId].lastIp = String(meta.ip).slice(0, 64);
  saveCoinStore(coinStore);
  return n;
}

function addCoins(playerId, amount, reason) {
  if (!playerId || !amount) return getCoins(playerId);
  const next = getCoins(playerId) + Math.floor(amount);
  return setCoins(playerId, next);
}

/** Signed token survives Render restarts (ephemeral disk). Cannot forge without SECRET. */
function signBalance(playerId, coins) {
  const body = Buffer.from(JSON.stringify({
    id: playerId,
    c: Math.max(0, Math.floor(coins)),
    v: 1
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', COINS_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyBalanceToken(token, playerId) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', COINS_SECRET).update(body).digest('base64url');
  // timing-safe compare
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch (e) { return null; }
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data || data.id !== playerId) return null;
    if (typeof data.c !== 'number' || data.c < 0 || data.c > 1e9) return null;
    return Math.floor(data.c);
  } catch (e) { return null; }
}

function resolveBalance(playerId, clientToken, meta) {
  const fromDisk = getCoins(playerId);
  const fromToken = verifyBalanceToken(clientToken, playerId);
  // After Render restart disk is empty (0) but valid signed token still has real balance
  const coins = Math.max(fromDisk, fromToken == null ? 0 : fromToken);
  if (coins !== fromDisk) setCoins(playerId, coins, meta);
  return coins;
}

function issueCoinsPayload(playerId, coins) {
  return { coins, token: signBalance(playerId, coins) };
}


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // limit connection spam a bit
  maxHttpBufferSize: 1e5,
  pingTimeout: 20000,
  pingInterval: 10000
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const MAX_PLAYERS = 6;
const ROUND_TIME = 120;
const MAX_ROOMS = 15;              // hard cap — no more spam flood
const CREATE_COOLDOWN_MS = 8000;  // 1 room / 8 sec per socket
const MAX_CREATES_PER_MIN = 3;

// per-socket rate state
const rate = new Map(); // socketId -> { lastCreate, creates, windowStart }

function genId() {
  let id;
  do {
    id = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (rooms[id]);
  return id;
}

function getRate(socketId) {
  if (!rate.has(socketId)) {
    rate.set(socketId, { lastCreate: 0, creates: 0, windowStart: Date.now() });
  }
  return rate.get(socketId);
}

/** Allow only normal letters/numbers/spaces/basic punctuation */
function sanitizeName(str, maxLen) {
  return String(str || '')
    .replace(/[^\w\u0400-\u04FF\s\-_.!?#]/gi, '')
    .trim()
    .slice(0, maxLen);
}

/** Block obvious spam / empty / too short names */
function isBadRoomName(name) {
  if (!name || name.length < 2) return true;
  if (name.length > 30) return true;
  // repeated same char
  if (/(.)\1{6,}/.test(name)) return true;
  // pure numbers / hash spam
  if (/^#?\d+$/.test(name)) return true;
  return false;
}

function publicRoomList() {
  return Object.entries(rooms)
    .filter(([, r]) => !r.started)
    .map(([id, r]) => ({
      id,
      name: r.name,
      hasPassword: !!r.password,
      map: r.map,
      players: Object.keys(r.players).length,
      max: MAX_PLAYERS,
      mode: 'Прятки'
    }));
}

function broadcastRooms() {
  io.emit('roomList', publicRoomList());
}

function joinPlayer(socket, roomId, playerName) {
  const room = rooms[roomId];
  if (!room) return;
  socket.join(roomId);
  socket.roomId = roomId;
  room.players[socket.id] = {
    id: socket.id,
    name: playerName,
    x: 0, y: 0, z: 0,
    hp: 100,
    isKiller: false,
    lastMove: Date.now()
  };
  io.to(roomId).emit('playersUpdate', room.players);
  socket.emit('joinedRoom', {
    id: roomId,
    name: room.name,
    hostId: room.hostId,
    players: room.players,
    map: room.map,
    playerId: socket.id,
    isHost: room.hostId === socket.id
  });
  // also legacy event name for older clients
  socket.emit('joined', {
    id: roomId,
    name: room.name,
    hostId: room.hostId,
    playerId: socket.id,
    isHost: room.hostId === socket.id,
    map: room.map
  });
}

function endGame(id, winner) {
  if (!rooms[id]) return;
  if (rooms[id].ended) return; // once only
  rooms[id].ended = true;
  rooms[id].started = false;
  if (rooms[id].interval) {
    clearInterval(rooms[id].interval);
    rooms[id].interval = null;
  }

  // Victory coins (once per match end)
  const room = rooms[id];
  room.winAwarded = room.winAwarded || {};
  const socketsInRoom = io.sockets.adapter.rooms.get(id) || new Set();
  for (const sid of socketsInRoom) {
    const sock = io.sockets.sockets.get(sid);
    if (!sock || !room.players[sid]) continue;
    const p = room.players[sid];
    if (room.winAwarded[sid]) continue;
    let award = 0;
    if (winner === 'killer' && p.isKiller) award = 30;
    if (winner === 'survivors' && !p.isKiller && p.hp > 0) award = 30;
    // also survivors who died don't get win reward
    if (award > 0 && sock.playerId) {
      room.winAwarded[sid] = true;
      const total = addCoins(sock.playerId, award, 'win');
      sock.emit('coinsAward', Object.assign({ amount: award, reason: 'win', total }, issueCoinsPayload(sock.playerId, total)));
    }
  }

  io.to(id).emit('gameOver', { winner });
  setTimeout(() => broadcastRooms(), 4000);
}

function removePlayer(socket, reason) {
  const id = socket.roomId;
  if (!id || !rooms[id]) return;
  const wasKiller = rooms[id].players[socket.id]?.isKiller;
  delete rooms[id].players[socket.id];
  io.to(id).emit('playerLeft', { id: socket.id, reason: reason || 'left' });

  if (Object.keys(rooms[id].players).length === 0) {
    if (rooms[id].interval) clearInterval(rooms[id].interval);
    delete rooms[id];
  } else {
    if (rooms[id].hostId === socket.id) {
      const newHost = Object.keys(rooms[id].players)[0];
      rooms[id].hostId = newHost;
      io.to(id).emit('hostChanged', newHost);
    }
    io.to(id).emit('playersUpdate', rooms[id].players);

    if (rooms[id].started) {
      if (wasKiller) {
        endGame(id, 'survivors');
      } else {
        const alive = Object.values(rooms[id].players).filter(p => !p.isKiller && p.hp > 0);
        if (alive.length === 0) endGame(id, 'killer');
      }
    }
  }
  broadcastRooms();
}

// cleanup empty/stale rooms every 30s
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, r] of Object.entries(rooms)) {
    const count = Object.keys(r.players).length;
    if (count === 0) {
      if (r.interval) clearInterval(r.interval);
      delete rooms[id];
      changed = true;
      continue;
    }
    // waiting room older than 10 min with 1 player → close
    if (!r.started && count === 1 && r.createdAt && now - r.createdAt > 10 * 60 * 1000) {
      if (r.interval) clearInterval(r.interval);
      io.to(id).emit('errorMsg', 'Комната закрыта по таймауту');
      delete rooms[id];
      changed = true;
    }
  }
  if (changed) broadcastRooms();
}, 30000);

io.on('connection', (socket) => {
  socket.emit('roomList', publicRoomList());

  socket.on('identify', (data) => {
    const playerId = String(data?.playerId || '').slice(0, 64);
    if (!isValidPlayerId(playerId)) return;
    socket.playerId = playerId;
    if (data?.name) socket.playerName = String(data.name).slice(0, 20);

    // Device hint is metadata only — never the account key (friends share IP / same phone model)
    const meta = {
      device: data?.device ? String(data.device).slice(0, 80) : '',
      ip: socket.handshake.address || ''
    };
    const coins = resolveBalance(playerId, data?.token, meta);
    socket.emit('coinsUpdate', issueCoinsPayload(playerId, coins));
  });


  // ===== CREATE ROOM (with anti-spam) =====
  socket.on('createRoom', (data) => {
    // already in a room?
    if (socket.roomId && rooms[socket.roomId]) {
      return socket.emit('errorMsg', 'Сначала выйди из текущей комнаты');
    }

    // global cap
    const openCount = Object.values(rooms).filter(r => !r.started).length;
    if (openCount >= MAX_ROOMS) {
      return socket.emit('errorMsg', 'Слишком много комнат. Попробуй позже');
    }

    // rate limit
    const rs = getRate(socket.id);
    const now = Date.now();
    if (now - rs.windowStart > 60000) {
      rs.windowStart = now;
      rs.creates = 0;
    }
    if (rs.creates >= MAX_CREATES_PER_MIN) {
      return socket.emit('errorMsg', 'Слишком часто создаёшь комнаты. Подожди минуту');
    }
    if (now - rs.lastCreate < CREATE_COOLDOWN_MS) {
      return socket.emit('errorMsg', 'Подожди несколько секунд перед созданием');
    }

    const playerName = sanitizeName(data?.playerName || 'Player', 20) || 'Player';
    let roomName = sanitizeName(data?.roomName || 'Комната', 30) || 'Комната';
    const password = String(data?.password || '').trim().slice(0, 16);
    const map = data?.map === 'map.glb' ? 'map.glb' : 'map.glb';

    if (isBadRoomName(roomName)) {
      return socket.emit('errorMsg', 'Некорректное название комнаты');
    }

    // one open room per name
    const exists = Object.values(rooms).some(
      r => !r.started && r.name.toLowerCase() === roomName.toLowerCase()
    );
    if (exists) return socket.emit('errorMsg', 'Комната с таким названием уже есть');

    // one waiting room per host
    const alreadyHost = Object.values(rooms).some(
      r => !r.started && r.hostId === socket.id
    );
    if (alreadyHost) {
      return socket.emit('errorMsg', 'У тебя уже есть открытая комната');
    }

    rs.lastCreate = now;
    rs.creates += 1;

    const id = genId();
    rooms[id] = {
      name: roomName,
      password,
      map,
      players: {},
      killerId: null,
      started: false,
      timer: ROUND_TIME,
      hostId: socket.id,
      createdAt: now
    };
    joinPlayer(socket, id, playerName);
    socket.emit('roomCreated', { id, name: roomName });
    broadcastRooms();
  });

  // ===== JOIN ROOM =====
  socket.on('joinRoom', (data) => {
    if (socket.roomId && rooms[socket.roomId]) {
      return socket.emit('errorMsg', 'Сначала выйди из текущей комнаты');
    }

    const playerName = sanitizeName(data?.playerName || 'Player', 20) || 'Player';
    let id = String(data?.id || data?.code || '').toUpperCase();
    const password = String(data?.password || '').trim();

    if (!rooms[id] && data?.name) {
      const found = Object.entries(rooms).find(([, r]) =>
        !r.started && r.name.toLowerCase() === String(data.name).toLowerCase()
      );
      if (found) id = found[0];
    }

    if (!rooms[id]) return socket.emit('errorMsg', 'Комната не найдена');
    if (rooms[id].started) return socket.emit('errorMsg', 'Игра уже началась');
    if (Object.keys(rooms[id].players).length >= MAX_PLAYERS) {
      return socket.emit('errorMsg', 'Комната заполнена');
    }
    if (rooms[id].password && rooms[id].password !== password) {
      return socket.emit('errorMsg', 'Неверный пароль');
    }

    joinPlayer(socket, id, playerName);
    broadcastRooms();
  });

  // ===== LEAVE ROOM (lobby) =====
  socket.on('leaveRoom', () => {
    removePlayer(socket, 'leave');
    socket.roomId = null;
  });

  // ===== START GAME =====
  socket.on('startGame', () => {
    const id = socket.roomId;
    if (!id || !rooms[id]) return;
    if (rooms[id].hostId !== socket.id) {
      return socket.emit('errorMsg', 'Только хост может начать');
    }
    const list = Object.values(rooms[id].players);
    if (list.length < 2) {
      return socket.emit('errorMsg', 'Нужно минимум 2 игрока');
    }

    // pick killer
    const killer = list[Math.floor(Math.random() * list.length)];
    rooms[id].killerId = killer.id;
    const startNow = Date.now();
    list.forEach(p => {
      p.isKiller = p.id === killer.id;
      p.hp = 100;
      p.lastMove = startNow; // CRITICAL: reset AFK timer at match start
    });
    rooms[id].started = true;
    rooms[id].timer = ROUND_TIME;
    rooms[id].ended = false;
    rooms[id].killAwarded = {};
    rooms[id].winAwarded = {};
    rooms[id].startedAt = startNow;

    io.to(id).emit('gameStart', {
      players: rooms[id].players,
      killerId: killer.id,
      map: rooms[id].map,
      timer: ROUND_TIME
    });
    broadcastRooms();

    const interval = setInterval(() => {
      if (!rooms[id] || !rooms[id].started) return clearInterval(interval);
      rooms[id].timer--;
      io.to(id).emit('timer', rooms[id].timer);

      const now = Date.now();
      // AFK only after 20s into the match, timeout 45s without moves
      const matchAge = now - (rooms[id].startedAt || now);
      if (matchAge > 20000) {
        Object.values(rooms[id].players).forEach(p => {
          if (!p.lastMove) p.lastMove = now;
          if (now - p.lastMove > 45000 && p.hp > 0) {
            p.hp = 0;
            io.to(id).emit('hit', { id: p.id, hp: 0 });
            io.to(id).emit('playerLeft', { id: p.id, reason: 'afk' });
          }
        });
      }
      const alive = Object.values(rooms[id].players).filter(p => !p.isKiller && p.hp > 0);
      const killerAlive = Object.values(rooms[id].players).some(p => p.isKiller && p.hp > 0);
      if (!killerAlive) {
        clearInterval(interval);
        endGame(id, 'survivors');
        return;
      }
      if (alive.length === 0) {
        clearInterval(interval);
        endGame(id, 'killer');
        return;
      }
      if (rooms[id].timer <= 0) {
        clearInterval(interval);
        endGame(id, 'survivors');
      }
    }, 1000);
    rooms[id].interval = interval;
  });

  // ===== MOVE / ATTACK =====
  socket.on('move', (pos) => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].players[socket.id]) return;
    if (typeof pos?.x !== 'number' || typeof pos?.z !== 'number') return;
    // basic anti-teleport: ignore insane coords
    if (Math.abs(pos.x) > 500 || Math.abs(pos.z) > 500 || Math.abs(pos.y || 0) > 200) return;

    const p = rooms[id].players[socket.id];
    p.x = pos.x;
    p.y = pos.y || 0;
    p.z = pos.z;
    p.lastMove = Date.now();
    socket.to(id).emit('playerMoved', {
      id: socket.id,
      x: pos.x,
      y: pos.y || 0,
      z: pos.z,
      yaw: pos.yaw,
      moving: !!pos.moving
    });
  });

  socket.on('attack', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;

    Object.values(rooms[id].players).forEach(target => {
      if (target.id === socket.id || target.hp <= 0 || target.isKiller) return;
      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 2.2) {
        target.hp = Math.max(0, target.hp - 50);
        io.to(id).emit('hit', { id: target.id, hp: target.hp });
        if (target.hp <= 0) {
          // +10 for kill (once per victim per match)
          rooms[id].killAwarded = rooms[id].killAwarded || {};
          if (!rooms[id].killAwarded[target.id]) {
            rooms[id].killAwarded[target.id] = true;
            const killerPid = socket.playerId;
            if (killerPid) {
              const total = addCoins(killerPid, 10, 'kill');
              socket.emit('coinsAward', Object.assign({ amount: 10, reason: 'kill', total }, issueCoinsPayload(killerPid, total)));
            }
          }
          const alive = Object.values(rooms[id].players).filter(p => !p.isKiller && p.hp > 0);
          if (alive.length === 0) endGame(id, 'killer');
        }
      }
    });
  });


  // ===== VOICE CHAT signaling (WebRTC, media not through Socket.IO) =====
  function voiceRelay(socket, event, data) {
    const id = socket.roomId;
    if (!id || !rooms[id]) return;
    const to = data && data.to;
    if (!to || to === socket.id) return;
    // only relay inside same room
    if (!rooms[id].players[to] && event !== 'voice-ice') {
      // still allow ice if peer briefly missing
    }
    if (!rooms[id].players[socket.id]) return;
    io.to(to).emit(event, Object.assign({}, data, { from: socket.id }));
  }

  socket.on('voice-ready', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].players[socket.id]) return;
    socket.to(id).emit('voice-peer-joined', { id: socket.id });
  });

  socket.on('voice-offer', (data) => voiceRelay(socket, 'voice-offer', data));
  socket.on('voice-answer', (data) => voiceRelay(socket, 'voice-answer', data));
  socket.on('voice-ice', (data) => voiceRelay(socket, 'voice-ice', data));

  socket.on('voice-speaking', (data) => {
    const id = socket.roomId;
    if (!id || !rooms[id]) return;
    socket.to(id).emit('voice-speaking', {
      id: socket.id,
      speaking: !!(data && data.speaking)
    });
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('voice-peer-left', { id: socket.id });
    }
    removePlayer(socket, 'disconnect');
    rate.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('ChupaSaken on port', PORT));
