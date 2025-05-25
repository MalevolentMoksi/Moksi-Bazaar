// src/functions/handlers/handleCommands.js
const fs    = require('fs');
const path  = require('path');
const { REST }   = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');

module.exports = (client) => {
  client.handleCommands = async () => {
    // 1️⃣ Load every command from src/commands/*/*
    const commands = [];
    const commandsPath = path.join(__dirname, '..', '..', 'commands');
    for (const category of fs.readdirSync(commandsPath)) {
      const categoryPath = path.join(commandsPath, category);
      if (!fs.lstatSync(categoryPath).isDirectory()) continue;
      for (const file of fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'))) {
        const cmd = require(path.join(categoryPath, file));
        if (cmd.data && cmd.execute) {
          client.commands.set(cmd.data.name, cmd);
          commands.push(cmd.data.toJSON());
        }
      }
    }

    // 2️⃣ Build a REST client
    const token = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
    if (!token) {
      console.error('❌ Missing DISCORD_TOKEN / TOKEN — skipping slash-registration.');
      return;
    }
    const rest = new REST({ version: '9' }).setToken(token);

    // 3️⃣ As soon as the bot is ready…
    client.once('ready', async () => {
      // derive appId from env or from the logged-in user
      const appId = process.env.CLIENT_ID ?? client.user.id;
      console.log(`Logged in as ${client.user.tag} (appId=${appId})`);

      // 🔥 Purge *all* global commands
      try {
        console.log('🗑 Clearing all global slash-commands…');
        await rest.put(
          Routes.applicationCommands(appId),
          { body: [] }
        );
        console.log('✅ Global commands cleared.');
      } catch (err) {
        console.error('❌ Failed to clear global commands:', err);
      }

      // 🔄 Register every command in each guild (instant `/` availability)
      for (const guild of client.guilds.cache.values()) {
        try {
          console.log(`🔄 Registering ${commands.length} commands in ${guild.name} (${guild.id})…`);
          await rest.put(
            Routes.applicationGuildCommands(appId, guild.id),
            { body: commands }
          );
          console.log(`✅ Done in ${guild.name}`);
        } catch (err) {
          console.error(`❌ Failed in ${guild.id}:`, err);
        }
      }
    });
  };
};
