// src/bot.js

require('dotenv').config();

const { token } = process.env;

const { Client, Collection, GatewayIntentBits } = require('discord.js');

const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // you already had this
    GatewayIntentBits.GuildMessages, // to receive messageCreate events
    GatewayIntentBits.MessageContent, // to actually read message.content
    GatewayIntentBits.GuildVoiceStates // Required for voice functionality
  ]
});

client.commands = new Collection();
// client.colour = "";
client.commandArray = [];

const functionFolders = fs.readdirSync('./src/functions');
for (const folder of functionFolders) {
  const functionFiles = fs.readdirSync(`./src/functions/${folder}`).filter(file => file.endsWith('.js'));
  for (const file of functionFiles) require(`./functions/${folder}/${file}`)(client);
}

client.handleEvents();
client.handleCommands();
client.login(process.env.TOKEN);

// REMOVE OR COMMENT OUT THIS BLOCK since it's now in ready.js:
/*
const { init } = require('./utils/db');
client.once('ready', async () => {
  await init();
  console.log(`Logged in as ${client.user.tag}`);
  initUptimePresence(client);
  console.log('✅ Database initialized, balances table is ready.');
  // ... any other ready logic
});
*/
