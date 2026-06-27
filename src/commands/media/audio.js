// src/commands/media/audio.js
const { SlashCommandBuilder } = require('discord.js');
const { handleMediaCommand } = require('../../utils/media/mediaHelpers');
const audio = require('../../utils/media/audioUtils');

// These commands accept a video (transform its audio, keep the picture) or a pure
// audio file. GIFs have no audio and are rejected.
const acceptsAudioOrVideo = (info) => (info.isVideo && !info.isGifLike) || info.isAudio;
const REJECT_MSG = 'This command needs a video or audio file (GIFs have no audio).';

function audioCommandConfig(processFn) {
    return {
        allowImage: false,
        allowVideo: true,
        allowAudio: true,
        mediaPredicate: acceptsAudioOrVideo,
        invalidMediaMessage: REJECT_MSG,
        processFn,
    };
}

const volume = {
    data: new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Change the volume of a video or audio file')
        .addNumberOption(opt =>
            opt.setName('amount').setDescription('Volume multiplier (1 = unchanged, 0.5 = half, 2 = double)').setRequired(true).setMinValue(0).setMaxValue(32)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or audio (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const amount = interaction.options.getNumber('amount');
        await handleMediaCommand(interaction, audioCommandConfig(
            (inputPath, ext, { isAudio }) => audio.volume(inputPath, amount, isAudio)
        ));
    },
};

const pitch = {
    data: new SlashCommandBuilder()
        .setName('pitch')
        .setDescription('Shift the pitch of a video or audio file (keeps the same duration)')
        .addNumberOption(opt =>
            opt.setName('halfsteps').setDescription('Half-steps to shift (−12 to 12, default 12)').setMinValue(-12).setMaxValue(12)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or audio (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const halfSteps = interaction.options.getNumber('halfsteps') ?? 12;
        await handleMediaCommand(interaction, audioCommandConfig(
            (inputPath, ext, { isAudio }) => audio.pitch(inputPath, halfSteps, isAudio)
        ));
    },
};

const vibrato = {
    data: new SlashCommandBuilder()
        .setName('vibrato')
        .setDescription('Apply a wavy-pitch vibrato effect to a video or audio file')
        .addNumberOption(opt =>
            opt.setName('frequency').setDescription('Vibrato speed in Hz (0.1–20000, default 5)').setMinValue(0.1).setMaxValue(20000)
        )
        .addNumberOption(opt =>
            opt.setName('depth').setDescription('Vibrato depth (0–1, default 0.5)').setMinValue(0).setMaxValue(1)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or audio (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const frequency = interaction.options.getNumber('frequency') ?? 5;
        const depth = interaction.options.getNumber('depth') ?? 0.5;
        await handleMediaCommand(interaction, audioCommandConfig(
            (inputPath, ext, { isAudio }) => audio.vibrato(inputPath, frequency, depth, isAudio)
        ));
    },
};

const toaudio = {
    data: new SlashCommandBuilder()
        .setName('toaudio')
        .setDescription('Extract the audio from a video as an MP3/M4A file')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video to extract audio from (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await handleMediaCommand(interaction, {
            allowImage: false,
            allowVideo: true,
            allowAudio: true,
            mediaPredicate: acceptsAudioOrVideo,
            invalidMediaMessage: 'This command needs a video (or audio) file.',
            processFn: (inputPath) => audio.toAudio(inputPath),
        });
    },
};

const videoloop = {
    data: new SlashCommandBuilder()
        .setName('videoloop')
        .setDescription('Loop a video (or audio) by duplicating its contents')
        .addIntegerOption(opt =>
            opt.setName('count').setDescription('Extra times to repeat (1–15, default 1)').setMinValue(1).setMaxValue(15)
        )
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Video or audio (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        const count = interaction.options.getInteger('count') ?? 1;
        await handleMediaCommand(interaction, audioCommandConfig(
            (inputPath, ext, { isAudio }) => audio.videoLoop(inputPath, count, isAudio)
        ));
    },
};

module.exports = [volume, pitch, vibrato, toaudio, videoloop];
