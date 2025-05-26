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
    if (bet <= 0) return interaction.reply({ content: `${mention}, bet must be > 0.`, ephemeral: true });
    if (bet > bal) return interaction.reply({ content: `${mention}, insufficient funds.`, ephemeral: true });

    // Debit bet
    bal -= bet;
    await updateBalance(userId, bal);

    // Deal
    const playerCards = [drawCard(), drawCard()];
    const dealerCards = [drawCard(), drawCard()];
    games.set(userId, { bet, bal, playerCards, dealerCards, doubled: false, firstAction: true });

    const playerBJ = isBlackjack(playerCards);
    const dealerBJ = isBlackjack(dealerCards);

    if (playerBJ || dealerBJ) {
      let payout = 0;
      let msg;
      if (playerBJ && dealerBJ) {
        payout = bet;
        msg = 'Push — both blackjack.';
      } else if (playerBJ) {
        payout = bet + Math.floor(bet * 1.5);
        msg = `Blackjack! You win $${payout - bet}.`;
      } else {
        msg = `Dealer blackjack — you lose $${bet}.`;
      }
      bal += payout;
      await updateBalance(userId, bal);
      games.delete(userId);
      return interaction.reply({
        content:
          `${mention}, **Final Hands**\n` +
          `• You: [${playerCards.map((c) => c.display).join(', ')}] (${calculateTotal(playerCards)})\n` +
          `• Dealer: [${dealerCards.map((c) => c.display).join(', ')}] (${calculateTotal(dealerCards)})\n` +
          `${msg} Balance: $${bal}.`
      });
    }

    // Build buttons
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hit_${userId}`).setLabel('Hit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`stand_${userId}`).setLabel('Stand').setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`double_${userId}`)
        .setLabel(`Double ($${bet})`)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(bal < bet)
    );

    const reply = await interaction.reply({
      content:
        `${mention}, wagered $${bet}.\n` +
        `**Your hand:** [${playerCards.map((c) => c.display).join(', ')}] (${calculateTotal(playerCards)})\n` +
        `**Dealer shows:** [${dealerCards[0].display}, ?]`,
      components: [actionRow],
      fetchReply: true
    });

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 120000,
      filter: (i) => i.user.id === userId
    });

    // Helper: finish dealer hand (stand on every 17)
    const playDealer = (dCards) => {
      while (calculateTotal(dCards) < 17) {
        dCards.push(drawCard());
      }
    };

    collector.on('collect', async (i) => {
      await i.deferUpdate();
      let game = games.get(userId);
      if (!game) return;

      let { bet, bal, playerCards, dealerCards, doubled, firstAction } = game;

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
          games.set(userId, { bet, bal, playerCards, dealerCards, doubled, firstAction });
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
      actionRow.components.forEach((b) => b.setDisabled(true));

      return i.editReply({
        content:
          `${mention}, **Final Hands**\n` +
          `• You: [${playerCards.map((c) => c.display).join(', ')}] (${playerTotal})\n` +
          `• Dealer: [${dealerCards.map((c) => c.display).join(', ')}] (${dealerTotal})\n` +
          `${result} Balance: $${bal}.`,
        components: [actionRow]
      });
    });

    collector.on('end', () => {
      const game = games.get(userId);
      if (!game) return; // already finished
      games.delete(userId);
    });
  }
};
