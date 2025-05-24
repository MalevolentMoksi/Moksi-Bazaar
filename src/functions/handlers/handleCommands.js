// src/functions/handlers/handleCommands.js
const { REST }   = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const fs         = require('fs');
const path       = require('path');

module.exports = (client) => {
  client.handleCommands = async () => {
    // 1) Collect all commands into arrays
    const commands = [];
    const commandFolders = fs.readdirSync(path.join(__dirname, '..', '..', 'commands'));
    for (const folder of commandFolders) {
      const files = fs.readdirSync(path.join(__dirname, '..', '..', 'commands', folder))
                      .filter(f => f.endsWith('.js'));
      for (const file of files) {
        const cmd = require(path.join(__dirname, '..', '..', 'commands', folder, file));
        client.commands.set(cmd.data.name, cmd);
        commands.push(cmd.data.toJSON());
      }
    }

    // 2) Create REST instance
    const rest     = new REST({ version: '9' }).setToken(process.env.DISCORD_TOKEN);
    const clientId = process.env.CLIENT_ID;

    // 3) As soon as the bot is ready, loop through all its guilds
    client.once('ready', async () => {
      for (const guild of client.guilds.cache.values()) {
        try {
          console.log(`🔄 Registering commands in guild ${guild.id} (${guild.name})…`);
          await rest.put(
            Routes.applicationGuildCommands(clientId, guild.id),
            { body: commands }
          );
          console.log(`✅ Commands registered in ${guild.id}`);
        } catch (err) {
          console.error(`❌ Failed for ${guild.id}:`, err);
        }
      }
    });
  };
};
