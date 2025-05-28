// src/utils/pokerUtils.js
// Utility functions for Texas Hold 'Em: deck ops, formatting, and hand evaluation

const { Hand } = require('pokersolver');

// Constants for deck
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];

/**
 * Create and shuffle a standard 52-card deck.
 * Each card is an object: { rank: 'A'|'K'|...|'2', suit: '♠'|'♥'|'♦'|'♣' }
 * @returns {Array<{rank:string, suit:string}>}
 */
function createShuffledDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  // Fisher–Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Format an array of card objects into a string (e.g. ['A♠', '10♥']).
 * @param {Array<{rank:string,suit:string}>} cards
 * @returns {string}
 */
function formatCards(cards) {
  return cards.map(c => `${c.rank}${c.suit}`).join(' ');
}

// Helpers for pokersolver: map to solver input ('As', 'Td', etc.)
const RANK_MAP = { '10': 'T' };
const SUIT_MAP = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };

/**
 * Convert our card object to pokersolver string format.
 * @param {{rank:string, suit:string}} card
 * @returns {string}
 */
function toSolverFormat(card) {
  const r = RANK_MAP[card.rank] || card.rank;
  const s = SUIT_MAP[card.suit];
  return `${r}${s}`;
}

/**
 * Evaluate active players' hands against community cards and determine winners.
 * Uses pokersolver to solve and compare hands.
 * @param {Array<{id:string,holeCards:Array, isActive:boolean}>} playerStates
 * @param {Array<{rank:string,suit:string}>} communityCards
 * @returns {Array<{id:string, hand:object}>} Array of winning player objects with solver hand
 */
function evaluateWinners(playerStates, communityCards) {
  const active = playerStates.filter(p => p.isActive);
  const hands = active.map(p => {
    const all = [ ...p.holeCards, ...communityCards ].map(toSolverFormat);
    const solved = Hand.solve(all);
    return { id: p.id, hand: solved };
  });
  const winnersHands = Hand.winners(hands.map(h => h.hand));
  // Select players whose solved hand is in winnersHands
  return hands
    .filter(h => winnersHands.includes(h.hand))
    .map(h => ({ id: h.id, hand: h.hand }));
}

/**
 * Split the pot evenly among winners (floor division), distributing remainders to earliest winners.
 * @param {Array<{id:string}>} winners  Array of winner objects (from evaluateWinners)
 * @param {number} pot                Total pot size
 * @returns {{[id:string]: number}}    Mapping of playerId to chips won
 */
function splitPot(winners, pot) {
  const n = winners.length;
  const share = Math.floor(pot / n);
  let remainder = pot - share * n;
  const distribution = {};
  winners.forEach((w, idx) => {
    const extra = remainder > 0 ? 1 : 0;
    distribution[w.id] = share + extra;
    if (extra) remainder--;
  });
  return distribution;
}

module.exports = {
  createShuffledDeck,
  formatCards,
  toSolverFormat,
  evaluateWinners,
  splitPot
};
