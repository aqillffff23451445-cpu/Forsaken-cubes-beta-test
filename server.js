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

// ===== ACHIEVEMENTS =====
const DEVELOPER_IDS = (process.env.DEVELOPER_IDS || 'p_5l8zkhsfk89mv1d0gxr').split(',').map(s => s.trim()).filter(Boolean);

const ACHIEVEMENT_DEFS = {
  first_ten: { id: 'first_ten', target: 10, field: 'kills' },
  survivor: { id: 'survivor', target: 1, field: 'survWins' },
  elusive: { id: 'elusive', target: 3, field: 'survStreakMax' },
  killer_win: { id: 'killer_win', target: 1, field: 'killerWins' },
  exterminator: { id: 'exterminator', target: 10, field: 'kills' },
  unscathed: { id: 'unscathed', target: 1, field: 'unscathedWins' },
  lightning: { id: 'lightning', target: 1, field: 'lightningWins' },
  gemini_revenge: { id: 'gemini_revenge', target: 1, field: 'minionHits' },
  collector: { id: 'collector', target: 1, field: 'collector' },
  creator: { id: 'creator', target: 1, field: 'creator' }
};

function ensureAch(playerId) {
  if (!playerId) return null;
  if (!coinStore[playerId]) coinStore[playerId] = { coins: 0, owned: [], promos: [] };
  if (!coinStore[playerId].stats) {
    coinStore[playerId].stats = {
      kills: 0, survWins: 0, survStreak: 0, survStreakMax: 0,
      killerWins: 0, unscathedWins: 0, lightningWins: 0, minionHits: 0, collector: 0, creator: 0
    };
  }
  if (!coinStore[playerId].achievements) coinStore[playerId].achievements = {};
  return coinStore[playerId];
}

function getAchState(playerId) {
  const rec = ensureAch(playerId);
  if (!rec) return { stats: {}, unlocked: {} };
  return {
    stats: Object.assign({}, rec.stats),
    unlocked: Object.assign({}, rec.achievements)
  };
}

function checkAndUnlock(playerId, sock) {
  const rec = ensureAch(playerId);
  if (!rec) return [];
  const s = rec.stats;
  const newly = [];
  function tryUnlock(id, progress, target) {
    if (rec.achievements[id] && rec.achievements[id].unlocked) return;
    const done = progress >= target;
    rec.achievements[id] = {
      progress: Math.min(progress, target),
      target,
      unlocked: done,
      unlockedAt: done ? Date.now() : (rec.achievements[id] && rec.achievements[id].unlockedAt) || 0
    };
    if (done) newly.push(id);
  }
  tryUnlock('first_ten', s.kills || 0, 10);
  tryUnlock('survivor', s.survWins || 0, 1);
  tryUnlock('elusive', s.survStreakMax || 0, 3);
  tryUnlock('killer_win', s.killerWins || 0, 1);
  tryUnlock('exterminator', s.kills || 0, 10);
  tryUnlock('unscathed', s.unscathedWins || 0, 1);
  tryUnlock('lightning', s.lightningWins || 0, 1);
  tryUnlock('gemini_revenge', s.minionHits || 0, 1);
  tryUnlock('collector', s.collector || 0, 1);
  // Creator only for developer IDs
  if (DEVELOPER_IDS.indexOf(playerId) >= 0) {
    s.creator = 1;
    tryUnlock('creator', 1, 1);
  }
  if (newly.length) {
    saveCoinStore(coinStore);
    if (sock) {
      sock.emit('achievementsUpdate', {
        stats: s,
        unlocked: rec.achievements,
        newly
      });
    }
  }
  return newly;
}

function bumpStat(playerId, field, amount, sock) {
  const rec = ensureAch(playerId);
  if (!rec) return;
  rec.stats[field] = (rec.stats[field] || 0) + (amount || 1);
  saveCoinStore(coinStore);
  checkAndUnlock(playerId, sock);
}

function setStatMax(playerId, field, value, sock) {
  const rec = ensureAch(playerId);
  if (!rec) return;
  rec.stats[field] = Math.max(rec.stats[field] || 0, value);
  saveCoinStore(coinStore);
  checkAndUnlock(playerId, sock);
}

function emitAchievements(sock) {
  if (!sock || !sock.playerId) return;
  const st = getAchState(sock.playerId);
  // auto-grant creator for developers on identify
  if (DEVELOPER_IDS.indexOf(sock.playerId) >= 0) {
    ensureAch(sock.playerId).stats.creator = 1;
    checkAndUnlock(sock.playerId, null);
  }
  // collector check
  const owned = getOwned(sock.playerId);
  const paidKillers = Object.keys(SKIN_CATALOG).filter(id => SKIN_CATALOG[id].role === 'killer' && !SKIN_CATALOG[id].trap && SKIN_CATALOG[id].price > 0);
  const freeKillers = Object.keys(SKIN_CATALOG).filter(id => SKIN_CATALOG[id].role === 'killer' && !SKIN_CATALOG[id].trap && (SKIN_CATALOG[id].price || 0) === 0);
  const allKillers = paidKillers.concat(freeKillers);
  const hasAll = allKillers.every(id => owned.indexOf(id) >= 0 || (SKIN_CATALOG[id].price || 0) === 0);
  // free are always "owned"; paid must be in owned
  const paidOk = paidKillers.every(id => owned.indexOf(id) >= 0);
  if (paidOk) {
    ensureAch(sock.playerId).stats.collector = 1;
    checkAndUnlock(sock.playerId, null);
  }
  const st2 = getAchState(sock.playerId);
  sock.emit('achievementsUpdate', { stats: st2.stats, unlocked: st2.unlocked, newly: [] });
}


// ===== Honeypot / ban list =====
const FLAGGED_FILE = path.join(DATA_DIR, 'flagged.json');
function loadFlagged() {
  try {
    if (fs.existsSync(FLAGGED_FILE)) return JSON.parse(fs.readFileSync(FLAGGED_FILE, 'utf8'));
  } catch (e) {}
  return { traps: [], banned: {} };
}
function saveFlagged(data) {
  try {
    const tmp = FLAGGED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FLAGGED_FILE);
  } catch (e) { console.error('flagged save', e); }
}
let flaggedStore = loadFlagged();

function isBanned(playerId) {
  return !!(playerId && flaggedStore.banned && flaggedStore.banned[playerId]);
}
function banPlayer(playerId, reason) {
  if (!playerId) return;
  if (!flaggedStore.banned) flaggedStore.banned = {};
  flaggedStore.banned[playerId] = { reason: reason || 'trap', at: Date.now() };
  saveFlagged(flaggedStore);
}
function recordTrap(entry) {
  if (!flaggedStore.traps) flaggedStore.traps = [];
  flaggedStore.traps.push(entry);
  if (flaggedStore.traps.length > 500) flaggedStore.traps = flaggedStore.traps.slice(-400);
  saveFlagged(flaggedStore);
}

