/* ============================================================
   UNO CHAOS — server.js
   Express + Socket.io multiplayer server
   ============================================================ */

const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const cors      = require('cors');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const {
  initGame, playCard, drawAction,
  swapHand, callUno, getPublicState, drawCards
} = require('./gameLogic');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors());
app.use(express.json());

// Serve frontend static files (put frontend files in /public or root)
app.use(express.static(path.join(__dirname, '..')));

// ── ROOM STORAGE ─────────────────────────────────────────────
// rooms[code] = { code, hostId, players[], gameState, settings, status }
const rooms = {};

// ── HELPERS ──────────────────────────────────────────────────
function generateCode() {
  // 6-char alphanumeric code, easy to share
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomBySocket(socketId) {
  return Object.values(rooms).find(r =>
    r.players.some(p => p.id === socketId)
  );
}

function broadcastRoom(code, event, data) {
  io.to(code).emit(event, data);
}

function broadcastStateToAll(room) {
  room.players.forEach(p => {
    const socket = io.sockets.sockets.get(p.id);
    if (socket) {
      socket.emit('gameState', getPublicState(room.gameState, p.id));
    }
  });
}

function emitLog(code, msg, type = '') {
  broadcastRoom(code, 'gameLog', { msg, type });
}

// ── CONNECTION ───────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────────────────────
  socket.on('createRoom', ({ playerName, ulti, chaosRules }, cb) => {
    const code = generateCode();
    rooms[code] = {
      code,
      hostId:  socket.id,
      players: [{
        id:   socket.id,
        name: (playerName || 'PLAYER_1').toUpperCase().slice(0, 14),
        ulti: ulti || 'ghost',
        ultiCharge: 0,
        ready: false,
      }],
      gameState: null,
      chaosRules: chaosRules || {},
      status: 'lobby',    // lobby | playing | finished
      awaitSwap: null,    // socket id awaiting swap pick
    };

    socket.join(code);
    console.log(`[ROOM] Created ${code} by ${socket.id}`);
    cb({ ok:true, code, players: rooms[code].players });
    broadcastRoom(code, 'lobbyUpdate', { players: rooms[code].players, code });
  });

  // ── JOIN ROOM ────────────────────────────────────────────
  socket.on('joinRoom', ({ code, playerName, ulti }, cb) => {
    const room = rooms[code?.toUpperCase()];
    if (!room)            return cb({ ok:false, reason:'Room not found' });
    if (room.status !== 'lobby') return cb({ ok:false, reason:'Game already started' });
    if (room.players.length >= 8) return cb({ ok:false, reason:'Room is full (max 8)' });

    const player = {
      id:   socket.id,
      name: (playerName || `PLAYER_${room.players.length + 1}`).toUpperCase().slice(0, 14),
      ulti: ulti || 'ghost',
      ultiCharge: 0,
      ready: false,
    };
    room.players.push(player);
    socket.join(code);

    console.log(`[ROOM] ${player.name} joined ${code}`);
    cb({ ok:true, code, players:room.players, hostId:room.hostId, chaosRules:room.chaosRules });
    broadcastRoom(code, 'lobbyUpdate', { players:room.players, hostId:room.hostId });
    emitLog(code, `${player.name} JOINED THE ROOM`, 'hi');
  });

  // ── RANDOM MATCHMAKING ───────────────────────────────────
  socket.on('quickJoin', ({ playerName, ulti }, cb) => {
    // Find any open lobby with < 8 players
    const open = Object.values(rooms).find(r =>
      r.status === 'lobby' && r.players.length < 8 && r.players.length >= 1
    );
    if (open) {
      socket.emit('joinRoom', { code: open.code, playerName, ulti });
      // Re-fire joinRoom logic
      socket.emit('quickJoinFound', { code: open.code });
      return socket.emit('triggerJoin', { code: open.code, playerName, ulti });
    }
    // No room found — create one
    const code = generateCode();
    rooms[code] = {
      code, hostId: socket.id,
      players: [{ id:socket.id, name:(playerName||'PLAYER_1').toUpperCase(), ulti:ulti||'ghost', ultiCharge:0, ready:false }],
      gameState:null, chaosRules:{}, status:'lobby', awaitSwap:null,
    };
    socket.join(code);
    cb({ ok:true, code, created:true, players:rooms[code].players });
    broadcastRoom(code, 'lobbyUpdate', { players:rooms[code].players, code });
  });

  // ── UPDATE SETTINGS (host only) ──────────────────────────
  socket.on('updateSettings', ({ chaosRules }) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.chaosRules = chaosRules;
    broadcastRoom(room.code, 'settingsUpdate', { chaosRules });
  });

  // ── PLAYER READY ─────────────────────────────────────────
  socket.on('playerReady', ({ ulti }) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) { player.ready = true; player.ulti = ulti || player.ulti; }
    broadcastRoom(room.code, 'lobbyUpdate', { players:room.players, hostId:room.hostId });
  });

  // ── START GAME (host only) ───────────────────────────────
  socket.on('startGame', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room)                        return cb?.({ ok:false, reason:'Room not found' });
    if (room.hostId !== socket.id)    return cb?.({ ok:false, reason:'Only host can start' });
    if (room.players.length < 2)      return cb?.({ ok:false, reason:'Need at least 2 players' });

    room.status    = 'playing';
    room.gameState = initGame(room.players, room.chaosRules);

    console.log(`[GAME] Started in room ${room.code} — ${room.players.length} players`);
    broadcastRoom(room.code, 'gameStarted', {});
    broadcastStateToAll(room);
    emitLog(room.code, `GAME STARTED — ${room.players.length} PLAYERS`, 'hi');
    cb?.({ ok:true });
  });

  // ── PLAY CARD ────────────────────────────────────────────
  socket.on('playCard', ({ cardIdx, chosenColor, cardData }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return cb?.({ ok:false });

    const result = playCard(room.gameState, socket.id, cardIdx, chosenColor, cardData);
    if (!result.ok) return cb?.({ ok:false, reason:result.reason });

    // Broadcast events as log messages
    result.events?.forEach(ev => handleEvent(room, ev));

    if (result.awaitSwap) {
      room.awaitSwap = socket.id;
      // Send swap request only to the player who played the 7
      socket.emit('requestSwapTarget', {
        players: room.players.filter(p => p.id !== socket.id).map(p => ({
          id:p.id, name:p.name, cardCount:room.gameState.hands[p.id]?.length
        }))
      });
    }

    broadcastStateToAll(room);
    cb?.({ ok:true });
  });

  // ── DRAW CARD ────────────────────────────────────────────
  socket.on('drawCard', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return cb?.({ ok:false });

    const result = drawAction(room.gameState, socket.id);
    if (!result.ok) return cb?.({ ok:false, reason:result.reason });

    result.events?.forEach(ev => handleEvent(room, ev));
    broadcastStateToAll(room);
    cb?.({ ok:true });
  });

  // ── SWAP HAND (7 rule) ───────────────────────────────────
  socket.on('swapHand', ({ targetId }, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.awaitSwap !== socket.id) return cb?.({ ok:false });

    const result = swapHand(room.gameState, socket.id, targetId);
    if (!result.ok) return cb?.({ ok:false });

    room.awaitSwap = null;
    result.events?.forEach(ev => handleEvent(room, ev));
    broadcastStateToAll(room);
    cb?.({ ok:true });
  });

  // ── CALL UNO ─────────────────────────────────────────────
  socket.on('callUno', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') return;
    const ev = callUno(room.gameState, socket.id);
    emitLog(room.code, `${ev.player} CALLS UNO!`, 'bad');
    broadcastRoom(room.code, 'unoCalled', { player:ev.player });
  });

  // ── CHAT MESSAGE ─────────────────────────────────────────
  socket.on('chatMsg', ({ text }) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    broadcastRoom(room.code, 'chatMsg', {
      player: player?.name || 'UNKNOWN',
      text:   (text || '').slice(0, 80),
    });
  });

  // ── DISCONNECT ───────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const room = getRoomBySocket(socket.id);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    emitLog(room.code, `${player.name} DISCONNECTED`, 'warn');

    if (room.status === 'lobby') {
      // Remove from lobby
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[room.code];
        return;
      }
      // Transfer host if needed
      if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
        emitLog(room.code, `${room.players[0].name} IS NOW HOST`, 'hi');
      }
      broadcastRoom(room.code, 'lobbyUpdate', { players:room.players, hostId:room.hostId });
      return;
    }

    if (room.status === 'playing') {
      // Mid-game disconnect — transfer host, remove from rotation
      if (room.hostId === socket.id) {
        const remaining = room.players.filter(p => p.id !== socket.id);
        if (remaining.length > 0) {
          room.hostId = remaining[0].id;
          emitLog(room.code, `${remaining[0].name} IS NOW HOST`, 'hi');
          broadcastRoom(room.code, 'hostChanged', { newHostId:room.hostId });
        }
      }

      // Remove player from game state
      const state = room.gameState;
      const pidx  = state.players.findIndex(p => p.id === socket.id);
      if (pidx !== -1) {
        // Put disconnected player's hand back in deck
        if (state.hands[socket.id]) {
          state.deck.push(...state.hands[socket.id]);
          delete state.hands[socket.id];
        }
        state.players.splice(pidx, 1);

        // Fix currentPlayer index if needed
        if (state.players.length === 0) {
          delete rooms[room.code]; return;
        }
        if (state.currentPlayer >= state.players.length) {
          state.currentPlayer = 0;
        }
        if (state.players.length === 1) {
          // Last player standing — wins
          state.status = 'finished';
          state.winner = state.players[0].id;
          emitLog(room.code, `${state.players[0].name} WINS BY DEFAULT!`, 'hi');
        }
      }

      room.players = room.players.filter(p => p.id !== socket.id);
      broadcastStateToAll(room);
    }
  });

  // ── REMATCH ──────────────────────────────────────────────
  socket.on('rematch', (_, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return cb?.({ ok:false });

    room.status    = 'playing';
    room.gameState = initGame(room.players, room.chaosRules);
    room.awaitSwap = null;

    broadcastRoom(room.code, 'gameStarted', {});
    broadcastStateToAll(room);
    emitLog(room.code, 'REMATCH STARTED!', 'hi');
    cb?.({ ok:true });
  });

  // ── LEAVE ROOM ───────────────────────────────────────────
  socket.on('leaveRoom', () => {
    socket.disconnect();
  });
});

