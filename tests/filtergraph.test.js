// tests/filtergraph.test.js
//
// A bug class, not a bug.
//
// An ffmpeg filtergraph link label feeds exactly ONE consumer. Reading the
// same label twice does not duplicate the stream, it rejects the entire graph:
//
//     ffmpeg exited with code 234: Error binding filtergraph inputs/outputs:
//     Invalid argument
//
// /speechbubble did that. The transparent branch read [src] once to extract its
// alpha and once to merge the result back on, so every animated GIF failed, on
// the default colour, with an error message that names none of it. The fix is
// a split; the lint below is so the next one is caught here instead of in the
// channel.

const fs = require('fs');
const path = require('path');

const { bubbleChain } = require('../src/utils/media/speechBubbleUtils');

const LABEL = /\[([^\]]+)\]/g;
/** [0:v], [1:a], [2:v]: file inputs, produced by ffmpeg rather than a filter. */
const isInputPad = label => /^\d+:[vas]$/.test(label);

/**
 * Reads a complexFilter chain and reports what is wrong with its plumbing.
 *
 * `partial` is for graphs read out of source with an interpolation in them:
 * half the chain is behind a `${...}` and cannot be seen, so a label may well
 * be produced somewhere invisible. Reading one twice is still a fault, because
 * both readers are right there in the visible text.
 *
 * `inputs` is how many files the ffmpeg command was actually given. Without it
 * [9:v] looks like a perfectly ordinary input pad; with it, referring to a file
 * that was never passed is caught, which is the other half of "Invalid
 * argument" and just as silent.
 *
 * @param {string} chain
 * @param {{partial?: boolean, inputs?: number}} opts
 * @returns {string[]} one line per fault, empty when the graph is sound
 */
function lintFiltergraph(chain, { partial = false, inputs = null } = {}) {
    const faults = [];
    const produced = new Map();
    const consumed = new Map();

    for (const raw of String(chain).split(';')) {
        const segment = raw.trim();
        if (!segment) continue;

        const inputs = (segment.match(/^(?:\[[^\]]+\])+/) || [''])[0];
        const outputs = (segment.match(/(?:\[[^\]]+\])+$/) || [''])[0];
        // A segment that is only labels is malformed; without this a lone
        // "[x]" counts as both an input and an output of nothing.
        const body = segment.slice(inputs.length, segment.length - outputs.length);
        if (!body.trim()) {
            faults.push(`segment with no filter: "${segment}"`);
            continue;
        }

        for (const [, label] of inputs.matchAll(LABEL)) {
            consumed.set(label, (consumed.get(label) ?? 0) + 1);
        }
        for (const [, label] of outputs.matchAll(LABEL)) {
            produced.set(label, (produced.get(label) ?? 0) + 1);
        }
    }

    for (const [label, times] of consumed) {
        if (times > 1) faults.push(`[${label}] is read ${times} times; a link feeds one consumer, use split`);
        if (isInputPad(label)) {
            const index = Number(label.split(':')[0]);
            if (inputs != null && index >= inputs) {
                faults.push(`[${label}] refers to input ${index}, but only ${inputs} were given`);
            }
            continue;
        }
        if (!partial && !produced.has(label)) faults.push(`[${label}] is read but never produced`);
    }
    for (const [label, times] of produced) {
        if (times > 1) faults.push(`[${label}] is produced ${times} times`);
    }
    return faults;
}

describe('the linter itself', () => {
    test('a sound graph passes', () => {
        expect(lintFiltergraph('[0:v]scale=10:10[a];[a][1:v]overlay=0:0[out]')).toEqual([]);
    });

    test('it catches a label read twice, which is the bug that shipped', () => {
        const broken = '[0:v]format=rgba[src];[src]alphaextract[a];[src][a]alphamerge[out]';
        expect(lintFiltergraph(broken)).toEqual([
            expect.stringContaining('[src] is read 2 times'),
        ]);
    });

    test('it catches a label that nothing produces', () => {
        expect(lintFiltergraph('[ghost][0:v]overlay[out]')).toEqual([
            expect.stringContaining('[ghost] is read but never produced'),
        ]);
    });

    test('it catches the same label produced twice', () => {
        expect(lintFiltergraph('[0:v]scale=2:2[x];[1:v]scale=2:2[x];[x]null[out]')).toEqual([
            expect.stringContaining('[x] is produced 2 times'),
        ]);
    });

    test('file input pads are not expected to be produced by a filter', () => {
        expect(lintFiltergraph('[0:v][1:v]overlay[out]')).toEqual([]);
    });

    test('it catches a reference to a file that was never passed', () => {
        expect(lintFiltergraph('[0:v][2:v]overlay[out]', { inputs: 2 })).toEqual([
            expect.stringContaining('refers to input 2, but only 2 were given'),
        ]);
        expect(lintFiltergraph('[0:v][1:v]overlay[out]', { inputs: 2 })).toEqual([]);
    });

    test('split satisfies two readers', () => {
        expect(lintFiltergraph('[0:v]split=2[a][b];[b]alphaextract[m];[a][m]alphamerge[out]')).toEqual([]);
    });
});

