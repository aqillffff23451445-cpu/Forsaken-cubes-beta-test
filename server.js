const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {}; // key = roomId (short code)
const MAX_PLAYERS = 6;
const ROUND_TIME = 120;

function genId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
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

io.on('connection', (socket) => {
  // send current list immediately
  socket.emit('roomList', publicRoomList());

  // ===== CREATE ROOM =====
  socket.on('createRoom', (data) => {
    const playerName = (data?.playerName || 'Player').trim().slice(0, 20) || 'Player';
    const roomName = (data?.roomName || 'Комната').trim().slice(0, 30) || 'Комната';
    const password = (data?.password || '').trim().slice(0, 16);
    const map = data?.map || 'map.glb';

    // prevent duplicate names while waiting
    const exists = Object.values(rooms).some(r => !r.started && r.name.toLowerCase() === roomName.toLowerCase());
    if (exists) return socket.emit('errorMsg', 'Комната с таким названием уже есть');

    const id = genId();
    rooms[id] = {
      name: roomName,
      password,
      map,
      players: {},
      killerId: null,
      started: false,
      timer: ROUND_TIME,
      hostId: socket.id
    };
    joinPlayer(socket, id, playerName);
    socket.emit('roomCreated', { id, name: roomName });
    broadcastRooms();
  });

  // ===== JOIN ROOM =====
  socket.on('joinRoom', (data) => {
    const playerName = (data?.playerName || 'Player').trim().slice(0, 20) || 'Player';
    let id = (data?.id || data?.code || '').toUpperCase();
    const password = (data?.password || '').trim();

    // allow join by name
    if (!rooms[id]) {
      const found = Object.entries(rooms).find(([, r]) =>
        !r.started && r.name.toLowerCase() === (data?.name || '').toLowerCase()
      );
      if (found) id = found[0];
    }

    if (!rooms[id]) return socket.emit('errorMsg', 'Комната не найдена');
    if (rooms[id].started) return socket.emit('errorMsg', 'Игра уже началась');
    if (Object.keys(rooms[id].players).length >= MAX_PLAYERS) {
      return socket.emit('errorMsg', 'Комната заполнена (макс. 6)');
    }
    if (rooms[id].password && rooms[id].password !== password) {
      return socket.emit('errorMsg', 'Неверный пароль');
    }

    joinPlayer(socket, id, playerName);
    broadcastRooms();
  });

  function joinPlayer(socket, id, name) {
    socket.join(id);
    socket.roomId = id;
    rooms[id].players[socket.id] = {
      id: socket.id,
      name,
      x: 0, y: 0, z: 0,
      hp: 100,
      isKiller: false
    };
    io.to(id).emit('playersUpdate', rooms[id].players);
    socket.emit('joined', {
      id,
      name: rooms[id].name,
      playerId: socket.id,
      isHost: rooms[id].hostId === socket.id,
      map: rooms[id].map
    });
  }

  // ===== START GAME =====
  socket.on('startGame', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || rooms[id].hostId !== socket.id) {
      return socket.emit('errorMsg', 'Вы не владелец!');
    }
    const ids = Object.keys(rooms[id].players);
    if (ids.length < 2) return socket.emit('errorMsg', 'Недостаточно игроков!');

    const killerId = ids[Math.floor(Math.random() * ids.length)];
    rooms[id].killerId = killerId;
    rooms[id].started = true;
    rooms[id].timer = ROUND_TIME;

    Object.values(rooms[id].players).forEach(p => {
      p.isKiller = p.id === killerId;
      p.hp = p.isKiller ? 999 : 100;
    });

    io.to(id).emit('gameStart', {
      players: rooms[id].players,
      killerId,
      timer: ROUND_TIME,
      map: rooms[id].map
    });
    broadcastRooms();

    const interval = setInterval(() => {
      if (!rooms[id] || !rooms[id].started) return clearInterval(interval);
      rooms[id].timer--;
      io.to(id).emit('timer', rooms[id].timer);
      if (rooms[id].timer <= 0) {
        clearInterval(interval);
        endGame(id, 'survivors');
      }
    }, 1000);
    rooms[id].interval = interval;
  });

  function endGame(id, winner) {
    if (!rooms[id]) return;
    rooms[id].started = false;
    if (rooms[id].interval) clearInterval(rooms[id].interval);
    io.to(id).emit('gameOver', { winner });
    // keep room alive a bit so people can see result, then allow rejoin
    setTimeout(() => broadcastRooms(), 4000);
  }

  // ===== MOVE / ATTACK =====
  socket.on('move', (pos) => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].players[socket.id]) return;
    const p = rooms[id].players[socket.id];
    p.x = pos.x; p.y = pos.y; p.z = pos.z;
    socket.to(id).emit('playerMoved', { id: socket.id, x: pos.x, y: pos.y, z: pos.z });
  });

  socket.on('attack', () => {
    const id = socket.roomId;
    if (!id || !rooms[id] || !rooms[id].started) return;
    const attacker = rooms[id].players[socket.id];
    if (!attacker || !attacker.isKiller) return;

    Object.values(rooms[id].players).forEach(target => {
      if (target.id === socket.id || target.hp <= 0 || target.isKiller) return;
      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 2.2) {
        target.hp = Math.max(0, target.hp - 50);
        io.to(id).emit('hit', { id: target.id, hp: target.hp });
        if (target.hp <= 0) {
          const alive = Object.values(rooms[id].players).filter(p => !p.isKiller && p.hp > 0);
          if (alive.length === 0) endGame(id, 'killer');
        }
      }
    });
  });

  // ===== DISCONNECT =====
  socket.on('disconnect', () => {
    const id = socket.roomId;
    if (!id || !rooms[id]) return;
    delete rooms[id].players[socket.id];

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
        const alive = Object.values(rooms[id].players).filter(p => !p.isKiller && p.hp > 0);
        if (alive.length === 0) endGame(id, 'killer');
      }
    }
    broadcastRooms();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('ChupaSaken on port', PORT));
