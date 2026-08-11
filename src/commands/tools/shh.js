// src/commands/tools/shh.js
// Owner-only lever that forces the speak pipeline to interject unprompted,
// as if the organic interjection gauntlet in messageCreate.js had rolled in
// its favor. No allowlist, cooldown, or chance check: the owner is forcing it.

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const { isOwner, OWNER_REJECTION_JOKES } = require('../../utils/constants');
const logger = require('../../utils/logger');

/**
 * Compatibility interaction for speak.execute, modeled on the shim in
 * src/events/client/messageCreate.js. Differences: this is always an
 * interjection, and there is no _sourceMessage (nothing is being replied to),
 * so delivery goes through targetChannel.send instead of message.reply.
 */
function buildInterjectionInteraction(interaction, targetChannel, angle) {
    const compat = {
        user: interaction.user,
        member: interaction.member,
        guild: targetChannel.guild ?? interaction.guild,
        guildId: targetChannel.guild?.id ?? interaction.guildId,
        channel: targetChannel,
        channelId: targetChannel.id,
        client: interaction.client,
        commandName: 'speak',
        options: {
            getString: () => null,
        },
        _interjection: true,
        deferred: false,
        replied: false,
        _lastReply: null,

        async deferReply() {
            this.deferred = true;
            // A single shot is enough here: the beat loop in speak.js refreshes
            // the indicator itself between multi-message parts.
            targetChannel.sendTyping().catch(() => {});
        },
        async _send(resp) {
            const payload = typeof resp === 'string' ? { content: resp } : { ...resp };
            // Nothing sent to a channel can be ephemeral, and the error helpers
            // pass that flag; the API rejects it on regular messages.
            delete payload.flags;
            // The bot is butting in uninvited; pinging anyone would be obnoxious.
            payload.allowedMentions = { repliedUser: false, parse: [] };
            const msg = await targetChannel.send(payload);
            this._lastReply = msg;
            return msg;
        },
        async reply(resp) {
            this.replied = true;
            return this._send(resp);
        },
        async editReply(resp) {
            // Same normalization as _send: an error helper editing the last
            // beat may carry an Ephemeral flag, which the API rejects on
            // regular channel messages.
            const payload = typeof resp === 'string' ? { content: resp } : { ...resp };
            delete payload.flags;
            if (this._lastReply) return this._lastReply.edit(payload);
            this.replied = true;
            return this._send(payload);
        },
        async followUp(resp) {
            return this._send(resp);
        },
        async fetchReply() {
            return this._lastReply;
        }
    };
    if (angle) compat._interjectionAngle = angle;
    return compat;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shh')
        .setDescription('Make the bot interject here, unprompted')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(opt =>
            opt.setName('angle')
                .setDescription('a nudge about what to react to')
                .setRequired(false))
        .addChannelOption(opt =>
            opt.setName('channel')
                .setDescription('where to interject (default: here)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)),

    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!targetChannel?.isTextBased?.() || typeof targetChannel.send !== 'function') {
            return interaction.editReply('That channel cannot be spoken in.');
        }

        const angle = interaction.options.getString('angle')?.trim() || null;

        const speakCmd = interaction.client.commands.get('speak');
        if (!speakCmd?.execute) {
            return interaction.editReply('The speak command is not loaded; nothing to drive.');
        }

        const compat = buildInterjectionInteraction(interaction, targetChannel, angle);

        try {
            await speakCmd.execute(compat, interaction.client);
        } catch (err) {
            logger.error('Forced interjection failed', {
                error: err.message,
                channelId: targetChannel.id,
            });
            return interaction.editReply(`Interjection failed: ${err.message || err}`);
        }

        // speak.js bails silently on interjections it refuses (maintenance
        // mode, blacklist); surface that instead of a false "done".
        if (!compat._lastReply) {
            return interaction.editReply('Nothing was sent: the speak pipeline refused (maintenance mode?) or the send failed.');
        }

        // Echo what actually landed rather than claiming success: if the
        // pipeline errored after acking, what posted is its error text, and
        // the owner should see that here instead of a false "done".
        const sentText = (compat._lastReply.content || '(no text)').replace(/\s+/g, ' ').trim();
        const snippet = sentText.length > 120 ? `${sentText.slice(0, 120)}...` : sentText;
        return interaction.editReply(`Sent in ${targetChannel}: "${snippet}"`);
    },
};
