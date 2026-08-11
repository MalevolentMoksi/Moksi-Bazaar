// src/utils/joinGate/reportActions.js
/**
 * The buttons on a filed report.
 *
 * A panel in a log channel outlives every collector in this bot. It is read
 * days later, after any number of deploys, and it still has to answer a click,
 * so these are routed by custom id from interactionCreate rather than owned by
 * whatever built them. Everything they need is either in the id or on file.
 *
 * The mark is a RECORD, not an undo. Pressing "not a spammer" writes down that
 * this score was wrong, so the weights have something to be tuned against for
 * the first time; it does not lift a timeout or unban anybody, because a
 * button that quietly reverses moderation is a different and much more
 * dangerous thing than a button that says "we were wrong here". It is
 * reversible in both directions, because moderators mis-click and because an
 * account that looked innocent at midnight sometimes does not at one.
 */

const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
    PermissionFlagsBits, MessageFlags,
} = require('discord.js');

const { markSuspicionReport, getSuspicionReport } = require('../db');
const { getSettings } = require('./config');
const { retireControls } = require('../ui/panel');
const { isOwner } = require('../constants');
const logger = require('../logger');

const MARK = 'jg_fp';
const COPY = 'jg_uid';

/** The mark button in whichever of its two states the report is in. */
function markButton(reportId, marked) {
    return new ButtonBuilder()
        .setCustomId(`${MARK}:${reportId}`)
        .setLabel(marked ? 'Marked not a spammer' : 'Not a spammer')
        .setStyle(marked ? ButtonStyle.Success : ButtonStyle.Secondary);
}

/**
 * The controls for a report panel.
 *
 * Any of the three can be absent: an old report has no row id, a purged
 * message has no link, and both cases must still produce a legal message.
 */
function reportRows({ reportId = null, userId = null, jumpUrl = null, marked = false } = {}) {
    const buttons = [];
    if (jumpUrl) {
        buttons.push(new ButtonBuilder()
            .setStyle(ButtonStyle.Link).setLabel('Jump to message').setURL(jumpUrl));
    }
    if (userId) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`${COPY}:${userId}`).setLabel('Copy user ID').setStyle(ButtonStyle.Secondary));
    }
    if (reportId) buttons.push(markButton(reportId, marked));
    return buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];
}

/** Ours to answer? Asked before the collector fallback claims it. */
function handles(customId) {
    const id = String(customId ?? '');
    return id.startsWith(`${MARK}:`) || id.startsWith(`${COPY}:`);
}

/**
 * Who may say a report was wrong.
 *
 * Unconfigured means anyone who can time members out, which is the same set of
 * people already reading the log channel: a button nobody can press is worse
 * than no button. Naming roles narrows that set; it never widens it.
 */
function mayMark(interaction, settings) {
    if (isOwner(interaction.user.id)) return true;
    const allowed = settings?.false_positive_role_ids ?? [];
    if (allowed.length) {
        const held = interaction.member?.roles?.cache;
        return Boolean(held && allowed.some(id => held.has(id)));
    }
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers));
}

/**
 * The action row on a posted panel, wherever Discord put it.
 *
 * Under Components V2 the row lives inside the container rather than at the
 * top level, and the replacement has to keep every button that is not the one
 * being toggled: the link button's URL is not recoverable from anywhere else.
 */
function existingRow(message) {
    const parts = (message?.components ?? [])
        .map(part => (typeof part.toJSON === 'function' ? part.toJSON() : part));
    for (const part of parts) {
        if (part?.type === ComponentType.ActionRow) return part;
        const nested = (part?.components ?? []).find(kid => kid?.type === ComponentType.ActionRow);
        if (nested) return nested;
    }
    return null;
}

/** The same row with the mark button swapped for its other state. */
function rowWithMark(message, reportId, marked) {
    const row = existingRow(message);
    const swapped = markButton(reportId, marked).toJSON();
    if (!row) return reportRows({ reportId, marked });
    return [{
        ...row,
        components: (row.components ?? []).map(button => (
            String(button?.custom_id ?? '').startsWith(`${MARK}:`) ? swapped : button
        )),
    }];
}

async function refuse(interaction, text) {
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    return true;
}

/**
 * @returns {Promise<boolean>} whether this interaction was ours
 */
async function handle(interaction) {
    if (!handles(interaction.customId)) return false;
    const [kind, arg] = String(interaction.customId).split(':');

    // The raw id and nothing else, so "copy message" on a phone yields
    // something that can be pasted into a ban field unedited.
    if (kind === COPY) {
        await interaction.reply({ content: arg, flags: MessageFlags.Ephemeral });
        return true;
    }

    const reportId = Number(arg);
    if (!Number.isInteger(reportId) || reportId <= 0) {
        return refuse(interaction, 'That button is older than the record it points at.');
    }

    try {
        const report = await getSuspicionReport(reportId);
        if (!report) return refuse(interaction, 'That report is no longer on file.');

        const settings = await getSettings(interaction.guildId).catch(() => null);
        if (!mayMark(interaction, settings)) {
            const allowed = settings?.false_positive_role_ids ?? [];
            return refuse(interaction, allowed.length
                ? `Only ${allowed.map(id => `<@&${id}>`).join(' or ')} can mark a report.`
                : 'Only staff who can time members out can mark a report.');
        }

        const marked = !report.false_positive;
        const updated = await markSuspicionReport(reportId, {
            falsePositive: marked, byId: interaction.user.id,
        });
        if (!updated) return refuse(interaction, 'That report is no longer on file.');

        await interaction.update(retireControls(interaction.message, rowWithMark(interaction.message, reportId, marked)));
        await interaction.followUp({
            content: marked
                ? `Recorded: score **${report.score}** on <@${report.user_id}> was wrong. `
                  + 'The weights have something to be tuned against now.\n'
                  + '-# This is a note, not an undo: any timeout or ban is still in place.'
                : 'Taken back. The report stands as filed.',
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        logger.info('[JOIN-GATE] Report marked', {
            reportId, marked, by: interaction.user.id, guildId: interaction.guildId,
        });
        return true;
    } catch (error) {
        logger.warn('[JOIN-GATE] Report button failed', { reportId, error: error.message });
        try {
            await refuse(interaction, 'Could not write that down; the record is unreachable right now.');
        } catch { /* the token may already be spent */ }
        return true;
    }
}

module.exports = { handles, handle, reportRows, mayMark, MARK, COPY };
