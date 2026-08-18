// src/events/client/messageUpdate.js
/**
 * The watch window's second ear.
 *
 * messageCreate sees a message as it was born. The classic evasion is to be
 * born harmless: post "hi", wait out the first glance, then edit the payload
 * in. This hands the edited message to the same watch pipeline the create
 * path uses; enforcement decides whether anyone is even being watched before
 * a partial is fetched, so for everyone else an edit costs one map lookup.
 *
 * Deliberately narrow: this is not an edit log, not an automod, and it never
 * looks at anyone outside the join-gate watch window.
 */
const logger = require('../../utils/logger');
const { handleWatchedEdit } = require('../../utils/joinGate/enforcement');

module.exports = {
    name: 'messageUpdate',
    async execute(oldMessage, newMessage) {
        try {
            await handleWatchedEdit(oldMessage, newMessage);
        } catch (error) {
            logger.error('Join gate edit handler failed', { error: error.message });
        }
    },
};
