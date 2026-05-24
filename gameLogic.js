/* ============================================================
   UNO CHAOS — gameLogic.js
   Server-side authoritative game logic
   ============================================================ */

const COLORS   = ['red','blue','green','yellow'];
const SPECIALS = ['skip','reverse','+2'];

// ── DECK ─────────────────────────────────────────────────────
function createDeck(numPlayers) {
  const copies = numPlayers <= 3 ? 1 : numPlayers <= 6 ? 2 : 3;
  const deck   = [];
  for (let d = 0; d < copies; d++) {
    COLORS.forEach(col => {
      deck.push({ color:col, value:'0', type:'number' });
      ['1','2','3','4','5','6','7','8','9'].forEach(v => {
        deck.push({ color:col, value:v, type:'number' });
        deck.push({ color:col, value:v, type:'number' });
      });
      SPECIALS.forEach(v => {
        deck.push({ color:col, value:v, type:'special' });
        deck.push({ color:col, value:v, type:'special' });
      });
    });
    for (let i = 0; i < 4; i++) {
      deck.push({ color:'wild', value:'wild', type:'wild'  });
      deck.push({ color:'wild', value:'+4',   type:'wild4' });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── GAME INIT ─────────────────────────────────────────────────
function initGame(players, chaosRules) {
  const deck = createDeck(players.length);
  const hands = {};
  players.forEach(p => {
    hands[p.id] = [];
    for (let i = 0; i < 7; i++) hands[p.id].push(deck.pop());
  });

  // First discard — not wild
  let first;
  do { first = deck.pop(); } while (first.type === 'wild' || first.type === 'wild4');

  return {
    players,                          // [{ id, name, ulti }]
    hands,                            // { socketId: [cards] }
    deck,
    discard:       [first],
    currentColor:  first.color,
    currentPlayer: 0,                 // index into players[]
    direction:     1,
    turn:          1,
    drawStack:     0,
    chaosRules:    chaosRules || {},
    ultiCharges:   Object.fromEntries(players.map(p => [p.id, p.ultiCharge || 0])),
    firewallUsed:  [],
    unoShouted:    [],                // socket ids who called UNO
    status:        'playing',         // playing | finished
    winner:        null,
  };
}

// ── LEGAL PLAY CHECK ─────────────────────────────────────────
function canPlay(state, socketId, card) {
  if (state.players[state.currentPlayer].id !== socketId) return false;
  const top = state.discard[state.discard.length - 1];

  if (card.type === 'wild')  return true;
  if (card.type === 'wild4') {
    if (state.chaosRules.noBluff) return true;
    if (!state.currentColor) return true; // no color set yet, always ok
    return !state.hands[socketId].some(c =>
      c && c.color === state.currentColor
    );
  }
  if (state.drawStack > 0 && state.chaosRules.stackPlus)
    return card.value === '+2' || card.type === 'wild4';

  return card.color === state.currentColor || card.value === top.value;
}

// ── PLAY CARD ─────────────────────────────────────────────────
function playCard(state, socketId, cardIdx, chosenColor, cardData) {
  const player = state.players[state.currentPlayer];
  if (player.id !== socketId) return { ok:false, reason:'Not your turn' };

  const hand = state.hands[socketId];

  // Find card by identity (color+value) first — more reliable than index
  // since client and server hand order can drift after multiple operations
  let realIdx = -1;
  if (cardData && cardData.color && cardData.value) {
    realIdx = hand.findIndex(c =>
      c && c.color === cardData.color && c.value === cardData.value &&
      c.type === cardData.type
    );
    // If multiple same cards, prefer the one closest to cardIdx
    if (realIdx === -1) {
      // Fallback: try exact index
      realIdx = cardIdx;
    }
  } else {
    realIdx = cardIdx;
  }

  const card = hand[realIdx];
  if (!card) return { ok:false, reason:'Card not found' };
  if (!canPlay(state, socketId, card)) return { ok:false, reason:'Illegal play' };

  // Remove card from hand
  hand.splice(realIdx, 1);
  state.discard.push(card);
  if (card.color !== 'wild') state.currentColor = card.color;

  const events = [{ type:'cardPlayed', player:player.name, card }];

  // Win check
  if (hand.length === 0) {
    state.status = 'finished';
    state.winner = socketId;
    events.push({ type:'gameOver', winner:player.name, winnerId:socketId });
    return { ok:true, events };
  }

  // Chaos 7
  if (state.chaosRules.rule7 && card.value === '7') {
    // Client must send swapTarget separately via swapHand event
    events.push({ type:'awaitSwap', from:socketId });
    return { ok:true, events, awaitSwap:true };
  }

  // Chaos 0
  if (state.chaosRules.rule0 && card.value === '0') {
    const saved = state.players.map(p => [...state.hands[p.id]]);
    state.players.forEach((p, i) => {
      state.hands[p.id] = saved[(i - state.direction + state.players.length) % state.players.length];
    });
    events.push({ type:'handsRotated' });
  }

  // Wild / Wild+4
  if (card.type === 'wild' || card.type === 'wild4') {
    if (chosenColor && COLORS.includes(chosenColor)) {
      state.currentColor = chosenColor;
      events.push({ type:'colorChosen', color:chosenColor, player:player.name });
    }
    if (card.type === 'wild4') {
      const result = applyDrawStack(state, 4, events);
      if (result.skip) return advanceTurn(state, events, true);
    }
    return advanceTurn(state, events);
  }

  // Special effects
  if (card.value === 'skip') return advanceTurn(state, events, true);

  if (card.value === 'reverse') {
    state.direction *= -1;
    events.push({ type:'directionReversed' });
    if (state.players.length === 2) return advanceTurn(state, events, true);
  }

  if (card.value === '+2') {
    if (state.chaosRules.stackPlus) {
      state.drawStack += 2;
      events.push({ type:'stackGrew', total:state.drawStack });
    } else {
      const result = applyDrawStack(state, 2, events);
      if (result.skip) return advanceTurn(state, events, true);
    }
  }

  return advanceTurn(state, events);
}

function applyDrawStack(state, amount, events) {
  const nextIdx  = getNextIdx(state);
  const nextP    = state.players[nextIdx];
  const blocked  = nextP.ulti === 'firewall' && !state.firewallUsed.includes(nextP.id);

  if (blocked) {
    state.firewallUsed.push(nextP.id);
    events.push({ type:'firewallBlocked', player:nextP.name, amount });
    return { skip:true };
  }

  if (state.chaosRules.stackPlus) {
    state.drawStack += amount;
    events.push({ type:'stackGrew', total:state.drawStack });
    return { skip:false };
  }

  drawCards(state, nextP.id, amount, events);
  return { skip:true };
}

function drawCards(state, socketId, count, events = []) {
  const hand = state.hands[socketId];
  const player = state.players.find(p => p.id === socketId);
  for (let i = 0; i < count; i++) {
    if (state.deck.length === 0) reshuffleDeck(state, events);
    if (state.deck.length > 0) hand.push(state.deck.pop());
  }
  events.push({ type:'drewCards', player:player?.name, socketId, count });
  return events;
}

function reshuffleDeck(state, events) {
  if (state.discard.length <= 1) return;
  const top   = state.discard.pop();
  state.deck  = shuffle(state.discard);
  state.discard = [top];
  events.push({ type:'deckReshuffled' });
}

// ── DRAW (player action) ──────────────────────────────────────
function drawAction(state, socketId) {
  const player = state.players[state.currentPlayer];
  if (!player) return { ok:false, reason:'No current player' };
  if (player.id !== socketId) return { ok:false, reason:'Not your turn' };

  const events = [];

  if (state.drawStack > 0) {
    const total    = state.drawStack;
    state.drawStack = 0;
    const blocked  = player.ulti === 'firewall' && !state.firewallUsed.includes(socketId);
    if (blocked) {
      state.firewallUsed.push(socketId);
      events.push({ type:'firewallBlocked', player:player.name, amount:total });
    } else {
      drawCards(state, socketId, total, events);
    }
    // After eating stack, advance turn (skip = false, just move to next)
    const adv = advanceTurn(state, []);
    return { ok:true, events:[...events, ...adv.events] };
  }

  // Normal draw 1 — then end turn
  drawCards(state, socketId, 1, events);
  const adv = advanceTurn(state, []);
  return { ok:true, events:[...events, ...adv.events] };
}

// ── SWAP HAND (7 rule) ────────────────────────────────────────
function swapHand(state, fromId, toId) {
  const from = state.players.find(p => p.id === fromId);
  const to   = state.players.find(p => p.id === toId);
  if (!from || !to) return { ok:false };

  const tmp = state.hands[fromId];
  state.hands[fromId] = state.hands[toId];
  state.hands[toId]   = tmp;

  const events = [{ type:'handsSwapped', from:from.name, to:to.name }];
  return { ok:true, events, ...advanceTurn(state, []) };
}

// ── UNO CALL ─────────────────────────────────────────────────
function callUno(state, socketId) {
  if (!state.unoShouted.includes(socketId)) {
    state.unoShouted.push(socketId);
  }
  const player = state.players.find(p => p.id === socketId);
  return { type:'unoCalled', player:player?.name };
}

// ── UNO PENALTY CHECK ────────────────────────────────────────
// Call this when a player's turn ends if they have 1 card and didn't shout
function checkUnoPenalty(state, socketId, events) {
  const hand = state.hands[socketId];
  if (hand?.length === 1 && !state.unoShouted.includes(socketId)) {
    drawCards(state, socketId, 2, events);
    const player = state.players.find(p => p.id === socketId);
    events.push({ type:'unoPenalty', player:player?.name });
  }
}

// ── TURN ADVANCE ─────────────────────────────────────────────
function getNextIdx(state, skip = false) {
  let next = (state.currentPlayer + state.direction + state.players.length) % state.players.length;
  if (skip) next = (next + state.direction + state.players.length) % state.players.length;
  return next;
}

function advanceTurn(state, events, skip = false) {
  // UNO penalty for current player
  const curId = state.players[state.currentPlayer].id;
  checkUnoPenalty(state, curId, events);
  state.unoShouted = state.unoShouted.filter(id => id !== curId);

  if (skip) {
    const skippedIdx = getNextIdx(state, false);
    events.push({ type:'playerSkipped', player:state.players[skippedIdx].name });
    state.currentPlayer = getNextIdx(state, true);
  } else {
    state.currentPlayer = getNextIdx(state, false);
  }
  state.turn++;
  events.push({ type:'turnChanged', currentPlayer:state.players[state.currentPlayer] });
  return { ok:true, events };
}

// ── PUBLIC VIEW (hide other players' hands) ───────────────────
function getPublicState(state, forSocketId) {
  // Filter out any undefined/null cards — safety guard
  const myRawHand = state.hands[forSocketId] || [];
  const myHand    = myRawHand.filter(c => c != null && c.color && c.value && c.type);

  return {
    players:       state.players.map(p => ({
      id:          p.id,
      name:        p.name,
      ulti:        p.ulti,
      cardCount:   (state.hands[p.id] || []).filter(c => c && c.color).length,
    })),
    myHand,
    discard:       state.discard,
    currentColor:  state.currentColor,
    currentPlayer: state.currentPlayer,
    currentPlayerId: state.players[state.currentPlayer]?.id,
    direction:     state.direction,
    turn:          state.turn,
    drawStack:     state.drawStack,
    deckCount:     state.deck.length,
    chaosRules:    state.chaosRules,
    status:        state.status,
    winner:        state.winner,
    ultiCharges:   state.ultiCharges,
  };
}

module.exports = {
  initGame,
  canPlay,
  playCard,
  drawAction,
  swapHand,
  callUno,
  getPublicState,
  drawCards,
  shuffle,
};
