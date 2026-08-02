// src/utils/joinGate/index.js
/**
 * Join Gate — account-age auto-kicker.
 *
 * Removes NEW members whose Discord account is younger than a per-server
 * threshold. Kicks are rejoinable by design; repeat rejoiners can optionally be
 * temp-banned until the exact moment their account becomes old enough.
 *
 * Requires the privileged "Server Members Intent" (Developer Portal) and the
 * `GuildMembers` gateway intent in bot.js. Without it `guildMemberAdd` never
 * fires and the gate silently does nothing — /joingate → Diagnostics says so.
 *
 * Entry points:
 *   - events/client/guildMemberAdd.js  → handleMemberJoin()
 *   - events/client/ready.js           → initJoinGate()
 *   - commands/tools/joinGate.js       → the configuration panel
 */

const { GatewayIntentBits } = require('discord.js');
const logger = require('../logger');
const config = require('./config');
const enforcement = require('./enforcement');
const logging = require('./logging');
const unbanScheduler = require('./unbanScheduler');
const diagnostics = require('./diagnostics');

/**
 * Boots the pieces that need to run independently of any single join:
 * the temp-ban lifter, and the opt-in catch-up sweep.
 *
 * Never throws — a broken gate must not stop the bot from starting.
 */
async function initJoinGate(client) {
    try {
        await unbanScheduler.initUnbanScheduler(client);
        logger.info('[JOIN-GATE] Unban scheduler started');
    } catch (error) {
        logger.error('[JOIN-GATE] Unban scheduler failed to start', { error: error.message });
    }

    try {
        const guildIds = await config.getEnabledGuildIds();
        if (guildIds.length === 0) return;

        if (!client.options.intents.has(GatewayIntentBits.GuildMembers)) {
            logger.error(
                '[JOIN-GATE] The gate is enabled but the GuildMembers intent is missing — '
                + 'guildMemberAdd will never fire. Enable "Server Members Intent" in the Developer Portal.',
                { guilds: guildIds.length }
            );
            return;
        }

        for (const guildId of guildIds) {
            const settings = await config.getSettings(guildId);
            if (!settings.sweep_enabled) continue;
            const result = await enforcement.sweepGuild(client, guildId);
            logger.info('[JOIN-GATE] Startup sweep', { guildId, ...result });
        }
    } catch (error) {
        logger.error('[JOIN-GATE] Startup sweep failed', { error: error.message });
    }
}

module.exports = {
    initJoinGate,
    // Namespaced rather than flattened: several of these modules have
    // similarly-named helpers and a silent collision here would be nasty.
    config,
    enforcement,
    logging,
    unbanScheduler,
    diagnostics,
};
