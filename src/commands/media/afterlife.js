// src/commands/media/afterlife.js
// Two presets and no knobs. /tint already exists for anyone who wants to pick a
// colour; the joke here is that the bot has an opinion about what damnation
// looks like, and asking the user to tune it would be the same as not having
// one.
//
// The two builders are written out rather than produced by a factory, which is
// duplication with a reason: tests/commandVisibility reads what every command
// declares straight from the source, because loading the command files opens
// database handles and timers. A builder assembled from variables is invisible
// to it, and being invisible to the sweep that checks how commands present
// themselves is the wrong thing for a command to be.
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const { afterlife } = require('../../utils/media/afterlifeUtils');

const MEDIA_OPTION = 'Image, GIF, video, or audio (optional: uses recent media if omitted)';

/** Audio is allowed on purpose: half the effect is the pitch. */
const run = (kind) => async (interaction) => handleMediaCommand(interaction, {
    allowImage: true,
    allowVideo: true,
    allowAudio: true,
    processFn: (inputPath, ext, context) => afterlife(inputPath, kind, ext, context),
});

const hell = {
    data: new SlashCommandBuilder()
        .setName('hell')
        .setDescription('Damn an image, GIF, video, or sound: red, grainy, and pitched into a cave')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription(MEDIA_OPTION).setRequired(false)
        ),
    execute: run('hell'),
};

const heaven = {
    data: new SlashCommandBuilder()
        .setName('heaven')
        .setDescription('Bless an image, GIF, video, or sound: bright, blue, and pitched into a cathedral')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription(MEDIA_OPTION).setRequired(false)
        ),
    execute: run('heaven'),
};

module.exports = [hell, heaven];
