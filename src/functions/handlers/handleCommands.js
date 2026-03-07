// src/functions/handlers/handleCommands.js
const fs    = require('fs');
const path  = require('path');
const { REST, Routes } = require('discord.js');

module.exports = (client) => {
  client.handleCommands = async () => {
    // Load all commands from disk
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

    // Store command JSON array for guildCreate event
    client.commandArray = commands;

    const token = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
    if (!token) {
      console.error('Missing DISCORD_TOKEN/TOKEN - skipping registration');
      return;
    }
    const rest = new REST({ version: '10' }).setToken(token);

    client.once('clientReady', async () => {
      const appId = process.env.CLIENT_ID ?? client.user.id;
      console.log(`App ID: ${appId}`);

      // 1. Fetch and delete existing global commands
      let globalCmds = [];
      try {
        globalCmds = await rest.get(Routes.applicationCommands(appId));
      } catch (err) {
        console.error('Could not fetch global commands:', err);
      }

      if (globalCmds.length > 0) {
        await Promise.all(globalCmds.map(cmd =>
          rest.delete(Routes.applicationCommand(appId, cmd.id))
            .then(() => console.log(`Deleted global /${cmd.name}`))
            .catch(err => console.error(`Failed to delete /${cmd.name}:`, err))
        ));
      }

      // 2. Register per-guild commands in parallel
      const guilds = [...client.guilds.cache.values()];
      const results = await Promise.allSettled(
        guilds.map(guild =>
          rest.put(
            Routes.applicationGuildCommands(appId, guild.id),
            { body: commands }
          ).then(() => console.log(`Registered ${commands.length} commands in ${guild.name}`))
        )
      );

      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        failures.forEach((f, i) => {
          console.error(`Failed guild-register in ${guilds[i]?.name}:`, f.reason);
        });
      }
    });
  };
};
