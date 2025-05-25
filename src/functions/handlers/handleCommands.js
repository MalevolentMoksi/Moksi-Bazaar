// src/functions/handlers/handleCommands.js
const fs    = require('fs');
const path  = require('path');
const { REST }   = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');

module.exports = (client) => {
  client.handleCommands = async () => {
    // load all commands as before…
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

    const token = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
    if (!token) {
      console.error('❌ Missing DISCORD_TOKEN/TOKEN — skipping registration');
      return;
    }
    const rest = new REST({ version: '9' }).setToken(token);

    client.once('ready', async () => {
      const appId = process.env.CLIENT_ID ?? client.user.id;
      console.log(`🔑 App ID: ${appId}`);

      // 1️⃣ Fetch existing global commands…
      let globalCmds = [];
      try {
        globalCmds = await rest.get(Routes.applicationCommands(appId));
      } catch (err) {
        console.error('❌ Could not fetch global commands:', err);
      }

      // 2️⃣ Delete each one individually
      await Promise.all(globalCmds.map(cmd =>
        rest.delete(Routes.applicationCommand(appId, cmd.id))
           .then(() => console.log(`🗑 Deleted global /${cmd.name}`))
           .catch(err => console.error(`❌ Failed to delete /${cmd.name}:`, err))
      ));

      // 3️⃣ Now re-register all of your local commands _per guild_ for instant availability
      for (const guild of client.guilds.cache.values()) {
        try {
          await rest.put(
            Routes.applicationGuildCommands(appId, guild.id),
            { body: commands }
          );
          console.log(`✅ Registered ${commands.length} commands in ${guild.name}`);
        } catch (err) {
          console.error(`❌ Failed guild‐register in ${guild.id}:`, err);
        }
      }
    });
  };
};
