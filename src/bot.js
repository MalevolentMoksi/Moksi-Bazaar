/**
 * Main Bot Entry Point
 * Initializes Discord.js client, loads handlers, and validates environment
 */

require('dotenv').config();

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const logger = require('./utils/logger');
const { validateEnvironmentVars } = require('./utils/validateEnvironment');
const { pool } = require('./utils/db');
const { stopJanitor } = require('./utils/janitor');
const { flush: activityFlush, stopAutoFlush: stopActivityFlush } = require('./utils/joinGate/activity');
const { startDashboard } = require('./web/server');

/** Railway allows roughly 10s between SIGTERM and SIGKILL; stay inside it. */
const SHUTDOWN_TIMEOUT_MS = 8000;

// Use console as fallback for critical startup errors
console.log('[STARTUP] Starting Moksi\'s Bazaar bot...');

// Perform startup validations
(async () => {
  try {
    // Critical validation: environment variables only
    const envValidation = validateEnvironmentVars();
    if (!envValidation.valid) {
      console.error('[STARTUP_ERROR] Missing required environment variables:', envValidation.errors);
      logger.error('Missing required environment variables', { errors: envValidation.errors });
      process.exit(1);
    }

    console.log('[STARTUP] Environment variables valid, initializing bot...');
    logger.info('Starting Moksi\'s Bazaar bot - env vars validated');

    // Initialize bot
    initializeBot();
  } catch (error) {
    console.error('[STARTUP_ERROR] Unexpected startup error:', error.message);
    logger.error('Unexpected startup error', { error: error.message, stack: error.stack });
    process.exit(1);
  }
})();

function initializeBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      // PRIVILEGED. Required for guildMemberAdd (the join gate). Must also be
      // switched on at Developer Portal → your app → Bot → Privileged Gateway
      // Intents → "Server Members Intent", or login is rejected outright.
      GatewayIntentBits.GuildMembers,
      // PRIVILEGED. Lets the suspicion scorer see status and activity, which
      // are evidence of a lived-in account. Same portal toggle, "Presence
      // Intent". Costs memory: discord.js caches a presence per online member.
      GatewayIntentBits.GuildPresences,
      // Needed to diff invite use counts for join attribution.
      GatewayIntentBits.GuildInvites,
      // Discord's own AutoMod telling us what it blocked. Not privileged, and
      // it grants no ability to change a rule: this bot only ever listens.
      GatewayIntentBits.AutoModerationExecution,
      // Carries guildAuditLogEntryCreate, which the audit-log guard reads.
      // The audit log is a record of what already happened, so this intent
      // buys the ability to notice a nuke, never to intercept one.
      GatewayIntentBits.GuildModeration,
    ],
  });

  client.commands = new Collection();
  client.commandArray = [];

  // Load all handler functions
  const functionFolders = fs.readdirSync('./src/functions');
  for (const folder of functionFolders) {
    const functionFiles = fs.readdirSync(`./src/functions/${folder}`).filter(file => file.endsWith('.js'));
    for (const file of functionFiles) {
      try {
        require(`./functions/${folder}/${file}`)(client);
      } catch (error) {
        logger.error('Failed to load function', { folder, file, error: error.message });
      }
    }
  }

  client.handleEvents();
  client.handleCommands();

  // The owner dashboard, sharing this process. startDashboard() returns null
  // (and the bot runs exactly as before) unless its env vars are all set; it
  // catches its own failures, so nothing on this path can prevent login.
  const dashboard = startDashboard(client);

  // Login with token from environment.
  // A rejected login used to surface only as an unhandled rejection, which left
  // the process alive and silent. Now that a privileged intent is in the list,
  // the most likely cause has a specific fix, so say it out loud.
  client.login(process.env.TOKEN || process.env.DISCORD_TOKEN).catch((error) => {
    if (error?.code === 'DisallowedIntents' || /disallowed intents/i.test(error?.message ?? '')) {
      const help = 'Discord rejected the gateway intents. Enable "Server Members Intent" under '
        + 'Developer Portal → your application → Bot → Privileged Gateway Intents, then restart.';
      console.error('[STARTUP_ERROR]', help);
      logger.error('Login rejected: disallowed intents', { help });
    } else {
      console.error('[STARTUP_ERROR] Discord login failed:', error.message);
      logger.error('Discord login failed', { error: error.message, stack: error.stack });
    }
    process.exit(1);
  });

  // Handle unhandled rejections and exceptions
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED_REJECTION]', reason);
    logger.error('Unhandled Promise Rejection', { reason: String(reason), stack: reason?.stack });
  });

  process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT_EXCEPTION]', error.message);
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    process.exit(1);
  });

  // Graceful shutdown.
  //
  // Railway stops a container by sending SIGTERM and killing it outright a
  // short while later. Only SIGINT was handled before, so every single deploy
  // tore the process down mid-flight: sockets dropped without a close frame
  // and in-flight database work was abandoned with the pool still open.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} received, closing down...`);
    logger.info('Shutting down gracefully', { signal });

    // Whatever has not finished by the deadline is not going to. Exiting late
    // is worse than exiting dirty: the platform's own kill is unconditional.
    const deadline = setTimeout(() => {
      console.error('[SHUTDOWN] Timed out waiting for clean close, exiting anyway');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();

    try { stopJanitor(); } catch { /* nothing worth reporting at this point */ }

    // The dashboard goes first: stop accepting requests while the gateway and
    // the pool are still alive to finish the ones in flight. Not awaited: a
    // browser holding a keep-alive socket must not spend the 8s budget that
    // the activity flush and the pool close actually need.
    if (dashboard) {
      try {
        dashboard.close();
        dashboard.closeIdleConnections?.();
        logger.info('Dashboard closed to new connections');
      } catch { /* already down is fine */ }
    }

    // Before the pool closes: a minute of buffered message counts is cheap to
    // write and annoying to lose on every deploy.
    try {
      stopActivityFlush();
      await activityFlush();
    } catch (error) {
      logger.warn('Activity flush on shutdown failed', { error: error.message });
    }

    try {
      await client.destroy();
      logger.info('Gateway connection closed');
    } catch (error) {
      logger.error('Error closing gateway', { error: error.message });
    }

    // Last, so anything above can still write. end() waits for checked-out
    // clients to finish their current query.
    try {
      await pool.end();
      logger.info('Database pool closed');
    } catch (error) {
      logger.error('Error closing database pool', { error: error.message });
    }

    clearTimeout(deadline);
    console.log('[SHUTDOWN] Clean exit');
    process.exit(0);
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}
