// src/commands/tools/shop.js
/**
 * The shop and the collection: where currency finally leaves the economy.
 *
 * Buying is one transaction in the database (charge and grant together), so a
 * failure between the two cannot take money without handing over the goods.
 * See utils/db.js purchaseItem.
 */

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
    ButtonBuilder, ButtonStyle, ComponentType, MessageFlags,
} = require('discord.js');
const { getBalance, getInventory, purchaseItem } = require('../../utils/db');
const { ui, retireControls } = require('../../utils/ui/panel');
const {
    TIERS, TIER_ORDER, ITEMS, getItem, priceOf, bestTitle,
} = require('../../utils/shopCatalogue');
const { EMBED_COLORS } = require('../../utils/constants');
const logger = require('../../utils/logger');
const { money } = require('../../utils/money');
const { NOT_YOUR_PANEL } = require('../../utils/gameHelpers');

const BROWSE_TIMEOUT_MS = 180_000;
/** How long a "buy this?" waits before it counts as a no. */
const CONFIRM_TIMEOUT_MS = 60_000;

// ── Shop ────────────────────────────────────────────────────────────────────

function shopEmbed(balance, ownedIds) {
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.INFO)
        .setTitle("🏛️ Moksi's Bazaar")
        .setDescription(
            'Nothing here does anything. That is the point: it is the only way '
            + `money ever leaves this server.\nYou have **${money(balance)}**.`
        );

    for (const tier of TIER_ORDER) {
        const items = ITEMS.filter(i => i.tier === tier);
        if (!items.length) continue;
        embed.addFields({
            name: `${TIERS[tier].label} · ${money(TIERS[tier].price)}`,
            value: items.map(i =>
                `${ownedIds.has(i.id) ? '✅' : i.emoji} **${i.name}**\n-# ${i.blurb}`
            ).join('\n'),
            inline: false,
        });
    }

    const owned = ITEMS.filter(i => ownedIds.has(i.id)).length;
    embed.setFooter({ text: `You own ${owned} of ${ITEMS.length}` });
    return embed;
}

function shopRows(balance, ownedIds) {
    // One menu, every item. The catalogue is deliberately kept under the
    // twenty-five option ceiling so browsing never needs pagination.
    const options = ITEMS.map(item => {
        const price = priceOf(item);
        const owned = ownedIds.has(item.id);
        const affordable = balance >= price;
        const note = owned && item.unique ? 'owned'
            : owned ? `owned · ${money(price)} for another`
                : affordable ? money(price)
                    : `${money(price)} · cannot afford`;
        return {
            label: item.name.slice(0, 100),
            value: item.id,
            description: `${TIERS[item.tier].label} · ${note}`.slice(0, 100),
            emoji: item.emoji,
        };
    });

    return [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('shop_buy')
            .setPlaceholder('Buy something')
            .addOptions(options)
    )];
}

/**
 * Asks, privately, whether to go through with a purchase.
 *
 * @param {import('discord.js').StringSelectMenuInteraction} selection the pick
 * @returns {Promise<{choice: 'buy'|'cancel'|'timeout', answer: (text: string) => Promise<unknown>}>}
 *   `answer` replaces the question, buttons and all, so a stale Buy can never
 *   be pressed twice.
 */
async function askToBuy(selection, item, price, balance) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('shop_confirm')
            .setLabel(`Buy for ${money(price)}`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('shop_cancel')
            .setLabel('Leave it').setStyle(ButtonStyle.Secondary),
    );
    const response = await selection.reply({
        content: `${item.emoji} **${item.name}** for **${money(price)}**?\n`
            + `-# ${item.blurb}\n-# You would have ${money(balance - price)} left.`,
        components: [row],
        flags: MessageFlags.Ephemeral,
        withResponse: true,
    });
    const prompt = response?.resource?.message ?? await selection.fetchReply();

    let button = null;
    try {
        button = await prompt.awaitMessageComponent({
            componentType: ComponentType.Button,
            time: CONFIRM_TIMEOUT_MS,
        });
        await button.deferUpdate();
    } catch {
        // Nobody answered. Walking away is a no.
    }

    const choice = !button ? 'timeout' : button.customId === 'shop_confirm' ? 'buy' : 'cancel';
    const answer = text => selection.editReply({ content: text, components: [] }).catch(() => null);
    return { choice, answer };
}

