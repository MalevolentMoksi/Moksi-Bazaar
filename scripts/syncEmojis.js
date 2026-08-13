#!/usr/bin/env node
// scripts/syncEmojis.js
/**
 * Uploads the images in `emojis/` as the application's own emojis.
 *
 * Application emojis belong to the app rather than to a server: they need no
 * guild membership, no USE_EXTERNAL_EMOJIS in the channel, and they work
 * anywhere the bot can speak. That is the whole reason for this script. The
 * previous set lived in one guild as eleven ids pasted into constants.js,
 * where a re-upload or a lost permission turned every reaction into raw text
 * in front of the room.
 *
 * The file name is the key: `emojis/tired.jpg` becomes an emoji named `tired`,
 * which is the word the model writes and the word src/utils/constants.js
 * describes. All three have to agree, and the tests check that they do.
 *
 *   node scripts/syncEmojis.js                 # dry run, prints the plan
 *   node scripts/syncEmojis.js --yes           # upload what is missing
 *   node scripts/syncEmojis.js --yes --replace # re-upload images that changed
 *   node scripts/syncEmojis.js --yes --prune   # delete emojis with no source file
 *
 * Nothing happens without --yes. Discord returns no checksum for an uploaded
 * emoji, so a changed image cannot be detected: --replace deletes and recreates
 * every one, which changes their ids. That is safe here precisely because no id
 * is written down anywhere; the bot reads them at boot.
 *
 * Needs TOKEN (or DISCORD_TOKEN) in the environment, the same one the bot uses.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { REST, Routes } = require('discord.js');

const EMOJI_DIR = path.join(__dirname, '..', 'emojis');
const SIZE = 128;                       // Discord's own emoji resolution
const MAX_BYTES = 256 * 1024;           // hard API limit, per emoji
const SOURCE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** Discord's rule for an emoji name, and therefore for a source file name. */
const NAME_RULE = /^[a-z0-9_]{2,32}$/;

function parseArgs(argv) {
    return {
        yes: argv.includes('--yes'),
        replace: argv.includes('--replace'),
        prune: argv.includes('--prune'),
    };
}