describe('the speech bubble graph', () => {
    const fps = 15;
    const paletteGen = 'palettegen=reserve_transparent=1';
    const paletteUse = 'paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128';

    test.each(['transparent', 'white', 'black'])('%s is a sound graph', (color) => {
        expect(lintFiltergraph(bubbleChain(640, 480, color))).toEqual([]);
    });

    // Both ffmpeg passes wrap the same chain, and both used to fail together.
    // The input counts are the real ones: the palette pass is given the source
    // and the overlay, the render pass adds the palette it just made.
    test('the palette pass is sound, with its two inputs', () => {
        const chain = bubbleChain(640, 480, 'transparent');
        expect(lintFiltergraph(`${chain};[bubbled]fps=${fps},${paletteGen}`, { inputs: 2 })).toEqual([]);
    });

    test('the render pass is sound, with its three', () => {
        const chain = bubbleChain(640, 480, 'transparent');
        expect(lintFiltergraph(`${chain};[bubbled]fps=${fps}[f];[f][2:v]${paletteUse}`, { inputs: 3 })).toEqual([]);
    });

    test('transparent still cuts the bubble out rather than painting over it', () => {
        const chain = bubbleChain(640, 480, 'transparent');
        expect(chain).toContain('alphamerge');
        expect(chain).toContain('blend=all_mode=subtract');
        expect(chain).not.toContain('overlay=');
    });

    test('white and black composite on top instead', () => {
        expect(bubbleChain(640, 480, 'white')).toContain('overlay=0:0');
        expect(bubbleChain(640, 480, 'white')).not.toContain('alphamerge');
    });

    test('the source is scaled to the size the overlay was rendered at', () => {
        expect(bubbleChain(320, 240, 'transparent')).toContain('scale=320:240');
    });
});

// Every other filtergraph in the codebase, read straight out of the source.
// Interpolated expressions are replaced with a placeholder, which is fine
// because labels are written literally and only the plumbing is being checked.
describe('every literal filtergraph in the repo', () => {
    const files = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) files.push(full);
        }
    })(path.join(__dirname, '..', 'src'));

    const graphs = [];
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        const rel = path.relative(path.join(__dirname, '..'), file);
        const add = (raw) => graphs.push({
            file: rel,
            chain: raw.replace(/\$\{[^}]*\}/g, 'X'),
            // Anything interpolated hides part of the graph from a reader.
            partial: /\$\{/.test(raw),
        });

        for (const [, literal] of src.matchAll(/complexFilter\(\s*`([^`]*)`/g)) add(literal);
        // The array form: complexFilter([`a`, `b`]) is one graph, joined.
        for (const [, block] of src.matchAll(/complexFilter\(\s*\[([\s\S]*?)\]\s*\)/g)) {
            const parts = [...block.matchAll(/`([^`]*)`|'([^']*)'/g)].map(m => m[1] ?? m[2]);
            if (parts.length) add(parts.join(';'));
        }
    }

    test('there are graphs to check', () => {
        expect(graphs.length).toBeGreaterThan(0);
    });

    test('none of them reads a link twice or invents one', () => {
        const broken = graphs
            .map(g => ({ ...g, faults: lintFiltergraph(g.chain, { partial: g.partial }) }))
            .filter(g => g.faults.length);

        expect(broken.map(g => `${g.file}: ${g.faults.join(', ')}`)).toEqual([]);
    });

    // Honest about the limit of this sweep, so a green run is not mistaken for
    // "every graph in the repo is provably sound". Every filtergraph in this
    // codebase is built with interpolation, so the sweep can only see half of
    // each one and only the double-read rule applies. Whole-graph linting
    // comes from the pure builders above, which is the argument for extracting
    // more of them the next time one of these needs touching.
    test('the sweep knows it is only seeing fragments', () => {
        expect(graphs.every(g => g.partial)).toBe(true);
    });
});
