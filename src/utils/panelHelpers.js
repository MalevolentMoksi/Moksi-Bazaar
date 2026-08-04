// src/utils/panelHelpers.js
/**
 * Shared pieces of the owner configuration panels.
 *
 * The join gate grew a perfectly good modal prompt helper, and the casino
 * panel needs the same one. Copying it would be the same mistake the sentiment
 * trend math made: two copies that drift until two panels behave differently
 * for no reason anyone remembers.
 */

const {
    ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

/** Discord rejects an over-long label outright, so clip rather than throw. */
function truncate(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Shows a modal from a component interaction and waits for the submission.
 *
 * @param {import('discord.js').MessageComponentInteraction} componentInteraction
 * @param {{title: string, inputs: object[], idPrefix?: string, timeoutMs?: number}} options
 * @returns {Promise<import('discord.js').ModalSubmitInteraction|null>} null on timeout
 */
async function promptModal(componentInteraction, { title, inputs, idPrefix = 'panel', timeoutMs = 300_000 }) {
    const modalId = `${idPrefix}_modal_${componentInteraction.id}`;
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(truncate(title, 45));

    for (const input of inputs) {
        const builder = new TextInputBuilder()
            .setCustomId(input.id)
            .setLabel(truncate(input.label, 45))
            .setStyle(input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(input.required ?? false);
        if (input.value !== undefined && input.value !== null) {
            builder.setValue(String(input.value).slice(0, 4000));
        }
        if (input.placeholder) builder.setPlaceholder(truncate(input.placeholder, 100));
        if (input.maxLength) builder.setMaxLength(input.maxLength);
        modal.addComponents(new ActionRowBuilder().addComponents(builder));
    }

    await componentInteraction.showModal(modal);
    try {
        return await componentInteraction.awaitModalSubmit({
            filter: m => m.customId === modalId && m.user.id === componentInteraction.user.id,
            time: timeoutMs,
        });
    } catch {
        return null; // timed out; the panel stays as it was
    }
}

module.exports = { promptModal, truncate };
