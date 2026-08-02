// src/events/client/guildMemberAdd.js
/**
 * Fires only for members joining right now — this is what keeps the join gate
 * from ever touching people who were already in the server.
 *
 * Requires the GuildMembers gateway intent (bot.js) and the "Server Members
 * Intent" toggle in the Discord Developer Portal. Without both, this event is
 * simply never delivered.
 */

const { handleMemberJoin } = require('../../utils/joinGate/enforcement');
const logger = require('../../utils/logger');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    try {
      await handleMemberJoin(member);
    } catch (error) {
      logger.error('guildMemberAdd handler failed', {
        guildId: member?.guild?.id,
        userId: member?.id,
        error: error.message,
        stack: error.stack,
      });
    }
  },
};
