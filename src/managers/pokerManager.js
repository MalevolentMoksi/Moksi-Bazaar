// src/managers/pokerManager.js
// Responsible for tracking lobby and game state for multiplayer Texas Hold 'Em

const pokerUtils = require('../utils/pokerUtils');
const handEvaluator = require('../utils/handEvaluator');

// Game constants
const DEFAULT_STACK = 10000;  // everyone starts with 10 000
const SMALL_BLIND   = 100;    // small blind
const BIG_BLIND     = 200;    // big blind

// Maps to hold lobby and active game states per channel
const lobbies = new Map();      // channelId -> Set<userId>
const games   = new Map();      // channelId -> gameState object

/**
 * Add a user to the poker lobby for a given channel.
 * @param {string} channelId
 * @param {string} userId
 * @returns {string[]} Array of userIds in the lobby
 */
function joinGame(channelId, userId) {
  // ── Step 7a: block mid-game joins ───────────────────────────────
  if (games.has(channelId)) {
    throw new Error('❗ A game is already in progress — you cannot join now.');
  }

  if (!lobbies.has(channelId)) {
    lobbies.set(channelId, new Set());
  }
  const set = lobbies.get(channelId);
  set.add(userId);
  return Array.from(set);
}

/**
 * Get the list of players in the lobby for a channel.
 * @param {string} channelId
 * @returns {string[]}
 */
function getPlayers(channelId) {
  return Array.from(lobbies.get(channelId) || []);
}

/**
 * Initialize a new poker game in a channel.
 * Deals hole cards, shuffles deck, resets bets.
 * @param {string} channelId
 * @throws {Error} if fewer than 2 players
 * @returns {object} game state
 */
function startGame(channelId) {
  const players = getPlayers(channelId);
  if (players.length < 2) {
    throw new Error('Need at least 2 players to start a poker game.');
  }

  // Shuffle a fresh deck
  const deck = pokerUtils.createShuffledDeck();

  // Pick a dealer at random
  const dealerIndex = Math.floor(Math.random() * players.length);

  // Setup each player's state (with starting stack)
  const playerStates = players.map((id, i) => ({
    id,
    holeCards: [deck.pop(), deck.pop()],
    isActive: true,
    hasActed: false,
    stack: DEFAULT_STACK,
  }));

  // Seed blinds into pot
  const sbIndex = (dealerIndex + 1) % playerStates.length;
  const bbIndex = (dealerIndex + 2) % playerStates.length;

  // Deduct small blind
  const sbPlayer = playerStates[sbIndex];
  sbPlayer.stack -= SMALL_BLIND;
  const bets = new Map(playerStates.map(p => [p.id, 0]));
  bets.set(sbPlayer.id, SMALL_BLIND);

  // Deduct big blind
  const bbPlayer = playerStates[bbIndex];
  bbPlayer.stack -= BIG_BLIND;
  bets.set(bbPlayer.id, BIG_BLIND);

  // Initialize game state
  const state = {
    channelId,
    dealerIndex,
    players: playerStates,
    deck,
    communityCards: [],
    pot: SMALL_BLIND + BIG_BLIND,
    currentBet: BIG_BLIND,
    stage: 'pre-flop',
    currentPlayerIndex: (bbIndex + 1) % playerStates.length, // under-the-gun
    bets,  // Map<playerId, chips put in this round>
  };

  // Remove lobby, mark game active
  lobbies.delete(channelId);
  games.set(channelId, state);
  return state;
}

/**
 * Handle a player's action (fold, check, call, bet, raise).
 * Advances turn index and updates game rounds as needed.
 * @param {string} channelId
 * @param {'fold'|'check'|'call'|'bet'|'raise'} action
 * @param {number|null} amount  Chips for bet/raise, or null
 * @returns {object} Updated game state
 */
function handleAction(channelId, action, amount = null) {
  const state = games.get(channelId);
  if (!state) throw new Error('No active poker game in this channel.');

  const pStates = state.players;
  const me = pStates[state.currentPlayerIndex];
  if (!me.isActive) throw new Error('This player has already folded.');

  // mark that I acted
  me.hasActed = true;
  const contributed = state.bets.get(me.id) || 0;

  switch (action) {
    case 'fold':
      me.isActive = false;
      break;

    case 'check':
      if (contributed !== state.currentBet) {
        throw new Error('Cannot check when there is a bet to call.');
      }
      break;

    case 'call': {
      const toCall = state.currentBet - contributed;
      if (me.stack < toCall) throw new Error('Not enough chips to call.');
      me.stack -= toCall;
      state.bets.set(me.id, contributed + toCall);
      state.pot += toCall;
      break;
    }

    case 'bet':
    case 'raise': {
      if (amount == null) throw new Error('No bet amount specified.');
      if (amount <= state.currentBet) {
        throw new Error('Raise must be greater than current bet.');
      }
      const raiseAmt = amount - contributed;
      if (me.stack < raiseAmt) throw new Error('Not enough chips to raise.');
      me.stack -= raiseAmt;
      state.bets.set(me.id, contributed + raiseAmt);
      state.pot += raiseAmt;
      state.currentBet = amount;
      // after a raise, everyone else needs to act again
      pStates.forEach(p => {
        p.hasActed = (p.id === me.id);
      });
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }

  //  ── Check for end of betting round ─────────────────────────
  const activePlayers = state.players.filter(p => p.isActive);
  const allActed   = activePlayers.every(p => p.hasActed);
  const betsEqual  = activePlayers.every(
    p => (state.bets.get(p.id) || 0) === state.currentBet
  );

  if (allActed && betsEqual) {
    advanceStage(state);
  }

  //  ── Advance to next active player ─────────────────────────
  let next = state.currentPlayerIndex;
  do {
    next = (next + 1) % pStates.length;
  } while (!pStates[next].isActive && next !== state.currentPlayerIndex);
  state.currentPlayerIndex = next;

  // ── Check for showdown conditions ────────────────────────────
  if (activePlayers.length <= 1 || state.stage === 'showdown') {
    state.stage = 'showdown';
    const winners = handEvaluator.evaluateWinners(
      state.players,
      state.communityCards
    );
    const payouts = handEvaluator.splitPot(winners, state.pot);
    state.winners = winners;
    state.payouts = payouts;
  }

  return state;
}

/**
 * Progress the game to the next stage (flop, turn, river, showdown).
 * Resets bets and prepares for the next round of betting.
 * @param {object} state
 */
function advanceStage(state) {
  // the order of streets
  const order = ['pre-flop','flop','turn','river','showdown'];
  const idx   = order.indexOf(state.stage);

  // deal into communityCards based on current street
  if (state.stage === 'pre-flop') {
    state.deck.pop(); // burn
    state.communityCards.push(
      state.deck.pop(),
      state.deck.pop(),
      state.deck.pop()
    );
  } else if (state.stage === 'flop') {
    state.deck.pop();
    state.communityCards.push(state.deck.pop());
  } else if (state.stage === 'turn') {
    state.deck.pop();
    state.communityCards.push(state.deck.pop());
  }
  // river → showdown has no deal

  // advance the stage
  state.stage = order[idx + 1] || 'showdown';

  // reset bets for the new round
  state.bets = new Map(state.players.map(p => [p.id, 0]));
  state.currentBet = 0;
  state.players.forEach(p => (p.hasActed = false));
}

// TODO: implement transition to next stage (deal flop/turn/river or showdown)
// TODO: handle pot distribution at showdown using pokerUtils.evaluateHands

module.exports = {
  joinGame,
  getPlayers,
  startGame,
  handleAction
};
