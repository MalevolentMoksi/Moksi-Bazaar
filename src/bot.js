require('dotenv').config();
const { Client, Collection, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands     = new Collection();
client.commandArray = [];

// 1) Load command & event handlers (they immediately register everything)
require('./functions/handlers/handleCommands')(client);
require('./functions/handlers/handleEvents')(client);

// 2) Register commands (global + dev guild, if you added that)
(async () => {
  await client.handleCommands();
  // 3) Finally, log in
  client.login(process.env.TOKEN);
})();