// ── EVENT → LOG MAPPER ────────────────────────────────────────
function handleEvent(room, ev) {
  const logMap = {
    cardPlayed:      e => emitLog(room.code, `${e.player} PLAYS ${e.card.color.toUpperCase()} ${e.card.value.toUpperCase()}`, ''),
    colorChosen:     e => emitLog(room.code, `${e.player} CHOSE ${e.color.toUpperCase()}`, 'hi'),
    directionReversed: () => emitLog(room.code, 'DIRECTION REVERSED!', 'hi'),
    playerSkipped:   e => emitLog(room.code, `${e.player} SKIPPED`, 'warn'),
    drewCards:       e => emitLog(room.code, `${e.player} DRAWS ${e.count}`, 'warn'),
    stackGrew:       e => emitLog(room.code, `STACK +${e.total} TOTAL`, 'bad'),
    handsRotated:    () => emitLog(room.code, '0-ROTATE: ALL HANDS ROTATED!', 'hi'),
    handsSwapped:    e => emitLog(room.code, `${e.from} SWAPPED WITH ${e.to}`, 'hi'),
    firewallBlocked: e => emitLog(room.code, `${e.player} FIREWALL BLOCKS ${e.amount}!`, 'vip'),
    deckReshuffled:  () => emitLog(room.code, 'DECK RESHUFFLED', 'hi'),
    unoPenalty:      e => emitLog(room.code, `${e.player} FORGOT UNO! +2`, 'bad'),
    gameOver:        e => {
      emitLog(room.code, `🏆 ${e.winner} WINS!`, 'hi');
      room.status = 'finished';
      broadcastRoom(room.code, 'gameOver', { winner:e.winner, winnerId:e.winnerId });
    },
    turnChanged: () => {}, // handled by broadcastStateToAll
  };
  const handler = logMap[ev.type];
  if (handler) handler(ev);
}

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status:'ok', rooms:Object.keys(rooms).length }));
app.get('/api/rooms', (_, res) => res.json(
  Object.values(rooms).map(r => ({ code:r.code, players:r.players.length, status:r.status }))
));

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 UNO CHAOS Server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});
