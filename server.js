const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const MAX_PLAYERS = 6;
const ROUND_TIME = 120;

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
  socket.on('createRoom', (name) => {
    const cleanName = (name || 'Player').trim().slice(0, 20) || 'Player';
    const code = generateCode();
    rooms[code] = {
      players: {},
      killerId: null,
      started: false,
      timer: ROUND_TIME,
      hostId: socket.id
    };
    joinRoom(socket, code, cleanName);
    socket.emit('roomCreated', code);
  });

  socket.on('joinRoom', ({ code, name }) => {
    code = (code || '').toUpperCase();
    const cleanName = (name || 'Player').trim().slice(0, 20) || 'Player';
    if (!rooms[code]) return socket.emit('errorMsg', 'Комната не найдена');
    if (rooms[code].started) return socket.emit('errorMsg', 'Игра уже началась');
    if (Object.keys(rooms[code].players).length >= MAX_PLAYERS) {
      return socket.emit('errorMsg', 'Комната заполнена (макс. 6)');
    }
    joinRoom(socket, code, cleanName);
  });

  function joinRoom(socket, code, name) {
    socket.join(code);
    socket.roomCode = code;
    rooms[code].players[socket.id] = {
      id: socket.id,
      name: name,
      x: (Math.random() - 0.5) * 8,
      y: 0.5,
      z: (Math.random() - 0.5) * 8,
      hp: 100,
      isKiller: false,
      isReady: false
    };
    io.to(code).emit('playersUpdate', rooms[code].players);
    socket.emit('joined', { code, id: socket.id, isHost: rooms[code].hostId === socket.id });
  }

  socket.on('startGame', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || rooms[code].hostId !== socket.id) return;
    const ids = Object.keys(rooms[code].players);
    if (ids.length < 2) return socket.emit('errorMsg', 'Нужно минимум 2 игрока');

    const killerId = ids[Math.floor(Math.random() * ids.length)];
    rooms[code].killerId = killerId;
    rooms[code].started = true;
    rooms[code].timer = ROUND_TIME;

    Object.values(rooms[code].players).forEach(p => {
      p.isKiller = p.id === killerId;
      p.hp = p.isKiller ? 999 : 100;
    });

    io.to(code).emit('gameStart', {
      players: rooms[code].players,
      killerId,
      timer: ROUND_TIME
    });

    const interval = setInterval(() => {
      if (!rooms[code] || !rooms[code].started) return clearInterval(interval);
      rooms[code].timer--;
      io.to(code).emit('timer', rooms[code].timer);
      if (rooms[code].timer <= 0) {
        clearInterval(interval);
        endGame(code, 'survivors');
      }
    }, 1000);
    rooms[code].interval = interval;
  });

  function endGame(code, winner) {
    if (!rooms[code]) return;
    rooms[code].started = false;
    if (rooms[code].interval) clearInterval(rooms[code].interval);
    io.to(code).emit('gameOver', { winner });
  }

  socket.on('move', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]?.players[socket.id]) return;
    const p = rooms[code].players[socket.id];
    p.x = data.x;
    p.y = data.y !== undefined ? data.y : p.y;
    p.z = data.z;
    socket.to(code).emit('playerMoved', {
      id: socket.id,
      x: p.x,
      y: p.y,
      z: p.z
    });
  });

  socket.on('attack', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]?.started) return;
    const me = rooms[code].players[socket.id];
    if (!me?.isKiller) return;

    Object.values(rooms[code].players).forEach(target => {
      if (target.id === me.id || target.isKiller || target.hp <= 0) return;
      const dist = Math.hypot(me.x - target.x, me.z - target.z);
      if (dist < 2.5) {
        target.hp = Math.max(0, target.hp - 34);
        io.to(code).emit('hit', { id: target.id, hp: target.hp });
        if (target.hp <= 0) {
          const alive = Object.values(rooms[code].players).filter(p => !p.isKiller && p.hp > 0);
          if (alive.length === 0) {
            endGame(code, 'killer');
          }
        }
      }
    });
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    delete rooms[code].players[socket.id];
    io.to(code).emit('playersUpdate', rooms[code].players);

    // Host migration
    if (rooms[code].hostId === socket.id) {
      const remaining = Object.keys(rooms[code].players);
      if (remaining.length > 0) {
        rooms[code].hostId = remaining[0];
        io.to(code).emit('hostChanged', rooms[code].hostId);
      }
    }

    if (Object.keys(rooms[code].players).length === 0) {
      if (rooms[code].interval) clearInterval(rooms[code].interval);
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('ChupaSaken server on', PORT));
