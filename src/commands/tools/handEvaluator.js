// src/utils/handEvaluator.js
// Pure hand evaluation logic for Texas Hold 'Em using pokersolver

const { Hand } = require('pokersolver');
const { toSolverFormat } = require('./pokerUtils');

/**
 * Evaluate active players' hands against community cards and determine winners.
 * @param {Array<{id:string, holeCards:Array<{rank:string,suit:string}>, isActive:boolean}>} playerStates
 * @param {Array<{rank:string,suit:string}>} communityCards
 * @returns {Array<{id:string, hand:object}>} List of winners with their solved hand
 */
function evaluateWinners(playerStates, communityCards) {
  // Filter only active players
  const activePlayers = playerStates.filter(p => p.isActive);
  // Map each to a pokersolver Hand
  const solvedHands = activePlayers.map(p => {
    const cards = [...p.holeCards, ...communityCards].map(toSolverFormat);
    const hand = Hand.solve(cards);
    return { id: p.id, hand };
  });
  // Determine best hand(s)
  const winningHands = Hand.winners(solvedHands.map(h => h.hand));
  // Return all players whose hand matches a winning hand
  return solvedHands
    .filter(h => winningHands.includes(h.hand))
    .map(h => ({ id: h.id, hand: h.hand }));
}

/**
 * Split the pot evenly among winners, distributing remainder to earliest winners.
 * @param {Array<{id:string}>} winners
 * @param {number} pot
 * @returns {{[playerId:string]: number}} Mapping of playerId to chips won
 */
function splitPot(winners, pot) {
  const count = winners.length;
  const share = Math.floor(pot / count);
  let remainder = pot - share * count;
  const distribution = {};
  winners.forEach((winner, idx) => {
    const extra = remainder > 0 ? 1 : 0;
    distribution[winner.id] = share + extra;
    if (extra) remainder--;
  });
  return distribution;
}

module.exports = {
  evaluateWinners,
  splitPot
};
