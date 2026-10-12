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
function getPromos(playerId) {
  if (!playerId) return [];
  const p = (coinStore[playerId] && coinStore[playerId].promos) || [];
  return Array.isArray(p) ? p.slice(0, 50) : [];
}
function signBalance(playerId, coins, owned, promos) {
  // Paid skins only in token (free skins always granted)
  const paid = (owned || []).filter((id) => id && FREE_SKINS.indexOf(id) < 0 && SKIN_CATALOG[id]);
  const pr = (promos || getPromos(playerId) || []).filter((x) => typeof x === 'string').slice(0, 50);
  const body = Buffer.from(JSON.stringify({
    id: playerId,
    c: Math.max(0, Math.floor(coins)),
    o: paid,
    p: pr,
    v: 3
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
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch (e) { return null; }
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data || data.id !== playerId) return null;
    if (typeof data.c !== 'number' || data.c < 0 || data.c > 1e9) return null;
    const owned = Array.isArray(data.o) ? data.o.filter((id) => typeof id === 'string' && SKIN_CATALOG[id]).slice(0, 20) : [];
    const promos = Array.isArray(data.p) ? data.p.filter((x) => typeof x === 'string').slice(0, 50) : [];
    return { coins: Math.floor(data.c), owned, promos };
  } catch (e) { return null; }
}

function resolveBalance(playerId, clientToken, meta) {
  const fromDisk = getCoins(playerId);
  const tok = verifyBalanceToken(clientToken, playerId);
  const fromToken = tok ? tok.coins : null;
  const coins = Math.max(fromDisk, fromToken == null ? 0 : fromToken);
  if (coins !== fromDisk) setCoins(playerId, coins, meta);
  // restore owned skins from token after Render wipe
  if (tok && tok.owned && tok.owned.length) {
    if (!coinStore[playerId]) coinStore[playerId] = { coins: coins };
    if (!coinStore[playerId].owned) coinStore[playerId].owned = [];
    let changed = false;
    for (const id of tok.owned) {
      if (coinStore[playerId].owned.indexOf(id) < 0 && SKIN_CATALOG[id]) {
        coinStore[playerId].owned.push(id);
        changed = true;
      }
    }
    if (changed) saveCoinStore(coinStore);
  }
  // restore used promos from token
  if (tok && tok.promos && tok.promos.length) {
    if (!coinStore[playerId]) coinStore[playerId] = { coins: coins };
    if (!coinStore[playerId].promos) coinStore[playerId].promos = [];
    let changedP = false;
    for (const code of tok.promos) {
      if (coinStore[playerId].promos.indexOf(code) < 0) {
        coinStore[playerId].promos.push(code);
        changedP = true;
      }
    }
    if (changedP) saveCoinStore(coinStore);
  }
  return coins;
}

function issueCoinsPayload(playerId, coins) {
  return { coins, token: signBalance(playerId, coins, getOwned(playerId), getPromos(playerId)) };
}

// Promo catalog (server-only — client never chooses reward)
const PROMO_CODES = {
  chupasaken67: { reward: 9990, id: 'chupasaken67' }
};


// Shop skins (server-authoritative)
const SKIN_CATALOG = {
  chupa36k: { price: 500, role: 'killer', name: 'Chupa36k' }
};
const FREE_SKINS = ['tall_chicken', 'chicken'];

function getOwned(playerId) {
  if (!playerId) return FREE_SKINS.slice();
  const o = (coinStore[playerId] && coinStore[playerId].owned) || [];
  const set = new Set(FREE_SKINS.concat(o));
  return Array.from(set);
}

function ownsSkin(playerId, skinId) {
  return getOwned(playerId).indexOf(skinId) >= 0;
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
    .filter(([, r]) => !r.started && !r.ended)
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
    lastMove: Date.now(),
    killerSkin: (socket.killerSkin && ownsSkin(socket.playerId, socket.killerSkin)) ? socket.killerSkin : 'tall_chicken',
    survivorSkin: (socket.survivorSkin && ownsSkin(socket.playerId, socket.survivorSkin)) ? socket.survivorSkin : 'chicken'
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
  if (rooms[id].ended) return; // once only — protect double win/timer
  rooms[id].ended = true;
  rooms[id].started = false;
  rooms[id].rageUntil = 0;
  rooms[id].tpPending = null;
  rooms[id].projectiles = [];
  rooms[id].burns = {};
  if (rooms[id].interval) {
    clearInterval(rooms[id].interval);
    rooms[id].interval = null;
  }
  io.to(id).emit('rageEnd', {});
  io.to(id).emit('abilitiesClear', {});

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
    if (award > 0 && sock.playerId) {
      room.winAwarded[sid] = true;
      const total = addCoins(sock.playerId, award, 'win');
      sock.emit('coinsAward', Object.assign({ amount: award, reason: 'win', total }, issueCoinsPayload(sock.playerId, total)));
    }
  }

  io.to(id).emit('gameOver', { winner });
  // Hide from room list immediately (ended rooms are not joinable)
  broadcastRooms();

  // After results screen (~5s): detach players and delete finished room
  setTimeout(() => {
    if (!rooms[id]) return;
    if (rooms[id].interval) {
      clearInterval(rooms[id].interval);
      rooms[id].interval = null;
    }
    const sids = Object.keys(rooms[id].players || {});
    for (const sid of sids) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) {
        try { sock.leave(id); } catch (e) {}
        if (sock.roomId === id) sock.roomId = null;
      }
    }
    delete rooms[id];
    broadcastRooms();
  }, 5000);
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
    // finished match still hanging → force delete
    if (r.ended) {
      if (r.interval) clearInterval(r.interval);
      for (const sid of Object.keys(r.players)) {
        const sock = io.sockets.sockets.get(sid);
        if (sock && sock.roomId === id) sock.roomId = null;
      }
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
    // merge client-reported owned is NOT trusted — only server store
    socket.emit('coinsUpdate', Object.assign(issueCoinsPayload(playerId, coins), {
      owned: getOwned(playerId)
    }));
  });

  socket.on('testGrantCoins', () => {
    // Disabled by default — was giving 9990 to every new device.
    // Enable only with Render env: ALLOW_TEST_COINS=1 and optional TEST_COINS_PID=p_xxx
    if (process.env.ALLOW_TEST_COINS !== '1') return;
    const playerId = socket.playerId;
    if (!playerId) return;
    const only = process.env.TEST_COINS_PID;
    if (only && only !== playerId) return;
    const total = setCoins(playerId, 9990);
    socket.emit('coinsUpdate', Object.assign(issueCoinsPayload(playerId, total), {
      owned: getOwned(playerId)
    }));
  });

  
  // in-flight lock per player for promo redeem
  const promoLock = new Set();
  socket.on('redeemPromo', (data) => {
    const playerId = socket.playerId;
    if (!playerId || !isValidPlayerId(playerId)) {
      return socket.emit('promoResult', { ok: false, msg: 'no_id' });
    }
    if (promoLock.has(playerId)) {
      return socket.emit('promoResult', { ok: false, msg: 'busy' });
    }
    let raw = (data && data.code != null) ? String(data.code) : '';
    raw = raw.trim();
    if (!raw) {
      return socket.emit('promoResult', { ok: false, msg: 'invalid' });
    }
    const key = raw.toLowerCase();
    const promo = PROMO_CODES[key];
    if (!promo) {
      return socket.emit('promoResult', { ok: false, msg: 'invalid' });
    }
    promoLock.add(playerId);
    try {
      // ensure balance restored from client token first
      if (data && data.token) {
        resolveBalance(playerId, data.token, { device: socket.deviceHint });
      }
      const used = getPromos(playerId);
      if (used.indexOf(promo.id) >= 0) {
        const total = getCoins(playerId);
        socket.emit('promoResult', Object.assign({
          ok: false, msg: 'already', coins: total
        }, issueCoinsPayload(playerId, total)));
        return;
      }
      if (!coinStore[playerId]) coinStore[playerId] = { coins: 0, owned: [], promos: [] };
      if (!coinStore[playerId].promos) coinStore[playerId].promos = [];
      // mark used BEFORE awarding (atomic-ish against double click)
      coinStore[playerId].promos.push(promo.id);
      saveCoinStore(coinStore);
      const total = addCoins(playerId, promo.reward, 'promo:' + promo.id);
      saveCoinStore(coinStore);
      socket.emit('promoResult', Object.assign({
        ok: true,
        reward: promo.reward,
        code: promo.id,
        coins: total
      }, issueCoinsPayload(playerId, total)));
    } finally {
      promoLock.delete(playerId);
    }
  });

