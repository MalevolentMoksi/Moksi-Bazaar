/**
 * Game Helpers Module
 * Shared utilities for game commands (blackjack, craps, roulette, etc.)
 */

const { ComponentType, MessageFlags } = require('discord.js');
const logger = require('./logger');
const { getBalance, updateBalance } = require('./db');
const { GAME_CONFIG } = require('./constants');

/**
 * Validates and deducts a bet from a user's balance
 * @param {string} userId - Discord user ID
 * @param {number} betAmount - Amount to deduct
 * @param {Object} options - Configuration options
 * @param {number} options.minBet - Minimum bet allowed (default: 1)
 * @param {number} options.maxBet - Maximum bet allowed (default: Infinity)
 * @returns {Promise<{success: boolean, newBalance?: number, error?: string}>}
 */
async function deductBet(userId, betAmount, options = {}) {
  const { minBet = 1, maxBet = Infinity } = options;

  try {
    // Validate bet amount
    if (betAmount < minBet) {
      return {
        success: false,
        error: `Minimum bet is $${minBet}`,
      };
    }

    if (betAmount > maxBet) {
      return {
        success: false,
        error: `Maximum bet is $${maxBet}`,
      };
    }

    // Get current balance
    const balance = await getBalance(userId);

    // Check sufficient funds
    if (betAmount > balance) {
      return {
        success: false,
        error: `Insufficient funds. You have $${balance}, but bet is $${betAmount}`,
      };
    }

    // Deduct bet
    const newBalance = balance - betAmount;
    await updateBalance(userId, newBalance);

    logger.info('Bet deducted', {
      userId,
      betAmount,
      previousBalance: balance,
      newBalance,
    });

    return {
      success: true,
      newBalance,
    };
  } catch (error) {
    logger.error('Error deducting bet', { userId, betAmount, error: error.message });
    return {
      success: false,
      error: 'An error occurred while processing your bet',
    };
  }
}

/**
 * Validates bet amount before deduction
 * @param {number} amount - Bet amount
 * @param {number} balance - User's current balance
 * @param {number} minBet - Minimum allowed bet
 * @param {number} maxBet - Maximum allowed bet
 * @returns {Object} Validation result {valid: boolean, error?: string}
 */
function validateBetAmount(amount, balance, minBet = 1, maxBet = Infinity) {
  if (isNaN(amount) || amount <= 0) {
    return { valid: false, error: 'Bet must be a positive number' };
  }

  if (amount < minBet) {
    return { valid: false, error: `Minimum bet is $${minBet}` };
  }

  if (amount > maxBet) {
    return { valid: false, error: `Maximum bet is $${maxBet}` };
  }

  if (amount > balance) {
    return { valid: false, error: `You only have $${balance}` };
  }

  return { valid: true };
}

/**
 * Creates a button collector for "Play Again?" type interactions
 * @param {Message} message - Discord message with buttons
 * @param {string} userId - User ID to check button interactions
 * @param {Function} callback - Callback function {yes: async function, no: async function}
 * @param {Object} options - Configuration options
 * @param {number} options.timeout - Collector timeout in ms (default: 1 minute)
 * @returns {Promise<void>}
 */
async function createPlayAgainCollector(message, userId, callback, options = {}) {
  const { timeout = GAME_CONFIG.BLACKJACK.COLLECTOR_TIMEOUT } = options;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeout,
  });

  collector.on('collect', async (i) => {
    // Verify button interaction is from the original user
    if (i.user.id !== userId) {
      return i.reply({
        content: 'This is not your game!',
        flags: MessageFlags.Ephemeral,
      });
    }

    await i.deferUpdate();

    if (i.customId === 'play_again_yes') {
      try {
        logger.info('User chose to play again', { userId });
        await callback.yes?.(i);
      } catch (error) {
        logger.error('Error in play again callback', { userId, error: error.message });
      }
    } else if (i.customId === 'play_again_no') {
      try {
        logger.info('User chose not to play again', { userId });
        await callback.no?.(i);
      } catch (error) {
        logger.error('Error in play again callback', { userId, error: error.message });
      }
    }

    collector.stop();
  });

  collector.on('end', () => {
    logger.debug('Play again collector ended', { userId });
  });
}

/**
 * Creates buttons for "Play Again?" interaction
 * @returns {ActionRowBuilder} Discord action row with buttons
 */
function createPlayAgainButtons() {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('play_again_yes')
      .setLabel('Play Again')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('play_again_no')
      .setLabel('Exit Game')
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * Formats an array of card objects into a readable string
 * @param {Array} cards - Array of {rank, suit} objects
 * @returns {string} Formatted card string (e.g., "A♠ K♥ 10♦")
 */
function formatCards(cards) {
  return cards.map((c) => `${c.rank}${c.suit}`).join(' ');
}

/**
 * Calculates the best total for a blackjack hand
 * Aces count as 11 or 1 depending on hand total
 * @param {Array} cards - Array of {rank, suit} objects
 * @returns {number} Best hand total
 */
function calculateBlackjackTotal(cards) {
  let total = 0;
  let aces = 0;

  for (const { rank } of cards) {
    if (rank === 'A') {
      aces++;
      total += 11;
    } else if (['J', 'Q', 'K'].includes(rank)) {
      total += 10;
    } else {
      total += Number(rank);
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return total;
}

module.exports = {
  deductBet,
  validateBetAmount,
  createPlayAgainCollector,
  createPlayAgainButtons,
  formatCards,
  calculateBlackjackTotal,
};
