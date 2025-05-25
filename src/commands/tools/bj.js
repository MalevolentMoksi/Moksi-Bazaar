const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

// Track active games by userId
const games = new Map();

// Suits for card display
const SUITS = ['♠️','♥️','♦️','♣️'];

// Draw a card: returns { value:number, display:string }
const drawCard = () => {
  // Numeric cards 2–10, plus A, J, Q, K treated as 11 (simplified)
  const cards = [
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
  const card = cards[Math.floor(Math.random() * cards.length)];
  const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
  return { value: card.value, display: `${card.label}${suit}` };
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bj')
    .setDescription('Play blackjack with interactive buttons')
    .addSubcommand(subcmd =>
      subcmd
        .setName('start')
        .setDescription('Start a new blackjack game')
        .addIntegerOption(opt =>
          opt
            .setName('bet')
            .setDescription('Amount to wager')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const mention = interaction.user.toString();
    const sub = interaction.options.getSubcommand();

    if (sub !== 'start') return;
    if (games.has(userId)) {
      return interaction.reply({ content: `${mention}, you already have an active game!`, ephemeral: true });
    }

    const bet = interaction.options.getInteger('bet');
    let bal = await getBalance(userId);

    if (bet <= 0) {
      return interaction.reply({ content: `${mention}, your bet must be greater than 0.`, ephemeral: true });
    }
    if (bet > bal) {
      return interaction.reply({ content: `${mention}, you only have $${bal} to bet.`, ephemeral: true });
    }

    // Deduct bet immediately
    bal -= bet;
    await updateBalance(userId, bal);

    // Initial deal
    const playerCards = [drawCard(), drawCard()];
    const dealerCards = [drawCard(), drawCard()];
    games.set(userId, { bet, bal, playerCards, dealerCards, doubled: false });

    const sumCards = cards => cards.reduce((sum, c) => sum + c.value, 0);
    let playerSum = sumCards(playerCards);

    // Buttons
    const canDouble = bal >= bet;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hit_${userId}`).setLabel('Hit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`stand_${userId}`).setLabel('Stand').setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`double_${userId}`)
        .setLabel(`Double Down ($${bet})`)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!canDouble)
    );

    const content =
      `${mention}, you’ve wagered $${bet}.\n` +
      `**Your hand:** [${playerCards.map(c => c.display).join(', ')}] (total **${playerSum}**)\n` +
      `**Dealer shows:** [${dealerCards[0].display}, ?]`;

    const message = await interaction.reply({ content, components: [row], fetchReply: true });

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 120000,
      filter: i => i.user.id === userId
    });

    collector.on('collect', async i => {
      await i.deferUpdate();
      const game = games.get(userId);
      if (!game) {
        return i.followUp({ content: `${mention}, no active game. Use /bj start.`, ephemeral: true });
      }

      let { bet, bal, playerCards, dealerCards, doubled } = game;
      const sumCards = cards => cards.reduce((sum, c) => sum + c.value, 0);

      // Double Down
      if (i.customId === `double_${userId}` && !doubled) {
        if (bal < bet) {
          return i.followUp({ content: `${mention}, insufficient funds.`, ephemeral: true });
        }
        bal -= bet;
        await updateBalance(userId, bal);
        bet *= 2;
        doubled = true;

        playerCards.push(drawCard());
        playerSum = sumCards(playerCards);

        let dealerSum = sumCards(dealerCards);
        while (dealerSum < 17) {
          dealerCards.push(drawCard());
          dealerSum = sumCards(dealerCards);
        }

        let payout = 0;
        let resultMsg;
        if (playerSum > 21) {
          resultMsg = `Bust—dealer wins. You lose $${bet}.`;
        } else if (dealerSum > 21 || playerSum > dealerSum) {
          payout = bet * 2;
          resultMsg = `You win $${payout}!`;
        } else if (playerSum === dealerSum) {
          payout = bet;
          resultMsg = `Push—your $${bet} returned.`;
        } else {
          resultMsg = `Dealer wins. You lose $${bet}.`;
        }

        bal += payout;
        await updateBalance(userId, bal);
        games.delete(userId);
        row.components.forEach(b => b.setDisabled(true));

        return i.editReply({
          content:
            `${mention}, **Final Hands**\n` +
            `• You:    [${playerCards.map(c => c.display).join(', ')}] (total **${playerSum}**)\n` +
            `• Dealer: [${dealerCards.map(c => c.display).join(', ')}] (total **${dealerSum}**)\n` +
            `${resultMsg} Your new balance is $${bal}.`,
          components: [row]
        });
      }

      // Hit
      if (i.customId === `hit_${userId}` && !doubled) {
        const card = drawCard();
        playerCards.push(card);
        playerSum = sumCards(playerCards);

        if (playerSum > 21) {
          games.delete(userId);
          row.components.forEach(b => b.setDisabled(true));
          return i.editReply({
            content:
              `${mention}, you drew ${card.display}.\n` +
              `**Your hand:** [${playerCards.map(c => c.display).join(', ')}] (total **${playerSum}**) — busted!\n` +
              `You lose $${bet}. Balance: $${bal}.`,
            components: [row]
          });
        }

        games.set(userId, { bet, bal, playerCards, dealerCards, doubled });
        return i.editReply({
          content:
            `${mention}, you drew ${card.display}.\n` +
            `**Your hand:** [${playerCards.map(c => c.display).join(', ')}] (total **${playerSum}**)\n` +
            `Use the buttons to continue.`,
          components: [row]
        });
      }

      // Stand
      if (i.customId === `stand_${userId}`) {
        let dealerSum = sumCards(dealerCards);
        while (dealerSum < 17) {
          dealerCards.push(drawCard());
          dealerSum = sumCards(dealerCards);
        }
        playerSum = sumCards(playerCards);

        let payout = 0;
        let resultMsg;
        if (playerSum > 21) {
          resultMsg = `Bust—dealer wins. You lose $${bet}.`;
        } else if (dealerSum > 21 || playerSum > dealerSum) {
          payout = bet * 2;
          resultMsg = `You win $${payout}!`;
        } else if (playerSum === dealerSum) {
          payout = bet;
          resultMsg = `Push—your $${bet} returned.`;
        } else {
          resultMsg = `Dealer wins. You lose $${bet}.`;
        }

        bal += payout;
        await updateBalance(userId, bal);
        games.delete(userId);
        row.components.forEach(b => b.setDisabled(true));

        return i.editReply({
          content:
            `${mention}, **Final Hands**\n` +
            `• You:    [${playerCards.map(c => c.display).join(', ')}] (total **${playerSum}**)\n` +
            `• Dealer: [${dealerCards.map(c => c.display).join(', ')}] (total **${dealerSum}**)\n` +
            `${resultMsg} Your new balance is $${bal}.`,
          components: [row]
        });
      }
    });
  }
};