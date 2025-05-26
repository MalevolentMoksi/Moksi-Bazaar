// src/events/client/interactionCreate.js
module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        if (interaction.isChatInputCommand()) {
            const { commands } = client;
            const { commandName } = interaction;
            const command = commands.get(commandName);
            if (!command) return;

            try {
                await command.execute(interaction, client);
            } catch (error) {
                console.error(error);
                await interaction.reply({
                    content: 'There was an error while executing this command!',
                    ephemeral: true
                });
            }
        } else if (interaction.isButton()) {
            // let the individual command's collector call deferUpdate()/update()
            // so we don't double‐ack and we don't swallow the event.
            return;
        }
    }
};