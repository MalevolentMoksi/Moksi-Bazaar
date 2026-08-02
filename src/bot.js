/**
 * Main Bot Entry Point
 * Initializes Discord.js client, loads handlers, and validates environment
 */

require('dotenv').config();

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const logger = require('./utils/logger');
const { validateEnvironmentVars } = require('./utils/validateEnvironment');

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

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    try {
      await client.destroy();
      logger.info('Bot shut down successfully');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  });
}