/** Notify admin: webhook and/or log. Set TRAP_WEBHOOK_URL (Discord/email bridge) and/or TRAP_EMAIL. */
function notifyTrap(playerId, meta) {
  const payload = {
    type: 'honeypot',
    playerId,
    code: 'SecretKiller187',
    skin: 'gemini',
    at: new Date().toISOString(),
    ip: (meta && meta.ip) || null,
    device: (meta && meta.device) || null
  };
  console.warn('[HONEYPOT]', JSON.stringify(payload));
  recordTrap(payload);
  banPlayer(playerId, 'honeypot_SecretKiller187');

  const trapEmail = process.env.TRAP_EMAIL || 'cuncin473@gmail.com';
  const textBody =
    'ChupaSaken HONEYPOT / AUTO-BAN\n\n' +
    'Player ID: ' + playerId + '\n' +
    'Promo: SecretKiller187\n' +
    'IP: ' + (payload.ip || '?') + '\n' +
    'Device: ' + (payload.device || '?') + '\n' +
    'Time: ' + payload.at + '\n';

  try {
    fs.appendFileSync(
      path.join(DATA_DIR, 'trap_mail_queue.txt'),
      'TO:' + trapEmail + '\n' + textBody + '\n---\n'
    );
  } catch (e) {}

  // --- Email attempt 1: FormSubmit AJAX ---
  function postFormSubmit() {
    if (typeof fetch !== 'function') return Promise.resolve();
    return fetch('https://formsubmit.co/ajax/' + encodeURIComponent(trapEmail), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        _subject: 'ChupaSaken: cheater caught (honeypot)',
        _template: 'table',
        _captcha: 'false',
        _honey: '',
        name: 'ChupaSaken Server',
        email: 'noreply@chupasaken.local',
        playerId: String(playerId),
        code: 'SecretKiller187',
        ip: String(payload.ip || '?'),
        device: String(payload.device || '?'),
        time: payload.at,
        status: 'AUTO-BANNED',
        message: textBody
      })
    }).then(function (res) {
      console.warn('[HONEYPOT] formsubmit status', res.status);
      return res.text().then(function (t) {
        console.warn('[HONEYPOT] formsubmit body', String(t).slice(0, 300));
      });
    }).catch(function (e) {
      console.error('[HONEYPOT] formsubmit error', e && e.message);
    });
  }

  // --- Email attempt 2: Formspree-style plain POST (if FORMSUBMIT fails, still try) ---
  function postMailtoBackup() {
    // Uses same FormSubmit non-ajax endpoint
    if (typeof fetch !== 'function') return Promise.resolve();
    const body = new URLSearchParams();
    body.set('_subject', 'ChupaSaken: cheater caught (honeypot)');
    body.set('_captcha', 'false');
    body.set('message', textBody);
    body.set('playerId', String(playerId));
    return fetch('https://formsubmit.co/' + encodeURIComponent(trapEmail), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString()
    }).then(function (res) {
      console.warn('[HONEYPOT] formsubmit2 status', res.status);
    }).catch(function (e) {
      console.error('[HONEYPOT] formsubmit2 error', e && e.message);
    });
  }

  postFormSubmit().then(postMailtoBackup);

  // --- Discord / Telegram webhook (MOST RELIABLE) ---
  const webhook = process.env.TRAP_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '';
  if (webhook) {
    try {
      const isDiscord = /discord\.com\/api\/webhooks/i.test(webhook);
      const body = isDiscord
        ? JSON.stringify({
            content: '🚨 **ChupaSaken honeypot + AUTO-BAN**\n' +
              '**ID:** `' + playerId + '`\n' +
              '**IP:** ' + (payload.ip || '?') + '\n' +
              '**Time:** ' + payload.at
          })
        : JSON.stringify(payload);
      fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).then(function (res) {
        console.warn('[HONEYPOT] webhook status', res.status);
      }).catch(function (e) {
        console.error('[HONEYPOT] webhook error', e && e.message);
      });
    } catch (e) {
      console.error('[HONEYPOT] webhook', e);
    }
  } else {
    console.warn('[HONEYPOT] No TRAP_WEBHOOK_URL set — email may be delayed/spam. Set Discord webhook for instant alerts.');
  }
}



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
  chupasaken67: { reward: 9990, id: 'chupasaken67' },
  // HONEYPOT — looks like secret killer, grants trap skin "gemini" → in-game is a fan
  secretkiller187: { reward: 0, id: 'secretkiller187', trap: true, grantSkin: 'gemini' }
};


// Shop skins (server-authoritative)
const SKIN_CATALOG = {
  chupa36k: { price: 500, role: 'killer', name: 'Chupa36k' },
  prototip: { price: 0, role: 'killer', name: 'Prototip' },
  // Trap skin (honeypot promo) — desk fan
  gemini: { price: 0, role: 'killer', name: 'Gemini', trap: true },
  // Real paid killer
  gemini_killer: { price: 3500, role: 'killer', name: 'Gemini Killer' }
};
const FREE_SKINS = ['tall_chicken', 'chicken', 'prototip'];

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

// Test honeypot notify: GET /api/test-trap-notify?key=ADMIN_KEY
app.get('/api/test-trap-notify', (req, res) => {
  const key = process.env.ADMIN_KEY || '';
  if (!key || req.query.key !== key) {
    return res.status(403).json({ ok: false, msg: 'forbidden — set ADMIN_KEY and pass ?key=' });
  }
  const fakeId = 'p_test' + Date.now().toString(36);
  notifyTrap(fakeId, { ip: req.ip || 'test', device: 'test-endpoint' });
  // unban test id so we don't pollute forever
  try {
    if (flaggedStore.banned) delete flaggedStore.banned[fakeId];
    saveFlagged(flaggedStore);
  } catch (e) {}
  res.json({ ok: true, msg: 'notifyTrap fired', playerId: fakeId, email: process.env.TRAP_EMAIL || 'cuncin473@gmail.com' });
});



const rooms = {};
const MAX_PLAYERS = 6;
const ROUND_TIME = 120;
// Intro ends only when clients report video "ended" (no fixed duration cut-off)

const MAX_ROOMS = 15;              // hard cap — no more spam flood
const CREATE_COOLDOWN_MS = 8000;  // 1 room / 8 sec per socket
const MAX_CREATES_PER_MIN = 3;

// ===== SERVER ANTI-CHEAT (authoritative) =====
const AC_MAP_HALF = 120;
const AC_MOVE_SLACK = 4;
const AC_RANGE_SLACK = 0.55;
const AC_MAX_STRIKES = 25;
const AC_KICK_STRIKES = 80;

