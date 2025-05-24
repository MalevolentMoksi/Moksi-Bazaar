// src/commands/blackjack.js
const { SlashCommandBuilder } = require('@discordjs/builders');
const fs = require('fs');
const path = require('path');

// Path to a simple JSON-based balance store (create balances.json in your project root)
const BALANCES_FILE = path.resolve(__dirname, '../../balances.json');

// In-memory active games: userId -> { deck, hand, dealerHand, bet, done }
const games = new Map();

// Load balances from disk (or initialize empty)
function loadBalances() {
  try {
    return JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf8'));
  } catch {
    return {};  
  }
}

// Save balances to disk
function saveBalances(balances) {
  fs.writeFileSync(BALANCES_FILE, JSON.stringify(balances, null, 2));
}

// Deal a shuffled deck
function createShuffledDeck() {
  const suits = ['♠', '♣', '♥', '♦'];
  const values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (const s of suits) for (const v of values) deck.push({ suit: s, value: v });
  // simple Fisher–Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Compute blackjack score (Aces counted as 1 or 11)
function score(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (card.value === 'J' || card.value === 'Q' || card.value === 'K') total += 10;
    else if (card.value === 'A') { total += 11; aces += 1; }
    else total += card.value;
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Play a game of Blackjack')
    .addSubcommand(sub =>
      sub.setName('start')
         .setDescription('Start a new round')
         .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('hit')
         .setDescription('Draw another card')
    )
    .addSubcommand(sub =>
      sub.setName('stand')
         .setDescription('Stop and let dealer play')
    )
    .addSubcommand(sub =>
      sub.setName('balance')
         .setDescription('Check your current balance')
    ),

  async execute(interaction) {
    let balances = loadBalances();
    const userId = interaction.user.id;
    if (!(userId in balances)) balances[userId] = 1000; // starting balance

    const sub = interaction.options.getSubcommand();
    let game = games.get(userId);

    if (sub === 'balance') {
      await interaction.reply(`Your balance: $${balances[userId]}`);
      return;
    }

    if (sub === 'start') {
      const bet = interaction.options.getInteger('bet');
      if (bet <= 0 || bet > balances[userId]) {
        await interaction.reply({ content: 'Invalid bet amount.', ephemeral: true });
        return;
      }
      // Deduct bet and create game
      balances[userId] -= bet;
      game = {
        deck: createShuffledDeck(),
        hand: [],
        dealerHand: [],
        bet,
        done: false
      };
      // deal initial cards
      game.hand.push(game.deck.pop(), game.deck.pop());
      game.dealerHand.push(game.deck.pop());
      games.set(userId, game);
      saveBalances(balances);

      await interaction.reply(
        `Your hand: ${game.hand.map(c => c.value + c.suit).join(' ')} (Total: ${score(game.hand)})\n` +
        `Dealer: ${game.dealerHand.map(c => c.value + c.suit).join(' ')} …`
      );
      return;
    }

    if (!game) {
      await interaction.reply({ content: 'You have no active game. Use `/blackjack start`.', ephemeral: true });
      return;
    }

    const userScore = score(game.hand);
    if (userScore >= 21) game.done = true;

    if (sub === 'hit' && !game.done) {
      game.hand.push(game.deck.pop());
      const newScore = score(game.hand);
      if (newScore > 21) game.done = true;
      games.set(userId, game);
      await interaction.reply(
        `You hit: ${game.hand.map(c => c.value + c.suit).join(' ')} (Total: ${newScore})`
      );
      return;
    }

    // stand or auto-stand when done
    game.done = true;
    // dealer draws until 17+
    while (score(game.dealerHand) < 17) {
      game.dealerHand.push(game.deck.pop());
    }
    const dealerScore = score(game.dealerHand);
    const finalUser = score(game.hand);

    let result, payout;
    if (finalUser > 21 || dealerScore > finalUser && dealerScore <= 21) {
      result = 'You lose!';
      payout = 0;
    } else if (dealerScore === finalUser) {
      result = 'Push.';
      payout = game.bet; // return bet
    } else {
      result = 'You win!';
      payout = game.bet * 2;
    }

    balances[userId] += payout;
    saveBalances(balances);
    games.delete(userId);

    await interaction.reply(
      `Dealer hand: ${game.dealerHand.map(c => c.value + c.suit).join(' ')} (Total: ${dealerScore})\n` +
      `Your hand: ${game.hand.map(c => c.value + c.suit).join(' ')} (Total: ${finalUser})\n` +
      `${result} You now have $${balances[userId]}`
    );
  }
};

/*
Setup steps:
1. Install builder: npm install @discordjs/builders
2. Create an empty balances.json in the project root: {}
3. Ensure your bot registers this command via handleCommands
4. Enjoy Blackjack!*/
