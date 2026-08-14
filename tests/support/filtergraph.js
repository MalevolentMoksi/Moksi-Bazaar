// tests/support/filtergraph.js
//
// Lives outside the test files because two of them need it: the speech bubble
// graphs it was written for, and the /heaven and /hell graphs, which read the
// source twice for their bloom and would fail exactly the same way.
//
// Not named *.test.js on purpose, so jest treats it as a module rather than a
// suite and its describes do not run twice.

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

module.exports = { lintFiltergraph };