function acMaxSpeed(room, player) {
  if (!player) return 45;
  let base = 50;
  if (player.isKiller) {
    if (room && room.rageUntil && Date.now() < room.rageUntil) base = 42;
    else base = 62;
  }
  // sprint 1.5x with small slack for lag
  if (player.sprinting) base *= 1.55;
  return base;
}
function acDist2(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}
function acClampPos(p) {
  if (!p) return;
  if (!isFinite(p.x)) p.x = 0;
  if (!isFinite(p.y)) p.y = 0;
  if (!isFinite(p.z)) p.z = 0;
  p.x = Math.max(-AC_MAP_HALF, Math.min(AC_MAP_HALF, p.x));
  p.z = Math.max(-AC_MAP_HALF, Math.min(AC_MAP_HALF, p.z));
  p.y = Math.max(-5, Math.min(80, p.y));
}
function acStrike(player, n) {
  if (!player) return 0;
  player.cheatStrikes = (player.cheatStrikes || 0) + (n || 1);
  return player.cheatStrikes;
}

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

/** Normalize text for insult / brand checks */
function normalizeToxic(s) {
  if (!s) return '';
  let t = String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // lookalike map
  const map = {
    'а':'a','е':'e','ё':'e','о':'o','р':'p','с':'c','у':'y','х':'x','к':'k','м':'m','н':'h','і':'i','ї':'i',
    '0':'o','1':'i','3':'e','4':'a','5':'s','6':'b','7':'t','8':'b','@':'a','$':'s'
  };
  t = t.split('').map(ch => map[ch] || ch).join('');
  // strip separators between letters
  t = t.replace(/[^a-z0-9\u0400-\u04ff]+/gi, '');
  // collapse repeats
  t = t.replace(/(.)\1{2,}/g, '$1$1');
  return t;
}

const TOXIC_STEMS = [
  'pidor','pidoras','пидор','пидорас','dalbaeb','долбаеб','dolbaeb','daun','даун',
  'nahui','нахуй','naxyi','cyka','сука','сучка','blyat','блять','бля','tvar','тварь',
  'debil','дебил','idiot','идиот','tupoi','тупой','лох','lox','chmo','чмо','мраз','mraz',
  'ебан','eban','fuck','fack','shit','whore','slut','nigga','nigger','faggot','retard',
  'хуй','huy','xyi','пизд','pizd','ебл','ebl','гандон','gandon','мудак','mudak',
  'сволоч','тварю','урод','уродина','гнида','parasha','параша'
];

function containsToxic(raw) {
  const n = normalizeToxic(raw);
  if (!n || n.length < 3) return false;
  for (const stem of TOXIC_STEMS) {
    const sn = normalizeToxic(stem);
    if (sn.length >= 3 && n.indexOf(sn) >= 0) return true;
  }
  return false;
}

function containsChupaBrand(raw) {
  const n = normalizeToxic(raw);
  return /chupa|chup|чупа|чуп/.test(n);
}

