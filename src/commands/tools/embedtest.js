// src/commands/tools/embedtest.js
// Owner-only switchboard for the Components V2 rendering experiment.
//
// The point of `preview` is that nothing has to be turned on to judge it: it
// posts the same panel twice, once each way, in the channel you run it from.
// Flip a surface only once you have seen it.

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, MessageFlags,
} = require('discord.js');
const { isOwner, OWNER_REJECTION_JOKES } = require('../../utils/constants');
const { SCOPES, SCOPE_NAMES, allModes, setMode, setAllModes } = require('../../utils/ui/mode');
const { ui } = require('../../utils/ui/panel');

/**
 * One representative panel per surface, shaped like the real thing so the
 * comparison means something. Buttons are included where the real panel has
 * them, since "controls sit inside the box" is most of the difference.
 */
function sample(scope) {
    if (scope === 'casino') {
        return {
            embed: new EmbedBuilder()
                .setTitle('🎲 Blackjack')
                .setColor(0xc0392b)
                .addFields(
                    { name: 'Dealer (showing K)', value: 'K♠ 🂠' },
                    { name: 'Your hand (18)', value: 'Q♥ 8♣ · 500 ⛁' },
                    { name: 'On the table', value: '500 ⛁', inline: true },
                    { name: 'Balance', value: '12,340 ⛁', inline: true },
                )
                .setFooter({ text: 'This session: -1,250 ⛁' }),
            rows: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('embedtest:noop:hit').setLabel('Hit').setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId('embedtest:noop:stand').setLabel('Stand').setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId('embedtest:noop:again').setLabel('Again').setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId('embedtest:noop:out').setLabel('Cash out').setStyle(ButtonStyle.Danger).setDisabled(true),
            )],
        };
    }

    if (scope === 'speak') {
        return {
            embed: new EmbedBuilder()
                .setTitle('😐 Opinion on moksi')
                .setColor(0xf0b232)
                .setDescription('*"he\'s around constantly. i\'ve stopped noticing, which is probably the nicest thing i can say."*')
                .addFields(
                    { name: 'Attitude', value: 'FAMILIAR', inline: true },
                    { name: 'Sentiment', value: '+0.42', inline: true },
                    { name: 'Interactions', value: '1,204', inline: true },
                    { name: 'Last interaction', value: '"what about the blackjack? can it see it right?"' },
                )
                .setFooter({ text: 'Last seen' })
                .setTimestamp(new Date()),
            rows: [],
        };
    }

    if (scope === 'mod') {
        return {
            embed: new EmbedBuilder()
                .setTitle('🚪 Join gate')
                .setColor(0x5865f2)
                .addFields(
                    { name: 'Minimum age', value: '**30** days', inline: true },
                    { name: 'Dry run', value: '🔴 Off', inline: true },
                    { name: 'Bots', value: 'Exempt', inline: true },
                    { name: 'Exempt users', value: '4', inline: true },
                    { name: 'DM on removal', value: '🟢 On', inline: true },
                    { name: 'Catch-up sweep', value: '24h window', inline: true },
                    { name: 'Escalation', value: 'Ban after 3 attempts', inline: true },
                    { name: 'Lifetime', value: '312 gated', inline: true },
                ),
            rows: [],
        };
    }

    if (scope === 'media') {
        return {
            embed: new EmbedBuilder()
                .setTitle('🎞️ Media info')
                .setColor(0x1abc9c)
                .addFields(
                    { name: 'Format', value: 'mp4', inline: true },
                    { name: 'Duration', value: '00:14', inline: true },
                    { name: 'Size', value: '3.4 MB', inline: true },
                    { name: 'Resolution', value: '1280x720', inline: true },
                    { name: 'Video codec', value: 'h264', inline: true },
                    { name: 'Audio codec', value: 'aac', inline: true },
                ),
            rows: [],
        };
    }

    // misc
    return {
        embed: new EmbedBuilder()
            .setTitle('⏰ Reminder set')
            .setColor(0x9b59b6)
            .setDescription('You will be reminded about **the deploy** in 2 hours.')
            .addFields(
                { name: 'When', value: '<t:1786000000:R>', inline: true },
                { name: 'Where', value: 'here', inline: true },
            )
            .setFooter({ text: 'Reminder 4 of 6' }),
        rows: [],
    };
}

/** Renders the toggle state as a plain block, readable in either mode. */
function statusText(modes) {
    const lines = SCOPE_NAMES.map((name) => {
        const on = modes[name] ? 'components v2' : 'embeds';
        return `\`${name.padEnd(6)}\` ${on.padEnd(14)} ${SCOPES[name]}`;
    });
    const anyOn = SCOPE_NAMES.some(name => modes[name]);
    return `**Rendering per surface**\n${lines.join('\n')}\n\n`
        + (anyOn
            ? '-# Messages already sent keep the style they were born with. That is a Discord rule, not a choice.'
            : '-# Everything is on classic embeds. `/embedtest preview` shows a surface both ways without changing anything.');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('embedtest')
        .setDescription('secret')
        .addSubcommand(sub => sub
            .setName('preview')
            .setDescription('post a surface both ways, changing nothing')
            .addStringOption(opt => opt
                .setName('surface')
                .setDescription('which panel to compare')
                .setRequired(true)
                .addChoices(...SCOPE_NAMES.map(name => ({ name, value: name })))))
        .addSubcommand(sub => sub
            .setName('set')
            .setDescription('switch one surface between embeds and components v2')
            .addStringOption(opt => opt
                .setName('surface')
                .setDescription('which surface to switch')
                .setRequired(true)
                .addChoices(...SCOPE_NAMES.map(name => ({ name, value: name }))))
            .addBooleanOption(opt => opt
                .setName('v2')
                .setDescription('true for components v2, false for classic embeds')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('all')
            .setDescription('switch every surface at once')
            .addBooleanOption(opt => opt
                .setName('v2')
                .setDescription('true for components v2, false for classic embeds')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('status')
            .setDescription('what each surface is currently rendering as')),

    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();

        if (sub === 'preview') {
            const scope = interaction.options.getString('surface');
            const { embed, rows } = sample(scope);
            // Public on purpose: ephemeral replies render components differently
            // enough that judging them there would be misleading.
            await interaction.reply({
                content: `**${scope}** as it is today:`,
                ...ui(embed, rows, { mode: 'v1' }),
            });
            // The label has to be its own message: Components V2 refuses
            // `content` outright, so it cannot ride along with the panel.
            await interaction.followUp({ content: `**${scope}** as Components V2:` });
            return interaction.followUp(ui(embed, rows, { mode: 'v2' }));
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (sub === 'status') {
            return interaction.editReply(statusText(allModes()));
        }

        if (sub === 'all') {
            const on = interaction.options.getBoolean('v2');
            const modes = await setAllModes(on);
            return interaction.editReply(
                `Every surface is now on **${on ? 'Components V2' : 'classic embeds'}**.\n\n${statusText(modes)}`,
            );
        }

        // set
        const scope = interaction.options.getString('surface');
        const on = interaction.options.getBoolean('v2');
        const modes = await setMode(scope, on);
        return interaction.editReply(
            `\`${scope}\` is now on **${on ? 'Components V2' : 'classic embeds'}**.\n\n${statusText(modes)}`,
        );
    },
};
