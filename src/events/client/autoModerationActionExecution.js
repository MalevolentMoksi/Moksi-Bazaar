// src/events/client/autoModerationActionExecution.js
/**
 * Discord's own AutoMod, telling us what it just blocked.
 *
 * This listens and never writes. It does not create, edit, read back or disable
 * a single AutoMod rule; the server owner's rules are theirs, and several of
 * them (a slur list, a politics list, an allow-rule for a Spanish word that was
 * being caught wrongly) represent decisions this bot has no business revisiting.
 *
 * What it adds is correlation. AutoMod blocks a message knowing nothing about
 * who sent it; the join gate knows the sender arrived six minutes ago. Neither
 * half is worth much alone.
 */

const logger = require('../../utils/logger');
const { handleAutoModAction } = require('../../utils/joinGate/enforcement');

module.exports = {
    name: 'autoModerationActionExecution',
    async execute(execution) {
        try {
            await handleAutoModAction(execution);
        } catch (error) {
            logger.error('AutoMod action handler failed', { error: error.message });
        }
    },
};
