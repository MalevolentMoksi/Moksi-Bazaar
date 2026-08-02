// src/events/client/inviteSync.js
/**
 * Keeps the join gate's invite-use cache in step with reality.
 *
 * Working out which invite a member used means diffing cached use counts, so
 * the cache has to be re-synced whenever the invite list itself changes.
 * Without this, a code created after startup looks brand new on first use and
 * the join is attributed to nothing.
 *
 * Exports two handlers from one file; handleEvents.js accepts an array.
 */

const { syncGuild } = require('../../utils/joinGate/invites');
const logger = require('../../utils/logger');

async function resync(invite, label) {
  try {
    if (invite?.guild) await syncGuild(invite.guild);
  } catch (error) {
    logger.debug('Invite cache resync failed', { event: label, error: error.message });
  }
}

module.exports = [
  {
    name: 'inviteCreate',
    async execute(invite) { await resync(invite, 'inviteCreate'); },
  },
  {
    name: 'inviteDelete',
    async execute(invite) { await resync(invite, 'inviteDelete'); },
  },
];