socket.on('buySkin', (data) => {
    const playerId = socket.playerId;
    if (!playerId) return socket.emit('shopError', { msg: 'not_identified' });
    const skinId = String(data?.skinId || '');
    const item = SKIN_CATALOG[skinId];
    if (!item) return socket.emit('shopError', { msg: 'unknown_skin' });
    if (ownsSkin(playerId, skinId)) {
      const total = getCoins(playerId);
      return socket.emit('shopResult', Object.assign({
        ok: true, already: true, skinId, owned: getOwned(playerId)
      }, issueCoinsPayload(playerId, total)));
    }
    const balance = getCoins(playerId);
    if (balance < item.price) {
      return socket.emit('shopError', { msg: 'not_enough', need: item.price, coins: balance });
    }
    // deduct once
    const total = setCoins(playerId, balance - item.price);
    if (!coinStore[playerId].owned) coinStore[playerId].owned = [];
    if (coinStore[playerId].owned.indexOf(skinId) < 0) {
      coinStore[playerId].owned.push(skinId);
      saveCoinStore(coinStore);
    }
    socket.emit('shopResult', Object.assign({
      ok: true,
      skinId,
      owned: getOwned(playerId)
    }, issueCoinsPayload(playerId, total)));
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
    if (rooms[id].ended) return socket.emit('errorMsg', 'Комната уже завершена');
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
  socket.on('setSkin', (data) => {
    const playerId = socket.playerId;
    const skinId = String(data?.skinId || '');
    const role = data?.role === 'survivor' ? 'survivor' : 'killer';
    if (!playerId || !skinId) return;
    if (!ownsSkin(playerId, skinId)) {
      return socket.emit('shopError', { msg: 'not_owned' });
    }
    // validate role match
    if (role === 'killer' && skinId === 'chicken') return;
    if (role === 'survivor' && (skinId === 'tall_chicken' || skinId === 'chupa36k')) return;
    socket.killerSkin = role === 'killer' ? skinId : (socket.killerSkin || 'tall_chicken');
    socket.survivorSkin = role === 'survivor' ? skinId : (socket.survivorSkin || 'chicken');
    if (role === 'killer') socket.killerSkin = skinId;
    if (role === 'survivor') socket.survivorSkin = skinId;
    const id = socket.roomId;
    if (id && rooms[id] && rooms[id].players[socket.id]) {
      if (role === 'killer') rooms[id].players[socket.id].killerSkin = skinId;
      if (role === 'survivor') rooms[id].players[socket.id].survivorSkin = skinId;
    }
    socket.emit('skinSet', { role, skinId });
  });

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
      const sockP = io.sockets.sockets.get(p.id);
      if (sockP) {
        if (p.isKiller) {
          var ks = sockP.killerSkin || p.killerSkin || 'tall_chicken';
          // free skins always ok; paid only if owned
          if (ks === 'tall_chicken' || ownsSkin(sockP.playerId, ks)) p.killerSkin = ks;
          else p.killerSkin = 'tall_chicken';
        } else {
          var ss = sockP.survivorSkin || p.survivorSkin || 'chicken';
          if (ss === 'chicken' || ownsSkin(sockP.playerId, ss)) p.survivorSkin = ss;
          else p.survivorSkin = 'chicken';
        }
      } else {
        if (p.isKiller && !p.killerSkin) p.killerSkin = 'tall_chicken';
        if (!p.isKiller && !p.survivorSkin) p.survivorSkin = 'chicken';
      }
      p.hp = 100;
      p.lastMove = startNow; // CRITICAL: reset AFK timer at match start
    });
    rooms[id].started = true;
    rooms[id].timer = ROUND_TIME;
    rooms[id].ended = false;
    rooms[id].killAwarded = {};
    rooms[id].winAwarded = {};
    rooms[id].startedAt = startNow;
    rooms[id].rageUntil = 0;
    rooms[id].rageCd = 0;
    rooms[id].ringCd = 0;
    rooms[id].tpCd = 0;
    rooms[id].tpPending = null;
    rooms[id].projectiles = [];
    rooms[id].burns = {};
    rooms[id].atkCd = {};

    const killerPlayer = rooms[id].players[killer.id];
    const killerSkinOut = (killerPlayer && killerPlayer.killerSkin) ? killerPlayer.killerSkin : 'tall_chicken';
    rooms[id].killerSkin = killerSkinOut;
    io.to(id).emit('gameStart', {
      players: rooms[id].players,
      killerId: killer.id,
      killerSkin: killerSkinOut,
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
      // --- Rage end ---
      if (rooms[id].rageUntil && Date.now() >= rooms[id].rageUntil) {
        rooms[id].rageUntil = 0;
        io.to(id).emit('rageEnd', {});
      }

      // --- Teleport finish: ask owner client to pick safe ground near nearest survivor ---
      if (rooms[id].tpPending && Date.now() >= rooms[id].tpPending.finishAt) {
        const tp = rooms[id].tpPending;
        // keep pending until confirm/timeout so client can reply
        if (!tp.resolving) {
          const killer = rooms[id].players[tp.ownerId];
          if (killer && killer.isKiller && killer.hp > 0 && rooms[id].started && !rooms[id].ended) {
            const survivors = Object.values(rooms[id].players).filter(p => !p.isKiller && p.hp > 0);
            if (!survivors.length) {
              rooms[id].tpPending = null;
              io.to(id).emit('teleportFail', { ownerId: tp.ownerId, reason: 'no_target' });
            } else {
              survivors.sort((a, b) => {
                const da = (a.x - killer.x) ** 2 + (a.z - killer.z) ** 2;
                const db = (b.x - killer.x) ** 2 + (b.z - killer.z) ** 2;
                return da - db;
              });
              const t = survivors[0];
              const candidates = [];
              for (let i = 0; i < 12; i++) {
                const ang = (i / 12) * Math.PI * 2;
                for (const rad of [2.4, 3.2, 4.0]) {
                  candidates.push({
                    x: t.x + Math.cos(ang) * rad,
                    y: t.y || 0,
                    z: t.z + Math.sin(ang) * rad
                  });
                }
              }
              tp.resolving = true;
              tp.targetId = t.id;
              tp.resolveDeadline = Date.now() + 1500;
              const ownerSock = io.sockets.sockets.get(tp.ownerId);
              if (ownerSock) {
                ownerSock.emit('teleportResolve', {
                  ownerId: tp.ownerId,
                  targetId: t.id,
                  candidates
                });
              } else {
                rooms[id].tpPending = null;
                io.to(id).emit('teleportFail', { ownerId: tp.ownerId, reason: 'cancelled' });
              }
            }
          } else {
            rooms[id].tpPending = null;
            io.to(id).emit('teleportFail', { ownerId: tp.ownerId, reason: 'cancelled' });
          }
        } else if (tp.resolveDeadline && Date.now() > tp.resolveDeadline) {
          rooms[id].tpPending = null;
          io.to(id).emit('teleportFail', { ownerId: tp.ownerId, reason: 'no_safe' });
        }
      }

      // --- Projectiles (sub-steps so flight is smooth; never hit owner) ---
      if (rooms[id].projectiles && rooms[id].projectiles.length) {
        const steps = 10;
        const dt = 1.0 / steps;
        const left = [];
        const nowP = Date.now();
        for (const proj of rooms[id].projectiles) {
          let dead = false;
          for (let s = 0; s < steps && !dead; s++) {
            proj.life -= dt;
            if (proj.life <= 0) {
              io.to(id).emit('projectileDespawn', { id: proj.id });
              dead = true;
              break;
            }
            if (proj.kind === 'homing') {
              let tgt = proj.targetId ? rooms[id].players[proj.targetId] : null;
              if (!tgt || tgt.hp <= 0 || tgt.isKiller) {
                const survivors = Object.values(rooms[id].players).filter(p => !p.isKiller && p.hp > 0);
                if (!survivors.length) {
                  io.to(id).emit('projectileDespawn', { id: proj.id });
                  dead = true;
                  break;
                }
                survivors.sort((a, b) => {
                  const da = (a.x - proj.x) ** 2 + (a.z - proj.z) ** 2;
                  const db = (b.x - proj.x) ** 2 + (b.z - proj.z) ** 2;
                  return da - db;
                });
                tgt = survivors[0];
                proj.targetId = tgt.id;
              }
              const dx = tgt.x - proj.x, dz = tgt.z - proj.z;
              const len = Math.sqrt(dx * dx + dz * dz) || 1;
              const speed = 22;
              proj.vx = (dx / len) * speed;
              proj.vz = (dz / len) * speed;
            }
            proj.x += proj.vx * dt;
            proj.z += proj.vz * dt;
            if (Math.abs(proj.x) > 90 || Math.abs(proj.z) > 90) {
              io.to(id).emit('projectileDespawn', { id: proj.id });
              dead = true;
              break;
            }
            // skip collisions during grace / never hit owner
            if (nowP < (proj.graceUntil || 0)) continue;
            for (const target of Object.values(rooms[id].players)) {
              if (!target || target.hp <= 0) continue;
              if (target.id === proj.ownerId) continue; // never collide with thrower
              if (target.isKiller) continue;
              const ddx = target.x - proj.x, ddz = target.z - proj.z;
              if (ddx * ddx + ddz * ddz < 1.4 * 1.4) {
                const ownerSock = io.sockets.sockets.get(proj.ownerId);
                applyDamage(id, ownerSock, target, 40);
                if (proj.kind === 'fire' && target.hp > 0) {
                  rooms[id].burns = rooms[id].burns || {};
                  rooms[id].burns[target.id] = { until: Date.now() + 5000, next: Date.now() + 1000, ownerId: proj.ownerId };
                  io.to(id).emit('burnStart', { id: target.id, until: rooms[id].burns[target.id].until });
                }
                io.to(id).emit('projectileDespawn', { id: proj.id, hitId: target.id });
                dead = true;
                break;
              }
            }
          }
          if (!dead) {
            left.push(proj);
            io.to(id).emit('projectileMove', { id: proj.id, x: proj.x, y: proj.y, z: proj.z, vx: proj.vx, vz: proj.vz, targetId: proj.targetId || null });
          }
        }
        rooms[id].projectiles = left;
      }

      // --- Burns DoT ---
      if (rooms[id].burns) {
        const nowB = Date.now();
        for (const [tid, b] of Object.entries(rooms[id].burns)) {
          const target = rooms[id].players[tid];
          if (!target || target.hp <= 0 || nowB >= b.until) {
            delete rooms[id].burns[tid];
            io.to(id).emit('burnEnd', { id: tid });
            continue;
          }
          if (nowB >= b.next) {
            b.next = nowB + 1000;
            const ownerSock = io.sockets.sockets.get(b.ownerId);
            applyDamage(id, ownerSock, target, 5);
            if (target.hp <= 0) {
              delete rooms[id].burns[tid];
              io.to(id).emit('burnEnd', { id: tid });
            }
          }
        }
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


  // ===== ABILITIES (server-authoritative) =====
  function killerSkinOf(room) {
    const k = Object.values(room.players).find(p => p.isKiller);
    return (k && k.killerSkin) || room.killerSkin || 'tall_chicken';
  }
  function isRaging(room) {
    return !!(room.rageUntil && Date.now() < room.rageUntil);
  }
  function attackParams(room) {
    const skin = killerSkinOf(room);
    if (skin === 'chupa36k') return { dmg: 35, cd: 1000, range: 2.4 };
    if (isRaging(room)) return { dmg: 50, cd: 1000, range: 2.4 };
    return { dmg: 10, cd: 500, range: 2.2 };
  }
  function applyDamage(roomId, attackerSock, target, dmg) {
    if (!rooms[roomId] || !target || target.hp <= 0 || target.isKiller) return false;
    target.hp = Math.max(0, target.hp - dmg);
    io.to(roomId).emit('hit', { id: target.id, hp: target.hp });
    if (target.hp <= 0) {
      rooms[roomId].killAwarded = rooms[roomId].killAwarded || {};
      if (!rooms[roomId].killAwarded[target.id] && attackerSock && attackerSock.playerId) {
        rooms[roomId].killAwarded[target.id] = true;
        const total = addCoins(attackerSock.playerId, 10, 'kill');
        attackerSock.emit('coinsAward', Object.assign({ amount: 10, reason: 'kill', total }, issueCoinsPayload(attackerSock.playerId, total)));
      }
      const alive = Object.values(rooms[roomId].players).filter(p => !p.isKiller && p.hp > 0);
      if (alive.length === 0) endGame(roomId, 'killer');
    }
    return true;
  }

  socket.on('attack', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    const now = Date.now();
    rooms[id].atkCd = rooms[id].atkCd || {};
    const params = attackParams(rooms[id]);
    if (rooms[id].atkCd[socket.id] && now < rooms[id].atkCd[socket.id]) return;
    rooms[id].atkCd[socket.id] = now + params.cd;
    socket.emit('abilityCd', { id: 'attack', until: rooms[id].atkCd[socket.id], cd: params.cd });

    Object.values(rooms[id].players).forEach(target => {
      if (target.id === socket.id || target.hp <= 0 || target.isKiller) return;
      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < params.range) applyDamage(id, socket, target, params.dmg);
    });
  });

  // Tall Chicken Rage
  socket.on('abilityRage', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    if (killerSkinOf(rooms[id]) !== 'tall_chicken') return;
    const now = Date.now();
    if (isRaging(rooms[id])) return;
    if (rooms[id].rageCd && now < rooms[id].rageCd) return;
    rooms[id].rageCd = now + 60000; // 60s CD after activate
    rooms[id].rageUntil = now + 30000;
    rooms[id].rageOwner = socket.id;
    io.to(id).emit('rageStart', {
      until: rooms[id].rageUntil,
      duration: 30000,
      speedMult: 1 / 1.5,
      ownerId: socket.id
    });
    socket.emit('abilityCd', { id: 'rage', until: rooms[id].rageCd, cd: 60000 });
  });

  // Chupa throw ring
  socket.on('abilityRing', (data) => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    if (killerSkinOf(rooms[id]) !== 'chupa36k') return;
    const now = Date.now();
    if (rooms[id].ringCd && now < rooms[id].ringCd) return;
    rooms[id].ringCd = now + 30000;
    socket.emit('abilityCd', { id: 'ring', until: rooms[id].ringCd, cd: 30000 });

    // Weighted: 70 normal, 50 fire, 30 homing (sum 150)
    const roll = Math.random() * 150;
    let kind = 'normal';
    if (roll < 70) kind = 'normal';
    else if (roll < 120) kind = 'fire';
    else kind = 'homing';

    let yaw = typeof data?.yaw === 'number' ? data.yaw : 0;
    const speed = 28;
    const dirX = -Math.sin(yaw);
    const dirZ = -Math.cos(yaw);
    // Spawn well in front of killer so it never starts inside the owner hitbox
    const spawnDist = 3.5;
    const proj = {
      id: 'p_' + Math.random().toString(36).slice(2, 9),
      kind,
      ownerId: socket.id,
      x: attacker.x + dirX * spawnDist,
      y: (attacker.y || 0) + 1.1,
      z: attacker.z + dirZ * spawnDist,
      vx: dirX * speed,
      vz: dirZ * speed,
      life: kind === 'homing' ? 8 : 5,
      born: now,
      graceUntil: now + 250 // no collisions for first 250ms
    };
    if (kind === 'homing') {
      const survivors = Object.values(rooms[id].players).filter(p => !p.isKiller && p.hp > 0);
      if (survivors.length) {
        survivors.sort((a, b) => {
          const da = (a.x - attacker.x) ** 2 + (a.z - attacker.z) ** 2;
          const db = (b.x - attacker.x) ** 2 + (b.z - attacker.z) ** 2;
          return da - db;
        });
        proj.targetId = survivors[0].id;
      }
    }
    rooms[id].projectiles = rooms[id].projectiles || [];
    rooms[id].projectiles.push(proj);
    io.to(id).emit('projectileSpawn', {
      id: proj.id, kind: proj.kind, x: proj.x, y: proj.y, z: proj.z,
      vx: proj.vx, vz: proj.vz, targetId: proj.targetId || null
    });
  });

  // Chupa teleport

  socket.on('teleportConfirm', (data) => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].tpPending) return;
    const tp = rooms[id].tpPending;
    if (tp.ownerId !== socket.id) return;
    if (!data || typeof data.x !== 'number' || typeof data.z !== 'number' || !isFinite(data.x) || !isFinite(data.z)) {
      rooms[id].tpPending = null;
      return io.to(id).emit('teleportFail', { ownerId: socket.id, reason: 'no_safe' });
    }
    const killer = rooms[id].players[socket.id];
    const target = tp.targetId ? rooms[id].players[tp.targetId] : null;
    if (!killer || !killer.isKiller || killer.hp <= 0) {
      rooms[id].tpPending = null;
      return io.to(id).emit('teleportFail', { ownerId: socket.id, reason: 'cancelled' });
    }
    // must be reasonably near the target
    if (target) {
      const dx = data.x - target.x, dz = data.z - target.z;
      if (dx * dx + dz * dz > 6.5 * 6.5) {
        rooms[id].tpPending = null;
        return io.to(id).emit('teleportFail', { ownerId: socket.id, reason: 'no_safe' });
      }
    }
    killer.x = Math.max(-80, Math.min(80, data.x));
    killer.z = Math.max(-80, Math.min(80, data.z));
    killer.y = typeof data.y === 'number' ? data.y : (target ? (target.y || 0) : 0);
    rooms[id].tpPending = null;
    io.to(id).emit('teleportDone', {
      ownerId: socket.id,
      x: killer.x, y: killer.y, z: killer.z,
      targetId: tp.targetId || null
    });
  });

  socket.on('abilityTeleport', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    if (killerSkinOf(rooms[id]) !== 'chupa36k') return;
    const now = Date.now();
    if (rooms[id].tpCd && now < rooms[id].tpCd) return;
    if (rooms[id].tpPending) return;
    rooms[id].tpCd = now + 30000;
    socket.emit('abilityCd', { id: 'teleport', until: rooms[id].tpCd, cd: 30000 });
    rooms[id].tpPending = {
      ownerId: socket.id,
      fromX: attacker.x,
      fromY: attacker.y || 0,
      fromZ: attacker.z,
      finishAt: now + 2000
    };
    io.to(id).emit('teleportStart', {
      ownerId: socket.id,
      x: attacker.x, y: attacker.y || 0, z: attacker.z,
      finishAt: rooms[id].tpPending.finishAt
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
    // Existing peers in room — joiner must know them or nobody sends an offer
    const others = Object.keys(rooms[id].players).filter((pid) => pid !== socket.id);
    socket.emit('voice-peers', { ids: others });
    // Existing clients learn about the new peer
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
