// src/utils/media/concurrency.js
// A small FIFO semaphore so heavy media jobs (ffmpeg encodes, magick seam-carving)
// don't all run at once and thrash CPU / starve the Discord gateway. Sized to the
// host's CPU count, leaving a couple cores for the event loop. Mirrors MediaForge's
// asyncio.Semaphore(workers) queue.
const os = require('os');

const DEFAULT_WORKERS = Math.max(1, (os.cpus()?.length || 2) - 1);

class Semaphore {
    constructor(max = DEFAULT_WORKERS) {
        this.max = Math.max(1, max);
        this.active = 0;
        this.waiting = [];
    }

    get queued() {
        return this.waiting.length;
    }

    async acquire() {
        if (this.active < this.max) {
            this.active++;
            return;
        }
        await new Promise(resolve => this.waiting.push(resolve));
        this.active++;
    }

    release() {
        this.active = Math.max(0, this.active - 1);
        const next = this.waiting.shift();
        if (next) next();
    }

    // Run fn() while holding a slot. Always releases, even on throw.
    async run(fn) {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

// Shared singleton used by all media commands.
const mediaSemaphore = new Semaphore();

module.exports = { Semaphore, mediaSemaphore, DEFAULT_WORKERS };