/** Every usable source image, as `{key, file}`, sorted for a stable plan. */
function sourceFiles(dir = EMOJI_DIR) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(name => SOURCE_EXT.test(name))
        .map(name => ({ key: path.parse(name).name.toLowerCase(), file: path.join(dir, name) }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * One source image as something Discord will accept.
 *
 * Squares the frame by cropping rather than padding, because a padded emoji is
 * a small picture in a big empty box and these are already tight crops. A
 * portrait keeps its top: on a photograph of a face, that is where the face is.
 *
 * An animated GIF is passed through untouched. Re-encoding it here would cost
 * the animation, and Discord resizes it server-side anyway.
 */
async function normalize(file) {
    const raw = fs.readFileSync(file);

    if (path.extname(file).toLowerCase() === '.gif') {
        if (raw.length > MAX_BYTES) {
            throw new Error(`${path.basename(file)} is ${(raw.length / 1024).toFixed(0)}KB, over Discord's 256KB limit`);
        }
        return { buffer: raw, mime: 'image/gif' };
    }

    const meta = await sharp(raw).metadata();
    const portrait = meta.height > meta.width * 1.05;
    const buffer = await sharp(raw)
        .resize(SIZE, SIZE, { fit: 'cover', position: portrait ? 'top' : 'centre' })
        .png()
        .toBuffer();

    if (buffer.length > MAX_BYTES) {
        throw new Error(`${path.basename(file)} is still ${(buffer.length / 1024).toFixed(0)}KB after resizing`);
    }
    return { buffer, mime: 'image/png' };
}

const dataUri = ({ buffer, mime }) => `data:${mime};base64,${buffer.toString('base64')}`;

/**
 * What this run would do, decided before anything is sent.
 *
 * @param {{key: string, file: string}[]} sources
 * @param {Map<string, {id: string, name: string}>} live what the app already owns
 */
function plan(sources, live, { replace = false, prune = false } = {}) {
    const orphans = [...live.values()].filter(emoji => !sources.some(s => s.key === emoji.name.toLowerCase()));
    return {
        create: sources.filter(s => !live.has(s.key)),
        replace: replace ? sources.filter(s => live.has(s.key)) : [],
        prune: prune ? orphans : [],
        orphans,
    };
}

/**
 * Carries out a plan. Replacing means delete then create, because Discord has
 * no endpoint that swaps an emoji's image and no checksum to compare against.
 * The new id is nobody's problem: the bot reads ids at boot and none is
 * written down.
 */
async function apply(rest, appId, steps, live, log = console.log) {
    let created = 0, deleted = 0, failed = 0;

    for (const emoji of steps.prune) {
        await rest.delete(Routes.applicationEmoji(appId, emoji.id));
        deleted++;
        log(`  deleted  ${emoji.name}`);
    }

    for (const source of [...steps.replace, ...steps.create]) {
        try {
            const image = dataUri(await normalize(source.file));
            const previous = live.get(source.key);
            if (previous) {
                await rest.delete(Routes.applicationEmoji(appId, previous.id));
                deleted++;
            }
            const made = await rest.post(Routes.applicationEmojis(appId), {
                body: { name: source.key, image },
            });
            created++;
            log(`  uploaded ${made.name}  <:${made.name}:${made.id}>`);
        } catch (error) {
            failed++;
            // Keep going: one rejected image must not strand the other sixteen.
            log(`  FAILED   ${source.key}: ${error.message}`);
        }
    }

    return { created, deleted, failed };
}

async function main(argv = process.argv.slice(2), injected = null) {
    const args = parseArgs(argv);

    const sources = sourceFiles();
    if (sources.length === 0) {
        console.error(`No images found in ${EMOJI_DIR}`);
        process.exit(1);
    }

    const badNames = sources.filter(s => !NAME_RULE.test(s.key));
    if (badNames.length > 0) {
        console.error('These file names cannot be emoji names (2-32 chars, lowercase letters, digits, underscore):');
        for (const bad of badNames) console.error(`  ${path.basename(bad.file)}`);
        process.exit(1);
    }

    let rest = injected;
    if (!rest) {
        const token = process.env.TOKEN || process.env.DISCORD_TOKEN;
        if (!token) {
            console.error('No TOKEN in the environment. This is the bot token, the same one the bot logs in with.');
            process.exit(1);
        }
        rest = new REST({ version: '10' }).setToken(token);
    }

    const app = await rest.get(Routes.currentApplication());
    const existing = await rest.get(Routes.applicationEmojis(app.id));
    const live = new Map((existing.items ?? []).map(emoji => [emoji.name.toLowerCase(), emoji]));

    console.log(`Application: ${app.name} (${app.id})`);
    console.log(`${sources.length} source images, ${live.size} emojis already uploaded\n`);

    const steps = plan(sources, live, args);
    for (const s of steps.create) console.log(`  create   ${s.key}`);
    for (const s of steps.replace) console.log(`  replace  ${s.key}`);
    for (const e of steps.prune) console.log(`  delete   ${e.name}`);
    if (!args.prune) {
        for (const e of steps.orphans) console.log(`  orphan   ${e.name}  (uploaded, no source file; --prune removes it)`);
    }
    if (steps.create.length + steps.replace.length + steps.prune.length === 0) {
        console.log('  nothing to do');
    }

    if (!args.yes) {
        console.log('\nDry run. Add --yes to apply.');
        return { steps, applied: null };
    }

    console.log('');
    const result = await apply(rest, app.id, steps, live);
    console.log(`\n${result.created} uploaded, ${result.deleted} deleted, ${result.failed} failed.`);
    if (result.created > 0 || result.deleted > 0) {
        console.log('Restart the bot (or redeploy) so it reads the new ids at boot.');
    }
    return { steps, applied: result };
}

if (require.main === module) {
    main().catch(error => {
        console.error('Sync failed:', error.message);
        process.exit(1);
    });
}

module.exports = { sourceFiles, normalize, plan, apply, parseArgs, NAME_RULE, SIZE, MAX_BYTES, EMOJI_DIR };
