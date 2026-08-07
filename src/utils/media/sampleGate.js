// src/utils/media/sampleGate.js
/**
 * One gate for every media sampling job that downloads and runs ffmpeg
 * (video frames, GIF storyboards). The context builder fires every message's
 * media at once, and each message its attachments at once; without a shared
 * gate a cold channel means a dozen simultaneous 40 MB downloads and a dozen
 * ffmpeg processes on a small container. Two at a time keeps the burst
 * bounded; everything else queues, and cached media never comes through here.
 */

const MAX_CONCURRENT_SAMPLES = 2;
let active = 0;
const queue = [];

function acquire() {
    if (active < MAX_CONCURRENT_SAMPLES) {
        active += 1;
        return Promise.resolve();
    }
    // The releaser hands its slot straight to the next waiter, so the waiter
    // must not increment: the slot was never freed.
    return new Promise(resolve => queue.push(resolve));
}

function release() {
    const next = queue.shift();
    if (next) { next(); return; }
    active -= 1;
}

/** Runs fn holding a sampling slot; the slot is released whatever happens. */
async function withSampleSlot(fn) {
    await acquire();
    try {
        return await fn();
    } finally {
        release();
    }
}

module.exports = { withSampleSlot, MAX_CONCURRENT_SAMPLES };