async function runShop(interaction) {
    const userId = interaction.user.id;
    let balance = await getBalance(userId);
    let ownedIds = new Set((await getInventory(userId)).map(i => i.itemId));

    const message = await interaction.editReply(
        ui(shopEmbed(balance, ownedIds), shopRows(balance, ownedIds), { scope: 'casino' }),
    );

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: BROWSE_TIMEOUT_MS,
    });

    /**
     * Redraws the panel from fresh numbers. Also what puts the menu back to
     * its placeholder: Discord leaves the last pick showing in the picker's
     * own client until the message changes.
     */
    const redraw = async () => {
        balance = await getBalance(userId);
        ownedIds = new Set((await getInventory(userId)).map(inv => inv.itemId));
        await message.edit(
            ui(shopEmbed(balance, ownedIds), shopRows(balance, ownedIds), { like: message }),
        );
    };

    collector.on('collect', async i => {
        try {
            if (i.user.id !== userId) {
                return i.reply({ content: NOT_YOUR_PANEL, flags: MessageFlags.Ephemeral });
            }

            const item = getItem(i.values[0]);
            if (!item) return i.deferUpdate();
            const price = priceOf(item);

            // The two answers that need no question. Asking "buy this?" about
            // something that cannot be bought would only add a click to a no.
            if (item.unique && ownedIds.has(item.id)) {
                await i.reply({ content: `${item.emoji} **${item.name}** is already yours. There is only one.`, flags: MessageFlags.Ephemeral });
                return redraw();
            }
            if (balance < price) {
                await i.reply({
                    content: `${item.emoji} **${item.name}** is ${money(price)}. You have ${money(balance)}.`,
                    flags: MessageFlags.Ephemeral,
                });
                return redraw();
            }

            // A select menu buys on a single pick, which made one slip of the
            // wheel a $1,000,000 purchase. Everything asks first now.
            const prompt = await askToBuy(i, item, price, balance);
            if (prompt.choice !== 'buy') {
                await prompt.answer(`${item.emoji} Left it on the shelf.`);
                return redraw();
            }

            const result = await purchaseItem(userId, item.id, price, { unique: item.unique });
            if (!result.ok) {
                await prompt.answer(`${item.emoji} ${result.error}`);
                return redraw();
            }

            logger.info('Shop purchase', { userId, itemId: item.id, price });
            await prompt.answer(
                `${item.emoji} **${item.name}** is yours. ${money(result.balance)} left.`
                    + (item.title ? `\n-# You may now be addressed as **${item.title}**.` : ''),
            );
            return redraw();
        } catch (error) {
            logger.error('Shop error', { error: error.message, stack: error.stack });
        }
    });

    collector.on('end', async (_c, reason) => {
        if (reason !== 'time') return;
        try { await message.edit(retireControls(message)); } catch { /* message may be gone */ }
    });
}

// ── Collection ──────────────────────────────────────────────────────────────

async function renderCollection(interaction, target) {
    const inventory = await getInventory(target.id);
    if (!inventory.length) {
        return interaction.editReply(
            target.id === interaction.user.id
                ? 'You own nothing. `/shop` sells nothing useful, if you are interested.'
                : `${target.username} owns nothing.`
        );
    }

    const owned = new Map(inventory.map(i => [i.itemId, i.quantity]));
    const spent = inventory.reduce((sum, inv) => {
        const item = getItem(inv.itemId);
        return sum + (item ? priceOf(item) * inv.quantity : 0);
    }, 0);

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.INFO)
        .setTitle(`${target.username}'s collection`)
        .setThumbnail(target.displayAvatarURL());

    for (const tier of [...TIER_ORDER].reverse()) {
        const items = ITEMS.filter(i => i.tier === tier && owned.has(i.id));
        if (!items.length) continue;
        embed.addFields({
            name: TIERS[tier].label,
            value: items.map(i => {
                const qty = owned.get(i.id);
                return `${i.emoji} **${i.name}**${qty > 1 ? ` ×${qty}` : ''}`;
            }).join('\n'),
            inline: false,
        });
    }

    const distinct = ITEMS.filter(i => owned.has(i.id)).length;
    const title = bestTitle([...owned.keys()]);
    embed.setDescription(
        `${distinct} of ${ITEMS.length} pieces, ${money(spent)} sunk into things that do nothing.`
        + (title ? `\nCarries the title **${title}**.` : '')
    );

    return interaction.editReply(ui(embed, [], { scope: 'casino' }));
}

// ── Commands ────────────────────────────────────────────────────────────────

module.exports = [
    {
        data: new SlashCommandBuilder()
            .setName('shop')
            .setDescription('Spend your money on things that do nothing'),
        async execute(interaction) {
            await interaction.deferReply();
            return runShop(interaction);
        },
    },
    {
        data: new SlashCommandBuilder()
            .setName('collection')
            .setDescription('What you have bought')
            .addUserOption(opt => opt
                .setName('user').setDescription('whose collection (default: yours)')),
        async execute(interaction) {
            await interaction.deferReply();
            const target = interaction.options.getUser('user') ?? interaction.user;
            if (target.bot) return interaction.editReply('I keep my things behind the counter.');
            return renderCollection(interaction, target);
        },
    },
];
