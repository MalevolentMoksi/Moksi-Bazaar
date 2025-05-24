// src/functions/handlers/handleCommands.js
const fs         = require('fs');
const path       = require('path');
const { REST }   = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');

module.exports = (client) => {
  client.handleCommands = async () => {
    // 1️⃣ Load and serialize all your slash commands
    const commands = [];
    const commandsPath = path.join(__dirname, '..', '..', 'commands');
    for (const folder of fs.readdirSync(commandsPath)) {
      const folderPath = path.join(commandsPath, folder);
      if (!fs.lstatSync(folderPath).isDirectory()) continue;
      for (const file of fs.readdirSync(folderPath).filter(f => f.endsWith('.js'))) {
        const cmd = require(path.join(folderPath, file));
        if (cmd.data && cmd.execute) {
          client.commands.set(cmd.data.name, cmd);
          commands.push(cmd.data.toJSON());
        }
      }
    }

    const token    = process.env.DISCORD_TOKEN;
    const clientId = process.env.CLIENT_ID;
    if (!token) {
      console.error('❌ Missing DISCORD_TOKEN — commands will not register.');
      return;
    }
    if (!clientId) {
      console.error('❌ Missing CLIENT_ID — commands will not register.');
      return;
    }

    // 2️⃣ Create one REST instance with your token
    const rest = new REST({ version: '9' }).setToken(token);

    // 3️⃣ Once we're ready, push the commands in *every* guild
    client.once('ready', async () => {
      for (const guild of client.guilds.cache.values()) {
        console.log(`🔄 Registering commands in guild ${guild.id} (${guild.name})…`);
        try {
          await rest.put(
            Routes.applicationGuildCommands(clientId, guild.id),
            { body: commands }
          );
          console.log(`✅ Commands registered in ${guild.name}`);
        } catch (err) {
          console.error(`❌ Failed to register in ${guild.id}:`, err);
        }
      }
    });
  };
};