/** Block spam / toxic / brand-stolen room names */
function isBadRoomName(name) {
  if (!name || name.length < 2) return true;
  if (name.length > 30) return true;
  if (/(.)\1{6,}/.test(name)) return true;
  if (/^#?\d+$/.test(name)) return true;
  if (containsToxic(name)) return true;
  if (containsChupaBrand(name)) return true;
  return false;
}

function isBadPassword(pw) {
  if (!pw) return false;
  if (containsToxic(pw)) return true;
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
  rooms[id].rageUsed = false;
  if (rooms[id].projInterval) { try { clearInterval(rooms[id].projInterval); } catch (e) {} rooms[id].projInterval = null; }
  rooms[id].projectiles = [];
  rooms[id].tpPending = null;
  rooms[id].projectiles = [];
  rooms[id].burns = {};
  if (rooms[id].interval) {
    clearInterval(rooms[id].interval);
    rooms[id].interval = null;
  }
  io.to(id).emit('rageEnd', {});
  io.to(id).emit('abilitiesClear', {});

  // Victory coins (once per match end) + achievements
  const room = rooms[id];
  room.winAwarded = room.winAwarded || {};
  const socketsInRoom = io.sockets.adapter.rooms.get(id) || new Set();
  const matchAgeMs = room.startedAt ? (Date.now() - room.startedAt) : 999999;
  const lightningOk = winner === 'killer' && matchAgeMs <= 60000;
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
    // Achievements (only for players still in room at end — left early = no win ach)
    if (sock.playerId) {
      const rec = ensureAch(sock.playerId);
      if (winner === 'killer' && p.isKiller) {
        bumpStat(sock.playerId, 'killerWins', 1, sock);
        // streak reset for survivor role when playing as killer doesn't affect surv streak
        if (lightningOk) bumpStat(sock.playerId, 'lightningWins', 1, sock);
      }
      if (winner === 'survivors' && !p.isKiller && p.hp > 0) {
        bumpStat(sock.playerId, 'survWins', 1, sock);
        rec.stats.survStreak = (rec.stats.survStreak || 0) + 1;
        setStatMax(sock.playerId, 'survStreakMax', rec.stats.survStreak, sock);
        if (!p.tookDamage) bumpStat(sock.playerId, 'unscathedWins', 1, sock);
      }
      if (winner === 'killer' && !p.isKiller) {
        // lost as survivor — reset streak
        rec.stats.survStreak = 0;
        saveCoinStore(coinStore);
      }
      if (winner === 'survivors' && p.isKiller) {
        // killer lost — no streak change for survivor
      }
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


  socket.on('adminBan', (data) => {
    const key = process.env.ADMIN_KEY || '';
    if (!key || !data || data.key !== key) return;
    const pid = String(data.playerId || '');
    if (!isValidPlayerId(pid)) return;
    banPlayer(pid, data.reason || 'admin');
    // kick if online
    for (const [sid, s] of io.sockets.sockets) {
      if (s.playerId === pid) {
        try { s.emit('banned', { reason: 'admin' }); s.disconnect(true); } catch (e) {}
      }
    }
    socket.emit('adminBanOk', { playerId: pid });
  });

  socket.on('identify', (data) => {
    const playerId = String(data?.playerId || '').slice(0, 64);
    if (!isValidPlayerId(playerId)) return;
    if (isBanned(playerId)) {
      socket.emit('errorMsg', 'Аккаунт заблокирован');
      socket.emit('banned', { reason: 'honeypot' });
      try { socket.disconnect(true); } catch (e) {}
      return;
    }
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

      // ===== HONEYPOT trap promo =====
      if (promo.trap && promo.grantSkin) {
        if (!coinStore[playerId].owned) coinStore[playerId].owned = [];
        if (coinStore[playerId].owned.indexOf(promo.grantSkin) < 0) {
          coinStore[playerId].owned.push(promo.grantSkin);
        }
        coinStore[playerId].trap = true;
        coinStore[playerId].trapAt = Date.now();
        saveCoinStore(coinStore);
        const ip = (socket.handshake && (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address)) || '';
        notifyTrap(playerId, { ip: String(ip).split(',')[0].trim(), device: socket.deviceHint });
        const total = getCoins(playerId);
        // Fake success message — looks like a real secret unlock
        socket.emit('promoResult', Object.assign({
          ok: true,
          reward: 0,
          code: promo.id,
          coins: total,
          trapGrant: true,
          skinId: promo.grantSkin,
          msg: 'secret_killer_unlocked',
          banned: true
        }, issueCoinsPayload(playerId, total)));
        // Kick after short delay so client shows "unlocked" then ban
        setTimeout(function () {
          try {
            socket.emit('banned', { reason: 'honeypot' });
            socket.disconnect(true);
          } catch (e) {}
        }, 2500);
        return;
      }

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
    if (item.trap) return socket.emit('shopError', { msg: 'unknown_skin' }); // cannot buy trap skins
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
    try {
      const ownedNow = getOwned(playerId);
      const paidKillers = Object.keys(SKIN_CATALOG).filter(id => SKIN_CATALOG[id].role === 'killer' && !SKIN_CATALOG[id].trap && (SKIN_CATALOG[id].price || 0) > 0);
      if (paidKillers.every(id => ownedNow.indexOf(id) >= 0)) {
        ensureAch(playerId).stats.collector = 1;
        checkAndUnlock(playerId, socket);
      }
    } catch (e) {}
    try {
      const ownedNow = getOwned(playerId);
      const paidKillers = Object.keys(SKIN_CATALOG).filter(id => SKIN_CATALOG[id].role === 'killer' && !SKIN_CATALOG[id].trap && (SKIN_CATALOG[id].price || 0) > 0);
      if (paidKillers.every(id => ownedNow.indexOf(id) >= 0)) {
        ensureAch(playerId).stats.collector = 1;
        checkAndUnlock(playerId, socket);
      }
    } catch (e) {}
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

    if (containsChupaBrand(roomName)) {
      return socket.emit('errorMsg', 'Нельзя использовать «Chupa» в названии комнаты');
    }
    if (containsToxic(roomName) || isBadRoomName(roomName)) {
      return socket.emit('errorMsg', 'Недопустимое название комнаты');
    }
    if (isBadPassword(password)) {
      return socket.emit('errorMsg', 'Недопустимый пароль комнаты');
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
    // Clear stale roomId if room gone
    if (socket.roomId && !rooms[socket.roomId]) {
      socket.roomId = null;
    }
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
    if (role === 'survivor' && (skinId === 'tall_chicken' || skinId === 'chupa36k' || skinId === 'prototip' || skinId === 'gemini' || skinId === 'gemini_killer')) return;
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


  socket.on('getAchievements', () => {
    if (socket.playerId) emitAchievements(socket);
  });

  socket.on('introFinished', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].introActive || rooms[id].introDone) return;
    if (!rooms[id].players[socket.id]) return;
    rooms[id].introReady = rooms[id].introReady || {};
    rooms[id].introReady[socket.id] = true;
    tryFinishIntro(id);
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
      p.tookDamage = false;
      p.lastMove = startNow; // CRITICAL: reset AFK timer at match start
      p.cheatStrikes = 0;
      p._posInit = false;
      p._lastPosAt = startNow;
      p._lastMovePkt = 0;
      p._lastAtkPkt = 0;
    });
    rooms[id].started = true;
    rooms[id].timer = ROUND_TIME;
    rooms[id].ended = false;
    rooms[id].killAwarded = {};
    rooms[id].winAwarded = {};
    rooms[id].startedAt = startNow;
    rooms[id].rageUntil = 0;
    rooms[id].rageCd = 0;
    rooms[id].rageUsed = false;
    rooms[id].ringCd = 0;
    rooms[id].tpCd = 0;
    rooms[id].tpPending = null;
    rooms[id].projectiles = [];
    rooms[id].burns = {};
    rooms[id].atkCd = {};
    rooms[id].timeStopUntil = 0;
    rooms[id].timeStopUsed = false;
    rooms[id].geminiMinionCount = 0;
    rooms[id].geminiMinionCd = 0;
    rooms[id].geminiMinionActive = null;
    rooms[id].geminiPhantomCount = 0;
    rooms[id].geminiPhantomCd = 0;
    rooms[id].geminiPhantomActive = null;
    rooms[id].protoPullCd = 0;
    rooms[id].protoStunCd = 0;
    Object.values(rooms[id].players).forEach(p => { p.moveLockUntil = 0; });

    const killerPlayer = rooms[id].players[killer.id];
    const killerSkinOut = (killerPlayer && killerPlayer.killerSkin) ? killerPlayer.killerSkin : 'tall_chicken';
    rooms[id].killerSkin = killerSkinOut;
    rooms[id].introActive = true;
    rooms[id].introDone = false;
    rooms[id].introReady = {}; // socketId -> true when that client finished the video
    if (rooms[id].introGraceTimer) {
      try { clearTimeout(rooms[id].introGraceTimer); } catch (e) {}
      rooms[id].introGraceTimer = null;
    }
    // Expected players: everyone currently in the room
    Object.keys(rooms[id].players).forEach(pid => { rooms[id].introReady[pid] = false; });
    io.to(id).emit('gameStart', {
      players: rooms[id].players,
      killerId: killer.id,
      killerSkin: killerSkinOut,
      map: rooms[id].map,
      timer: ROUND_TIME,
      intro: true
    });
    broadcastRooms();

    const projInterval = setInterval(() => {
      if (!rooms[id] || !rooms[id].started || rooms[id].ended) {
        clearInterval(projInterval);
        return;
      }
      // Prototip pull: smooth move every 50ms
      {
        const nowPull = Date.now();
        for (const pl of Object.values(rooms[id].players)) {
          if (!pl || !pl.pullUntil || nowPull > pl.pullUntil) {
            if (pl && pl.pullUntil && nowPull > pl.pullUntil) {
              pl.pullUntil = 0;
              const ts = io.sockets.sockets.get(pl.id);
              if (ts) try { ts.emit('pullEnd', {}); } catch (e) {}
            }
            continue;
          }
          const killer = rooms[id].players[pl.pullTargetId];
          if (!killer || killer.hp <= 0) {
            pl.pullUntil = 0;
            const ts = io.sockets.sockets.get(pl.id);
            if (ts) try { ts.emit('pullEnd', {}); } catch (e) {}
            continue;
          }
          const dx = killer.x - pl.x, dz = killer.z - pl.z;
          const dist = Math.sqrt(dx * dx + dz * dz) || 1;
          if (dist < 1.7) {
            pl.pullUntil = 0;
            const ts = io.sockets.sockets.get(pl.id);
            if (ts) try { ts.emit('pullEnd', {}); } catch (e) {}
            io.to(id).emit('playerMoved', { id: pl.id, x: pl.x, y: pl.y || 0, z: pl.z, yaw: pl.yaw || 0, moving: false });
            continue;
          }
          // ~12 units/sec toward killer
          const step = Math.min(0.6, dist - 1.5);
          pl.x += (dx / dist) * step;
          pl.z += (dz / dist) * step;
          io.to(id).emit('playerMoved', { id: pl.id, x: pl.x, y: pl.y || 0, z: pl.z, yaw: pl.yaw || 0, moving: true });
        }
      }

      // Gemini minion continuous walk (50ms) — survivors only, simple wall dodge
      if (rooms[id].geminiMinionActive) {
        const m = rooms[id].geminiMinionActive;
        const nowM = Date.now();
        m._acc = (m._acc || 0) + 0.05;
        if (m._acc >= 1) { m.life -= 1; m._acc = 0; }
        let target = null, best = 1e9;
        for (const pl of Object.values(rooms[id].players)) {
          if (!pl || pl.isKiller || pl.hp <= 0) continue;
          const d = (pl.x - m.x) ** 2 + (pl.z - m.z) ** 2;
          if (d < best) { best = d; target = pl; }
        }
        if (!target || m.life <= 0) {
          io.to(id).emit('minionDespawn', { id: m.id });
          rooms[id].geminiMinionActive = null;
        } else {
          const dx = target.x - m.x, dz = target.z - m.z;
          const dist = Math.sqrt(dx * dx + dz * dz) || 1;
          // continuous: ~90% survivor speed ≈ 4.2 u/s → 0.21 per 50ms
          let step = 0.21;
          let ndx = dx / dist, ndz = dz / dist;
          // simple stuck dodge: if barely moved last second, try perpendicular
          if (m._lastDist !== undefined && m._stuckT !== undefined) {
            if (Math.abs(m._lastDist - dist) < 0.05) m._stuckT += 0.05;
            else m._stuckT = 0;
          } else m._stuckT = 0;
          m._lastDist = dist;
          if (m._stuckT > 0.6) {
            // strafe left/right relative to target direction
            const side = (m._stuckSide || 1);
            const sx = -ndz * side, sz = ndx * side;
            ndx = ndx * 0.35 + sx * 0.65;
            ndz = ndz * 0.35 + sz * 0.65;
            const len = Math.sqrt(ndx * ndx + ndz * ndz) || 1;
            ndx /= len; ndz /= len;
            if (m._stuckT > 1.5) { m._stuckSide = -side; m._stuckT = 0; }
          }
          let nx = m.x + ndx * Math.min(step, dist);
          let nz = m.z + ndz * Math.min(step, dist);
          // soft map clamp (no full navmesh on server)
          nx = Math.max(-AC_MAP_HALF, Math.min(AC_MAP_HALF, nx));
          nz = Math.max(-AC_MAP_HALF, Math.min(AC_MAP_HALF, nz));
          m.x = nx; m.z = nz;
          io.to(id).emit('minionMove', { id: m.id, x: m.x, y: m.y || 0, z: m.z, targetId: target.id });
          if (dist < 1.25) {
            const nowHit = Date.now();
            if (!(m.graceUntil && nowHit < m.graceUntil)) {
              const ownerSock = io.sockets.sockets.get(m.ownerId);
              applyDamage(id, ownerSock, target, 15, { source: 'minion' });
              const tSock = io.sockets.sockets.get(target.id);
              if (tSock) tSock.emit('errorPopups', { texts: ['я знаю где ты', 'тебе не жить', 'я знаю где ты'] });
              io.to(id).emit('minionDespawn', { id: m.id });
              rooms[id].geminiMinionActive = null;
            }
          }
        }
      }

      if (!rooms[id].projectiles || !rooms[id].projectiles.length) return;
      const nowP = Date.now();
      const last = rooms[id]._projLast || nowP;
      let realDt = (nowP - last) / 1000;
      rooms[id]._projLast = nowP;
      if (realDt <= 0 || realDt > 0.25) realDt = 0.05;
      const steps = Math.max(1, Math.min(12, Math.ceil(realDt / 0.02)));
      const dt = realDt / steps;
      const left = [];
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
          if (nowP < (proj.graceUntil || 0)) continue;
          for (const target of Object.values(rooms[id].players)) {
            if (!target || target.hp <= 0) continue;
            if (target.id === proj.ownerId) continue;
            if (target.isKiller) continue;
            const ddx = target.x - proj.x, ddz = target.z - proj.z;
            if (ddx * ddx + ddz * ddz < 1.4 * 1.4) {
              const ownerSock = io.sockets.sockets.get(proj.ownerId);
              applyDamage(id, ownerSock, target, 40);
              if (proj.kind === 'fire') {
                rooms[id].burns = rooms[id].burns || {};
                rooms[id].burns[target.id] = { until: nowP + 4000, next: nowP + 500, ownerId: proj.ownerId };
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
          io.to(id).emit('projectileMove', {
            id: proj.id, x: proj.x, y: proj.y, z: proj.z,
            vx: proj.vx, vz: proj.vz, targetId: proj.targetId || null
          });
        }
      }
      rooms[id].projectiles = left;
    }, 50);
    rooms[id].projInterval = projInterval;

    const interval = setInterval(() => {
      if (!rooms[id] || !rooms[id].started) return clearInterval(interval);
      // Killer intro active: freeze timer — wait for all clients' introFinished
      if (rooms[id].introActive && !rooms[id].introDone) {
        io.to(id).emit('timer', rooms[id].timer);
        // no timer--, no AFK based on intro wait
      } else {
        // Time Stop (Gemini Killer): pause round timer
        if (rooms[id].timeStopUntil && Date.now() < rooms[id].timeStopUntil) {
          io.to(id).emit('timer', rooms[id].timer);
        } else {
          if (rooms[id].timeStopUntil && Date.now() >= rooms[id].timeStopUntil) {
            rooms[id].timeStopUntil = 0;
            io.to(id).emit('timeStopEnd', {});
          }
          rooms[id].timer--;
          io.to(id).emit('timer', rooms[id].timer);
        }
      }

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

      // Projectiles moved to 50ms ticker (smooth flight)

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

      
      // Minion AI runs in 50ms projInterval; phantom still 1Hz below
      if (rooms[id].geminiPhantomActive) {
        const ph = rooms[id].geminiPhantomActive;
        ph.life -= 1;
        let target = null, best = 1e9;
        for (const pl of Object.values(rooms[id].players)) {
          if (!pl || pl.isKiller || pl.hp <= 0) continue;
          const d = (pl.x - ph.x) ** 2 + (pl.z - ph.z) ** 2;
          if (d < best) { best = d; target = pl; }
        }
        if (!target || ph.life <= 0) {
          io.to(id).emit('phantomDespawn', { id: ph.id });
          rooms[id].geminiPhantomActive = null;
        } else {
          const dx = target.x - ph.x, dz = target.z - ph.z;
          const dist = Math.sqrt(dx * dx + dz * dz) || 1;
          // ~player walk speed: ~5 units per 1s tick (not 38 teleport)
          const step = 5.2;
          ph.x += (dx / dist) * Math.min(step, dist);
          ph.z += (dz / dist) * Math.min(step, dist);
          io.to(id).emit('phantomMove', { id: ph.id, x: ph.x, y: ph.y || 0, z: ph.z, targetId: target.id });
          // Proximity screamer at ~2 units — no attack required
          if (dist < 2.0) {
            ph.screamed = ph.screamed || {};
            if (!ph.screamed[target.id]) {
              ph.screamed[target.id] = true;
              const tSock = io.sockets.sockets.get(target.id);
              if (tSock) tSock.emit('screamer', { duration: 1500 });
            }
            // continue chase other survivors; only despawn when life ends or no targets
          }
        }
      }
      // Pull movement (coarse 1Hz backup — fine steps run in projInterval)
      for (const pl of Object.values(rooms[id].players)) {
        if (!pl || !pl.pullUntil || Date.now() > pl.pullUntil) {
          if (pl && pl.pullUntil && Date.now() > pl.pullUntil) {
            pl.pullUntil = 0;
            const ts = io.sockets.sockets.get(pl.id);
            if (ts) ts.emit('pullEnd', {});
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
    if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return;
    if (!isFinite(pos.x) || !isFinite(pos.z)) return;
    if (typeof pos.y === 'number' && !isFinite(pos.y)) return;
    if (Math.abs(pos.x) > 500 || Math.abs(pos.z) > 500 || Math.abs(pos.y || 0) > 200) return;

    const room = rooms[id];
    const p = room.players[socket.id];
    const now = Date.now();

    if (p._lastMovePkt && now - p._lastMovePkt < 30) return;
    p._lastMovePkt = now;

    if (room.started && !room.ended && p.hp <= 0) {
      p.lastMove = now;
      return;
    }
    // movement lock after successful hit
    if (p.moveLockUntil && now < p.moveLockUntil) {
      p.lastMove = now;
      socket.to(id).emit('playerMoved', {
        id: socket.id, x: p.x, y: p.y || 0, z: p.z,
        yaw: (typeof pos.yaw === 'number' ? pos.yaw : 0),
        moving: false
      });
      return;
    }
    // Being pulled by Prototip — server owns position, ignore client move
    if (p.pullUntil && now < p.pullUntil) {
      p.lastMove = now;
      return;
    }
    // Intro lock — no movement until intro ends
    if (isIntro(room)) {
      p.lastMove = now;
      return;
    }

    let nx = pos.x;
    let ny = typeof pos.y === 'number' ? pos.y : (p.y || 0);
    let nz = pos.z;
    // client may report sprinting for anti-cheat speed allowance
    p.sprinting = !!(pos && pos.sprinting);

    if (typeof p.x === 'number' && typeof p.z === 'number' && p._posInit) {
      const dt = Math.min(0.5, Math.max(0.016, (now - (p._lastPosAt || now)) / 1000));
      const dx = nx - p.x;
      const dz = nz - p.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const maxDist = acMaxSpeed(room, p) * dt + AC_MOVE_SLACK;
      if (dist > maxDist) {
        const scale = maxDist / (dist || 1);
        nx = p.x + dx * scale;
        nz = p.z + dz * scale;
        const strikes = acStrike(p, dist > maxDist * 3 ? 3 : 1);
        if (strikes >= AC_KICK_STRIKES) {
          try { socket.emit('errorMsg', 'Anti-cheat: disconnect'); } catch (e) {}
          try { socket.disconnect(true); } catch (e) {}
          return;
        }
      }
      if (Math.abs(ny - (p.y || 0)) > 25) {
        ny = p.y || 0;
        acStrike(p, 1);
      }
    } else {
      p._posInit = true;
    }

    p.x = nx;
    p.y = ny;
    p.z = nz;
    acClampPos(p);
    p._lastPosAt = now;
    p.lastMove = now;

    const yaw = (typeof pos.yaw === 'number' && isFinite(pos.yaw)) ? pos.yaw : 0;
    p.yaw = yaw;
    if (typeof pos.camYaw === 'number' && isFinite(pos.camYaw)) p.camYaw = pos.camYaw;
    socket.to(id).emit('playerMoved', {
      id: socket.id,
      x: p.x,
      y: p.y || 0,
      z: p.z,
      yaw: yaw,
      moving: !!pos.moving
    });
  });


  // ===== ABILITIES (server-authoritative) =====
  
  function finishIntroNow(roomId) {
    const room = rooms[roomId];
    if (!room || room.introDone) return;
    if (room.introGraceTimer) {
      try { clearTimeout(room.introGraceTimer); } catch (e) {}
      room.introGraceTimer = null;
    }
    room.introDone = true;
    room.introActive = false;
    room.introReady = {};
    const t0 = Date.now();
    Object.values(room.players || {}).forEach(p => { if (p) p.lastMove = t0; });
    room.startedAt = t0;
    io.to(roomId).emit('introEnd', { killerSkin: room.killerSkin });
  }

  function tryFinishIntro(roomId) {
    const room = rooms[roomId];
    if (!room || !room.introActive || room.introDone) return;
    const ready = room.introReady || {};
    const aliveIds = Object.keys(room.players || {});
    if (!aliveIds.length) {
      room.introActive = false;
      room.introDone = true;
      if (room.introGraceTimer) {
        try { clearTimeout(room.introGraceTimer); } catch (e) {}
        room.introGraceTimer = null;
      }
      return;
    }
    let readyCount = 0;
    let allReady = true;
    for (const pid of aliveIds) {
      if (ready[pid]) readyCount++;
      else allReady = false;
    }
    // Everyone finished the real video — start immediately
    if (allReady) {
      finishIntroNow(roomId);
      return;
    }
    // At least one client finished: give others a short grace (same video length),
    // then force start so one hung client cannot freeze the whole room forever.
    if (readyCount >= 1 && !room.introGraceTimer) {
      room.introGraceTimer = setTimeout(() => {
        try { finishIntroNow(roomId); } catch (e) {}
      }, 4000);
    }
  }

  function isIntro(room) {
    return !!(room && room.introActive && !room.introDone);
  }
  function killerSkinOf(room) {
    const k = Object.values(room.players).find(p => p.isKiller);
    return (k && k.killerSkin) || room.killerSkin || 'tall_chicken';
  }
  function isRaging(room) {
    return !!(room.rageUntil && Date.now() < room.rageUntil);
  }
  function attackParams(room) {
    const skin = killerSkinOf(room);
    if (skin === 'gemini') return { dmg: 5, cd: 1200, range: 1.8 }; // trap fan
    if (skin === 'gemini_killer') return { dmg: 20, cd: 4000, range: 2.4 };
    if (skin === 'prototip') return { dmg: 50, cd: 3000, range: 2.5 };
    if (skin === 'chupa36k') return { dmg: 35, cd: 1000, range: 2.4 };
    if (isRaging(room)) return { dmg: 50, cd: 1000, range: 2.4 };
    return { dmg: 10, cd: 500, range: 2.2 };
  }
  function applyDamage(roomId, attackerSock, target, dmg, meta) {
    if (!rooms[roomId] || !target || target.hp <= 0 || target.isKiller) return false;
    // sanitize: only server-chosen positive finite damage
    dmg = Math.floor(Number(dmg));
    if (!isFinite(dmg) || dmg <= 0 || dmg > 100) return false;
    target.hp = Math.max(0, target.hp - dmg);
    target.tookDamage = true; // for unscathed achievement
    io.to(roomId).emit('hit', { id: target.id, hp: target.hp });
    // Gemini revenge: minion hit confirmed
    if (meta && meta.source === 'minion' && attackerSock && attackerSock.playerId) {
      bumpStat(attackerSock.playerId, 'minionHits', 1, attackerSock);
    }
    // Post-hit movement lock for killer (2s, does not stack)
    if (attackerSock && rooms[roomId].players[attackerSock.id]) {
      const atk = rooms[roomId].players[attackerSock.id];
      const nowL = Date.now();
      // Do not stack/extend while still locked
      if (!atk.moveLockUntil || nowL >= atk.moveLockUntil) {
        atk.moveLockUntil = nowL + 2000;
        attackerSock.emit('moveLock', { until: atk.moveLockUntil, duration: 2000 });
      }
    }
    if (target.hp <= 0) {
      rooms[roomId].killAwarded = rooms[roomId].killAwarded || {};
      if (!rooms[roomId].killAwarded[target.id] && attackerSock && attackerSock.playerId) {
        rooms[roomId].killAwarded[target.id] = true;
        const total = addCoins(attackerSock.playerId, 10, 'kill');
        attackerSock.emit('coinsAward', Object.assign({ amount: 10, reason: 'kill', total }, issueCoinsPayload(attackerSock.playerId, total)));
        bumpStat(attackerSock.playerId, 'kills', 1, attackerSock);
      }
      const alive = Object.values(rooms[roomId].players).filter(p => !p.isKiller && p.hp > 0);
      if (alive.length === 0) endGame(roomId, 'killer');
    }
    return true;
  }

  socket.on('attack', (data) => {
    // Ignore ANY client-supplied damage/target — server decides everything
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    if (isIntro(rooms[id])) return;
    if (typeof attacker.x !== 'number' || typeof attacker.z !== 'number') return;

    const now = Date.now();
    // packet rate limit (extra to CD)
    if (attacker._lastAtkPkt && now - attacker._lastAtkPkt < 80) return;
    attacker._lastAtkPkt = now;

    rooms[id].atkCd = rooms[id].atkCd || {};
    const params = attackParams(rooms[id]);
    // damage & range ONLY from server tables — never from client payload
    const dmg = params.dmg;
    const range = params.range + AC_RANGE_SLACK;
    if (rooms[id].atkCd[socket.id] && now < rooms[id].atkCd[socket.id]) return;
    rooms[id].atkCd[socket.id] = now + params.cd;
    socket.emit('abilityCd', { id: 'attack', until: rooms[id].atkCd[socket.id], cd: params.cd });
    io.to(id).emit('attackFx', {
      id: socket.id,
      skin: killerSkinOf(rooms[id])
    });

    Object.values(rooms[id].players).forEach(target => {
      if (!target || target.id === socket.id || target.hp <= 0 || target.isKiller) return;
      if (typeof target.x !== 'number' || typeof target.z !== 'number') return;
      const dist = Math.sqrt(acDist2(attacker.x, attacker.z, target.x, target.z));
      // Example: killer at z=20, survivor at z=0 → dist=20 >> range(~2.5) → rejected
      if (dist <= range) {
        applyDamage(id, socket, target, dmg);
      }
    });
  });

  // Tall Chicken Rage
  socket.on('abilityRage', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    if (isIntro(rooms[id])) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    const _skR = killerSkinOf(rooms[id]);
    if (_skR !== 'tall_chicken') return;
    if (_skR === 'gemini') return;
    const now = Date.now();
    if (isRaging(rooms[id])) return;
    // Once per round only — no 30/60s re-use mid-round
    if (rooms[id].rageUsed) return;
    rooms[id].rageUsed = true;
    rooms[id].rageCd = Number.MAX_SAFE_INTEGER; // UI shows locked until round end
    rooms[id].rageUntil = now + 30000;
    rooms[id].rageOwner = socket.id;
    io.to(id).emit('rageStart', {
      until: rooms[id].rageUntil,
      duration: 30000,
      speedMult: 1 / 1.5,
      ownerId: socket.id
    });
    // Lock ability for rest of round (client treats far-future until as "used")
    socket.emit('abilityCd', { id: 'rage', until: rooms[id].rageCd, cd: 999999, once: true });
  });

  // Chupa throw ring
  socket.on('abilityRing', (data) => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    if (isIntro(rooms[id])) return;
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
      graceUntil: now + 400 // no collisions for first 400ms
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
    // must be reasonably near the target (server positions)
    if (target) {
      const dx = data.x - target.x, dz = data.z - target.z;
      if (dx * dx + dz * dz > 6.5 * 6.5) {
        rooms[id].tpPending = null;
        return io.to(id).emit('teleportFail', { ownerId: socket.id, reason: 'no_safe' });
      }
    } else {
      rooms[id].tpPending = null;
      return io.to(id).emit('teleportFail', { ownerId: socket.id, reason: 'no_target' });
    }
    // reject teleport destinations that jumped across the whole map from pending origin
    if (tp.fromX != null) {
      const jx = data.x - tp.fromX, jz = data.z - tp.fromZ;
      if (jx * jx + jz * jz > 90 * 90) {
        rooms[id].tpPending = null;
        return io.to(id).emit('teleportFail', { ownerId: socket.id, reason: 'no_safe' });
      }
    }
    killer.x = Math.max(-AC_MAP_HALF, Math.min(AC_MAP_HALF, data.x));
    killer.z = Math.max(-AC_MAP_HALF, Math.min(AC_MAP_HALF, data.z));
    killer.y = typeof data.y === 'number' && isFinite(data.y) ? Math.max(-5, Math.min(80, data.y)) : (target ? (target.y || 0) : 0);
    killer._posInit = true;
    killer._lastPosAt = Date.now();
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
    if (isIntro(rooms[id])) return;
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


  // ===== Gemini Killer abilities =====
  socket.on('abilityTimeStop', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    if (isIntro(rooms[id])) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    if (killerSkinOf(rooms[id]) !== 'gemini_killer') return;
    if (rooms[id].timeStopUsed) return;
    rooms[id].timeStopUsed = true;
    rooms[id].timeStopUntil = Date.now() + 10000;
    io.to(id).emit('timeStopStart', { until: rooms[id].timeStopUntil, duration: 10000 });
    socket.emit('abilityCd', { id: 'timeStop', until: Number.MAX_SAFE_INTEGER, cd: 999999, once: true });
  });

  socket.on('abilityMinion', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    if (isIntro(rooms[id])) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    if (killerSkinOf(rooms[id]) !== 'gemini_killer') return;
    const now = Date.now();
    if (rooms[id].geminiMinionActive) return;
    if ((rooms[id].geminiMinionCount || 0) >= 2) return;
    if (rooms[id].geminiMinionCd && now < rooms[id].geminiMinionCd) return;
    rooms[id].geminiMinionCd = now + 50000;
    rooms[id].geminiMinionCount = (rooms[id].geminiMinionCount || 0) + 1;
    const mid = 'm_' + Math.random().toString(36).slice(2, 8);
    // Spawn 2.8u in front of killer so it never starts inside owner hitbox
    const yawM = (typeof attacker.camYaw === 'number') ? attacker.camYaw
      : (typeof attacker.yaw === 'number' ? attacker.yaw : 0);
    const ox = -Math.sin(yawM) * 2.8;
    const oz = -Math.cos(yawM) * 2.8;
    const sx = attacker.x + ox;
    const sz = attacker.z + oz;
    rooms[id].geminiMinionActive = {
      id: mid, ownerId: socket.id,
      x: sx, y: attacker.y || 0, z: sz,
      born: now, life: 30, graceUntil: now + 1500
    };
    socket.emit('abilityCd', { id: 'minion', until: rooms[id].geminiMinionCd, cd: 50000 });
    io.to(id).emit('minionSpawn', {
      id: mid, ownerId: socket.id,
      x: sx, y: attacker.y || 0, z: sz
    });
  });

  socket.on('abilityPhantom', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    if (isIntro(rooms[id])) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    if (killerSkinOf(rooms[id]) !== 'gemini_killer') return;
    const now = Date.now();
    if (rooms[id].geminiPhantomActive) return;
    if ((rooms[id].geminiPhantomCount || 0) >= 2) return;
    if (rooms[id].geminiPhantomCd && now < rooms[id].geminiPhantomCd) return;
    rooms[id].geminiPhantomCd = now + 40000;
    rooms[id].geminiPhantomCount = (rooms[id].geminiPhantomCount || 0) + 1;
    const pid = 'ph_' + Math.random().toString(36).slice(2, 8);
    rooms[id].geminiPhantomActive = {
      id: pid, ownerId: socket.id,
      x: attacker.x, y: attacker.y || 0, z: attacker.z,
      born: now, life: 35, lastAtkFx: 0, screamed: {}
    };
    socket.emit('abilityCd', { id: 'phantom', until: rooms[id].geminiPhantomCd, cd: 40000 });
    io.to(id).emit('phantomSpawn', {
      id: pid, ownerId: socket.id,
      x: attacker.x, y: attacker.y || 0, z: attacker.z
    });
  });

  // ===== Prototip abilities =====
  socket.on('abilityPull', (data) => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    if (isIntro(rooms[id])) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    if (killerSkinOf(rooms[id]) !== 'prototip') return;
    const now = Date.now();
    if (rooms[id].protoPullCd && now < rooms[id].protoPullCd) return;
    // Prefer client camera yaw, then stored camYaw/yaw
    let yaw = typeof data?.yaw === 'number' ? data.yaw
      : (typeof attacker.camYaw === 'number' ? attacker.camYaw
        : (typeof attacker.yaw === 'number' ? attacker.yaw : 0));
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let best = null, bestD = 1e9;
    for (const t of Object.values(rooms[id].players)) {
      if (!t || t.isKiller || t.hp <= 0) continue;
      if (t.pullUntil && now < t.pullUntil) continue; // already pulled
      const dx = t.x - attacker.x, dz = t.z - attacker.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 12 || dist < 0.4) continue;
      const ndx = dx / dist, ndz = dz / dist;
      const dot = ndx * fx + ndz * fz;
      if (dot < 0.35) continue; // front cone (~140°)
      if (dist < bestD) { bestD = dist; best = t; }
    }
    if (!best) {
      socket.emit('abilityFail', { id: 'pull', reason: 'no_target' });
      return;
    }
    rooms[id].protoPullCd = now + 40000;
    socket.emit('abilityCd', { id: 'pull', until: rooms[id].protoPullCd, cd: 40000 });
    best.pullUntil = now + 5000;
    best.pullTargetId = socket.id;
    const tSock = io.sockets.sockets.get(best.id);
    if (tSock) tSock.emit('pullStart', { until: best.pullUntil, killerId: socket.id });
    io.to(id).emit('pullFx', { targetId: best.id, killerId: socket.id });
  });

  socket.on('abilityStun', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    if (isIntro(rooms[id])) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller || attacker.hp <= 0) return;
    if (killerSkinOf(rooms[id]) !== 'prototip') return;
    const now = Date.now();
    if (rooms[id].protoStunCd && now < rooms[id].protoStunCd) return;
    rooms[id].protoStunCd = now + 50000;
    socket.emit('abilityCd', { id: 'stun', until: rooms[id].protoStunCd, cd: 50000 });
    io.to(id).emit('stunStart', { duration: 10000, ownerId: socket.id });
  });

  // Gemini dash (server validates step)
  socket.on('geminiDash', (data) => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started || rooms[id].ended) return;
    if (isIntro(rooms[id])) return;
    const p = rooms[id].players[socket.id];
    if (!p || !p.isKiller || p.hp <= 0) return;
    if (killerSkinOf(rooms[id]) !== 'gemini_killer') return;
    const now = Date.now();
    if (p.moveLockUntil && now < p.moveLockUntil) return;
    if (p._lastDash && now - p._lastDash < 200) return;
    p._lastDash = now;
    const yaw = typeof data?.yaw === 'number' ? data.yaw : 0;
    const maxStep = 1.15 * 3 + 0.4; // max travel distance
    let nx = p.x, nz = p.z;
    // Prefer client collision-resolved position if within max dash range
    if (typeof data?.x === 'number' && typeof data?.z === 'number') {
      const dx = data.x - p.x, dz = data.z - p.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= maxStep && dist >= 0) {
        nx = data.x;
        nz = data.z;
      } else {
        // fallback: server straight step (clamped)
        nx = p.x - Math.sin(yaw) * Math.min(1.15 * 3, maxStep);
        nz = p.z - Math.cos(yaw) * Math.min(1.15 * 3, maxStep);
      }
    } else {
      nx = p.x - Math.sin(yaw) * (1.15 * 3);
      nz = p.z - Math.cos(yaw) * (1.15 * 3);
    }
    p.x = Math.max(-AC_MAP_HALF, Math.min(AC_MAP_HALF, nx));
    p.z = Math.max(-AC_MAP_HALF, Math.min(AC_MAP_HALF, nz));
    p.lastMove = now;
    io.to(id).emit('playerMoved', {
      id: socket.id, x: p.x, y: p.y || 0, z: p.z, yaw: yaw, moving: true
    });
  });


  socket.on('disconnect', () => {
    try {
      const id = socket.roomId;
      if (id && rooms[id] && rooms[id].introActive && !rooms[id].introDone) {
        if (rooms[id].introReady) rooms[id].introReady[socket.id] = true;
        // remove from expected by deleting key after leave — tryFinish uses alive players only
        setTimeout(() => { try { tryFinishIntro(id); } catch (e) {} }, 50);
      }
    } catch (e) {}

    if (socket.roomId) {
      socket.to(socket.roomId).emit('voice-peer-left', { id: socket.id });
    }
    removePlayer(socket, 'disconnect');
    rate.delete(socket.id);
  });
});



const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('ChupaSaken on port', PORT));
