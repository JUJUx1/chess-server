const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Serve TURN credentials to the frontend (no account needed - using public TURN)
app.get('/turn-credentials', (req, res) => {
  res.json([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',                 username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',                username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443',               username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' }
  ]);
});

// Track connected users: { username -> socket.id }
const users = {};
// Track game rooms: { roomId -> { white, black, fen, spectators:[] } }
const rooms = {};
// Track which room each socket is in: { socket.id -> roomId }
const socketRoom = {};

function getRoomId(a, b) {
  return [a, b].sort().join('::');
}

io.on('connection', (socket) => {

  // ── Login ──
  socket.on('login', (username, cb) => {
    if (!username || username.length < 3) return cb({ ok: false, error: 'Bad username' });
    if (users[username] && users[username] !== socket.id) {
      // Kick old connection
      const oldSocket = io.sockets.sockets.get(users[username]);
      if (oldSocket) oldSocket.disconnect();
    }
    users[username] = socket.id;
    socket.data.username = username;
    socket.join('presence:' + username);
    // Broadcast online status to everyone
    io.emit('presence', { username, status: 'online' });
    cb({ ok: true });
  });

  // ── Check if user exists / get status ──
  socket.on('ping_user', (username, cb) => {
    const sid = users[username];
    if (!sid) return cb({ status: 'offline' });
    const s = io.sockets.sockets.get(sid);
    if (!s) { delete users[username]; return cb({ status: 'offline' }); }
    cb({ status: s.data.gameStatus || 'online' });
  });

  // ── Send game invite ──
  socket.on('invite', ({ to, time }, cb) => {
    const from = socket.data.username;
    if (!from) return cb({ ok: false });
    const toSid = users[to];
    if (!toSid) return cb({ ok: false, error: 'User not found or offline' });
    io.to(toSid).emit('invite', { from, time });
    cb({ ok: true });
  });

  // ── Accept invite / start game ──
  socket.on('accept_invite', ({ from, time }) => {
    const joiner = socket.data.username;
    if (!joiner) return;
    const fromSid = users[from];
    if (!fromSid) return;

    const roomId = getRoomId(from, joiner);
    // White = inviter (from), Black = joiner
    rooms[roomId] = {
      white: from,
      black: joiner,
      fen: 'start',
      time,
      spectators: []
    };

    socketRoom[socket.id] = roomId;
    socketRoom[fromSid] = roomId;

    socket.join(roomId);
    const fromSocket = io.sockets.sockets.get(fromSid);
    if (fromSocket) fromSocket.join(roomId);

    // Set game status
    socket.data.gameStatus = 'playing';
    if (fromSocket) fromSocket.data.gameStatus = 'playing';

    io.emit('presence', { username: joiner, status: 'playing' });
    io.emit('presence', { username: from, status: 'playing' });

    // Tell both players to start
    io.to(roomId).emit('game_start', {
      roomId,
      white: from,
      black: joiner,
      time
    });
  });

  // ── Decline invite ──
  socket.on('decline_invite', ({ to }) => {
    const toSid = users[to];
    if (toSid) io.to(toSid).emit('invite_declined', { from: socket.data.username });
  });

  // ── Game move ──
  socket.on('move', ({ roomId, move, timeRemaining }) => {
    socket.to(roomId).emit('move', { move, timeRemaining });
    // Update FEN for spectators (optional — spectators get board from moves)
  });

  // ── Chat ──
  socket.on('chat', ({ roomId, text }) => {
    socket.to(roomId).emit('chat', {
      from: socket.data.username,
      text
    });
  });

  // ── Resign ──
  socket.on('resign', ({ roomId }) => {
    socket.to(roomId).emit('opponent_resigned');
    endGame(roomId);
  });

  // ── Rematch request ──
  socket.on('rematch_request', ({ roomId, time }) => {
    socket.to(roomId).emit('rematch_request', { time });
  });

  socket.on('rematch_accept', ({ roomId, time, yourColor }) => {
    socket.to(roomId).emit('rematch_accept', { time, yourColor });
  });

  socket.on('rematch_decline', ({ roomId }) => {
    socket.to(roomId).emit('rematch_decline');
  });

  // ── Spectate ──
  socket.on('spectate', ({ username }, cb) => {
    const spect = socket.data.username;
    // Find the room for this username
    let targetRoom = null;
    for (const [rid, r] of Object.entries(rooms)) {
      if (r.white === username || r.black === username) {
        targetRoom = rid;
        break;
      }
    }
    if (!targetRoom) return cb({ ok: false, error: 'Not in a game' });
    socket.join(targetRoom);
    socketRoom[socket.id] = targetRoom;
    rooms[targetRoom].spectators.push(spect);
    const room = rooms[targetRoom];
    cb({ ok: true, white: room.white, black: room.black, fen: room.fen });
  });

  // ── Create game via invite link ──
  socket.on('host_game', ({ time }, cb) => {
    const host = socket.data.username;
    if (!host) return cb({ ok: false });
    socket.data.pendingTime = time;
    cb({ ok: true, code: host });
  });

  socket.on('join_game', ({ code, time }, cb) => {
    const joiner = socket.data.username;
    if (!joiner) return cb({ ok: false, error: 'Not logged in' });
    const hostSid = users[code];
    if (!hostSid) return cb({ ok: false, error: 'Host not found or offline' });

    const roomId = getRoomId(code, joiner);
    rooms[roomId] = {
      white: code,
      black: joiner,
      fen: 'start',
      time,
      spectators: []
    };

    socketRoom[socket.id] = roomId;
    socketRoom[hostSid] = roomId;

    socket.join(roomId);
    const hostSocket = io.sockets.sockets.get(hostSid);
    if (hostSocket) hostSocket.join(roomId);

    socket.data.gameStatus = 'playing';
    if (hostSocket) hostSocket.data.gameStatus = 'playing';

    io.emit('presence', { username: joiner, status: 'playing' });
    io.emit('presence', { username: code, status: 'playing' });

    io.to(roomId).emit('game_start', {
      roomId,
      white: code,
      black: joiner,
      time
    });
    cb({ ok: true });
  });

  // ── WebRTC Voice Signaling ──
  // Routes directly to opponent by username (works even after Render cold restart wipes room state)
  function getOpponentSid(senderSocket, roomId) {
    const room = rooms[roomId];
    if (room) {
      const oppName = room.white === senderSocket.data.username ? room.black : room.white;
      const sid = users[oppName];
      if (sid) return sid;
    }
    // Fallback: scan Socket.IO room membership
    const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
    if (socketsInRoom) {
      for (const sid of socketsInRoom) {
        if (sid !== senderSocket.id) return sid;
      }
    }
    return null;
  }

  function emitToOpponent(senderSocket, roomId, event, data) {
    const sid = getOpponentSid(senderSocket, roomId);
    if (sid) io.to(sid).emit(event, data);
    else console.warn('emitToOpponent: no opponent found for room', roomId);
  }

  socket.on('voice_call_request', ({ roomId }) => {
    emitToOpponent(socket, roomId, 'voice_call_incoming', { from: socket.data.username });
  });
  socket.on('voice_call_accept', ({ roomId }) => {
    emitToOpponent(socket, roomId, 'voice_call_accepted', {});
  });
  socket.on('voice_call_reject', ({ roomId }) => {
    emitToOpponent(socket, roomId, 'voice_call_rejected', {});
  });
  socket.on('voice_call_end', ({ roomId }) => {
    emitToOpponent(socket, roomId, 'voice_call_ended', {});
  });
  socket.on('webrtc_offer',  ({ roomId, offer })     => emitToOpponent(socket, roomId, 'webrtc_offer',  { offer }));
  socket.on('webrtc_answer', ({ roomId, answer })    => emitToOpponent(socket, roomId, 'webrtc_answer', { answer }));
  socket.on('webrtc_ice',    ({ roomId, candidate }) => emitToOpponent(socket, roomId, 'webrtc_ice',    { candidate }));

  socket.on('voice_switch_relay', ({ roomId }) => emitToOpponent(socket, roomId, 'voice_switch_relay', {}));
  socket.on('audio_chunk', ({ roomId, chunk }) => {
    emitToOpponent(socket, roomId, 'audio_chunk', { chunk });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const username = socket.data.username;
    if (!username) return;
    if (users[username] === socket.id) {
      delete users[username];
      io.emit('presence', { username, status: 'offline' });
    }
    const roomId = socketRoom[socket.id];
    if (roomId) {
      socket.to(roomId).emit('opponent_disconnected');
      delete socketRoom[socket.id];
      endGame(roomId);
    }
  });
});

function endGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  // Reset game status for players
  [room.white, room.black].forEach(u => {
    const sid = users[u];
    if (sid) {
      const s = io.sockets.sockets.get(sid);
      if (s) {
        s.data.gameStatus = 'online';
        io.emit('presence', { username: u, status: 'online' });
      }
    }
  });
  delete rooms[roomId];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chess server running on port ${PORT}`));
