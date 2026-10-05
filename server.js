const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
  socket.on('createRoom', (name) => {
    const code = generateCode();
    rooms[code] = { players: {}, killerId: null, started: false, timer: 120, hostId: socket.id };
    joinRoom(socket, code, name || 'Player');
    socket.emit('roomCreated', code);
  });

  socket.on('joinRoom', ({ code, name }) => {
    code = (code || '').toUpperCase();
    if (!rooms[code]) return socket.emit('errorMsg', 'Комната не найдена');
    if (rooms[code].started) return socket.emit('errorMsg', 'Игра уже началась');
    joinRoom(socket, code, name || 'Player');
  });

  function joinRoom(socket, code, name) {
    socket.join(code);
    socket.roomCode = code;
    rooms[code].players[socket.id] = {
      id: socket.id,
      name: (name || 'Player').slice(0, 12),
      x: (Math.random() - 0.5) * 10,
      y: 0.5,
      z: (Math.random() - 0.5) * 10,
      hp: 100,
      color: '#4488ff',
      isKiller: false
    };
    io.to(code).emit('playersUpdate', rooms[code].players);
    socket.emit('joined', { code, id: socket.id });
  }

  socket.on('startGame', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || rooms[code].hostId !== socket.id) return;
    const ids = Object.keys(rooms[code].players);
    if (ids.length < 2) return socket.emit('errorMsg', 'Нужно минимум 2 игрока');
    const killerId = ids[Math.floor(Math.random() * ids.length)];
    rooms[code].killerId = killerId;
    rooms[code].started = true;
    rooms[code].timer = 120;
    Object.values(rooms[code].players).forEach(p => {
      p.isKiller = p.id === killerId;
      p.hp = p.isKiller ? 999 : 100;
      p.color = p.isKiller ? '#ff2222' : '#4488ff';
    });
    io.to(code).emit('gameStart', { players: rooms[code].players, killerId, timer: 120 });
    const interval = setInterval(() => {
      if (!rooms[code] || !rooms[code].started) return clearInterval(interval);
      rooms[code].timer--;
      io.to(code).emit('timer', rooms[code].timer);
      if (rooms[code].timer <= 0) {
        clearInterval(interval);
        io.to(code).emit('gameOver', { winner: 'survivors' });
        rooms[code].started = false;
      }
    }, 1000);
    rooms[code].interval = interval;
  });

  socket.on('move', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]?.players[socket.id]) return;
    const p = rooms[code].players[socket.id];
    p.x = data.x; p.z = data.z;
    socket.to(code).emit('playerMoved', { id: socket.id, x: p.x, z: p.z });
  });

  socket.on('attack', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]?.started) return;
    const me = rooms[code].players[socket.id];
    if (!me?.isKiller) return;
    Object.values(rooms[code].players).forEach(target => {
      if (target.id === me.id || target.isKiller || target.hp <= 0) return;
      const dist = Math.hypot(me.x - target.x, me.z - target.z);
      if (dist < 2.3) {
        target.hp = Math.max(0, target.hp - 34);
        io.to(code).emit('hit', { id: target.id, hp: target.hp });
        if (target.hp <= 0) {
          const alive = Object.values(rooms[code].players).filter(p => !p.isKiller && p.hp > 0);
          if (alive.length === 0) {
            io.to(code).emit('gameOver', { winner: 'killer' });
            rooms[code].started = false;
            if (rooms[code].interval) clearInterval(rooms[code].interval);
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
    if (Object.keys(rooms[code].players).length === 0) {
      if (rooms[code].interval) clearInterval(rooms[code].interval);
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Forsaken Cubes server on', PORT));
