// src/utils/joinGate/index.js
/**
 * Join Gate: account-age auto-kicker.
 *
 * Removes NEW members whose Discord account is younger than a per-server
 * threshold. Kicks are rejoinable by design; repeat rejoiners can optionally be
 * temp-banned until the exact moment their account becomes old enough.
 *
 * Requires the privileged "Server Members Intent" (Developer Portal) and the
 * `GuildMembers` gateway intent in bot.js. Without it `guildMemberAdd` never
 * fires and the gate silently does nothing. /joingate → Diagnostics says so.
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
const suspicion = require('./suspicion');
const phishing = require('./phishing');
const watchWindow = require('./watch');
const invites = require('./invites');
const restore = require('./restore');
const carryover = require('./carryover');

/**
 * Boots the pieces that need to run independently of any single join:
 * the temp-ban lifter, and the opt-in catch-up sweep.
 *
 * Never throws: a broken gate must not stop the bot from starting.
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

        // Only pay for these when at least one guild actually uses them.
        const settingsPerGuild = await Promise.all(guildIds.map(id => config.getSettings(id)));

        if (settingsPerGuild.some(s => s.watch_enabled)) {
            // Wait briefly for the first load: the refresh used to be fired
            // and forgotten, so every join in the first seconds after a boot
            // was scored against an empty scam list. Five seconds is the
            // ceiling; a slow feed degrades coverage, never boot time.
            await Promise.race([
                phishing.startAutoRefresh(),
                new Promise(resolve => setTimeout(resolve, 5_000)),
            ]);
        }
        if (settingsPerGuild.some(s => s.invite_tracking_enabled)) {
            await invites.syncAll(client).catch(e =>
                logger.warn('[JOIN-GATE] Invite cache priming failed', { error: e.message }));
        }

        if (!client.options.intents.has(GatewayIntentBits.GuildMembers)) {
            logger.error(
                '[JOIN-GATE] The gate is enabled but the GuildMembers intent is missing, so '
                + 'guildMemberAdd will never fire. Enable "Server Members Intent" in the Developer Portal.',
                { guilds: guildIds.length }
            );
            return;
        }

        // Before the sweep, because the sweep can remove people and there is no
        // sense rebuilding a window around someone who is about to be kicked.
        await restore.restoreAll(client, guildIds.map((id, i) => [id, settingsPerGuild[i]]))
            .catch(e => logger.warn('[JOIN-GATE] Memory restore failed', { error: e.message }));

        // Then the parked memory from the previous process, on top: the
        // restore re-derives who should be watched, the carryover adds what
        // only the dead process knew (messages, fired signals, burst window).
        const windowByGuild = new Map(guildIds.map((id, i) => [
            id,
            settingsPerGuild[i].watch_enabled
                ? Number(settingsPerGuild[i].watch_window_minutes) * 60_000
                : 0,
        ]));
        await carryover.load(guildId => windowByGuild.get(guildId) ?? 0);

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
    suspicion,
    phishing,
    watchWindow,
    invites,
    restore,
    carryover,
};
