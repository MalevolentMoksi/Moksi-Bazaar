// src/commands/tools/bj.js
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

// Track active games by userId
const games = new Map();

// Card definitions
const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const CARDS = [
  { label: 'A', value: 11 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
  { label: '9', value: 9 },
  { label: '10', value: 10 },
  { label: 'J', value: 10 },
  { label: 'Q', value: 10 },
  { label: 'K', value: 10 }
];

// Draw a single random card
const drawCard = () => {
  const card = CARDS[Math.floor(Math.random() * CARDS.length)];
  const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
  return { ...card, display: `${card.label}${suit}` };
};

// Calculate hand total with dynamic Aces
const calculateTotal = (cards) => {
  let total = cards.reduce((sum, c) => sum + c.value, 0);
  let aces = cards.filter((c) => c.label === 'A').length;
  while (total > 21 && aces) {
    total -= 10;
    aces--;
  }
  return total;
};

const isBlackjack = (cards) => cards.length === 2 && calculateTotal(cards) === 21;

/**
 * Dealer draws until they reach 17 or higher.
 */
function playDealer(dealerCards) {
  while (calculateTotal(dealerCards) < 17) {
    dealerCards.push(drawCard());
  }
}

/**
 * Kick off a fresh blackjack hand, editing in place if `interaction` is a ButtonInteraction,
 * or replying if it's a ChatInputCommandInteraction.
 */
async function startHand(interaction, userId, bet, mention) {
  let bal = await getBalance(userId);
  bal -= bet;
  await updateBalance(userId, bal);

  const playerCards = [drawCard(), drawCard()];
  const dealerCards = [drawCard(), drawCard()];

  const actionRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId(`hit_${userId}`).setLabel('Hit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`stand_${userId}`).setLabel('Stand').setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`double_${userId}`)
        .setLabel(`Double ($${bet})`)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(bal < bet)
    );

  games.set(userId, {
    bet,
    originalBet: bet,        // ← save the user's *initial* wager
    bal,
    playerCards,
    dealerCards,
    doubled: false,
    firstAction: true,
    actionRow
  });

  const content =
    `${mention}, wagered $${bet}.\n` +
    `**Your hand:** [${playerCards.map(c=>c.display).join(', ')}] (${calculateTotal(playerCards)})\n` +
    `**Dealer shows:** [${dealerCards[0].display}, ?]`;

  const isBtn = typeof interaction.isButton === 'function' && interaction.isButton();
  if (isBtn) {
    // update in-place for button clicks
    await interaction.update({ content, components: [actionRow] });
    return interaction.message;
  } else {
    // reply (slash or prefix) for new games
    // note: fetchReply is used by real slash interactions only
    return interaction.reply({ content, components: [actionRow], fetchReply: true });
  }
}

/**
 * Attach button collector to handle game interactions
 */
function attachCollector(msg, userId, mention) {
  // MAIN collector: only listen for hit_/stand_/double_ buttons
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120000,
    filter: (i) =>
      i.user.id === userId &&
      (i.customId.startsWith(`hit_${userId}`) ||
       i.customId.startsWith(`stand_${userId}`) ||
       i.customId.startsWith(`double_${userId}`))
  });

  collector.on('collect', async i => {
    // as soon as we collect, we know this collector is now "used up" once the hand ends
    let ended = false;
    await i.deferUpdate();
    let game = games.get(userId);
    if (!game) return;

    // pull out both the current bet (for resolution) AND the originalBet (for re-play)
    let { bet, originalBet, bal, playerCards, dealerCards, doubled, firstAction, actionRow } = game;

    // Double
    if (i.customId === `double_${userId}` && !doubled && firstAction) {
      if (bal < bet) return i.followUp({ content: `${mention}, insufficient funds to double.`, ephemeral: true });
      bal -= bet;
      await updateBalance(userId, bal);
      bet *= 2;
      doubled = true;
      playerCards.push(drawCard());
      firstAction = false;
      playDealer(dealerCards);
    }

    // Hit
    else if (i.customId === `hit_${userId}`) {
      playerCards.push(drawCard());
      firstAction = false;
      actionRow.components[2].setDisabled(true); // disable double after first hit
      if (calculateTotal(playerCards) <= 21) {
        // Include actionRow in updated game state
        games.set(userId, { bet, bal, playerCards, dealerCards, doubled, firstAction, actionRow });
        return i.editReply({
          content:
            `${mention}, drew ${playerCards[playerCards.length - 1].display}.\n` +
            `**Your hand:** [${playerCards.map((c) => c.display).join(', ')}] (${calculateTotal(playerCards)})\n` +
            `**Dealer shows:** [${dealerCards[0].display}, ?]`,
          components: [actionRow]
        });
      }
    }

    // Stand or bust or double resolution path (common)
    if (i.customId === `stand_${userId}` || calculateTotal(playerCards) > 21 || doubled) {
      playDealer(dealerCards);
    }

    const playerTotal = calculateTotal(playerCards);
    const dealerTotal = calculateTotal(dealerCards);
    let payout = 0;
    let result;
    if (playerTotal > 21) {
      result = `Bust — you lose $${bet}.`;
    } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
      payout = bet * 2;
      result = `You win $${payout}!`;
    } else if (playerTotal === dealerTotal) {
      payout = bet;
      result = `Push — $${bet} returned.`;
    } else {
      result = `Dealer wins — you lose $${bet}.`;
    }

    bal += payout;
    await updateBalance(userId, bal);
    games.delete(userId);
    // STOP the main collector—this hand is done
    collector.stop();

    actionRow.components.forEach(b => b.setDisabled(true));

    const playAgainRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`playagain_${userId}`)
        .setLabel('Play Again')
        .setStyle(ButtonStyle.Success)
    );

    await i.editReply({
      content:
        `${mention}, **Final Hands**\n` +
        `• You: [${playerCards.map((c) => c.display).join(', ')}] (${playerTotal})\n` +
        `• Dealer: [${dealerCards.map((c) => c.display).join(', ')}] (${dealerTotal})\n` +
        `${result} Balance: $${bal}.`,
      components: [playAgainRow]
    });

    // NOW attach the Play-Again–only collector
    const againCollector = i.message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000,
      max: 1,    // ← stop after one click
      filter: btn =>
        btn.user.id === userId &&
        btn.customId === `playagain_${userId}`
    });

    againCollector.on('collect', async btn => {
      // 1) Check funds
      let currentBal = await getBalance(userId);
      if (currentBal < bet) {
        return btn.reply({ content: `❌ You need $${bet} to play again.`, ephemeral: true });
      }
      // 2) Tear down old game and start a fresh one at the *original* wager
      games.delete(userId);
      const newMsg = await startHand(btn, userId, originalBet, mention);
      // 3) Re-attach collector to the updated message
      attachCollector(newMsg, userId, mention);
    });
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bj')
    .setDescription('Play blackjack with interactive buttons')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start a new game')
        .addIntegerOption((opt) =>
          opt.setName('bet').setDescription('Amount to wager').setRequired(true)
        )
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const mention = interaction.user.toString();
    if (interaction.options.getSubcommand() !== 'start') return;

    // Prevent concurrent games
    if (games.has(userId)) {
      return interaction.reply({ content: `${mention}, you already have an active game.`, ephemeral: true });
    }

    // Validate bet
    const bet = interaction.options.getInteger('bet');
    let bal = await getBalance(userId);
    if (bet <= 0 || bet > bal) {
      return interaction.reply({ content: `${mention}, invalid bet.`, ephemeral: true });
    }

    const msg = await startHand(interaction, userId, bet, mention);
    attachCollector(msg, userId, mention);
  }
};
