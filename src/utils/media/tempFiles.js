// src/utils/media/tempFiles.js
const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

function createTempPath(ext) {
    const id = crypto.randomUUID();
    return path.join(os.tmpdir(), `mbazaar_${id}.${ext}`);
}

/**
 * @param {string} url
 * @param {string} ext extension for the temp file name
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] hard cap enforced on the wire, not just on a
 *   declared header. A server that lies about (or omits) Content-Length gets
 *   cut off mid-stream instead of filling the disk.
 * @param {number} [opts.timeoutMs] overall deadline. Without it a server that
 *   drips one byte a minute holds the socket, and the temp file, forever.
 */
function downloadToTemp(url, ext, { maxBytes = 0, timeoutMs = 0 } = {}) {
    const dest = createTempPath(ext || 'bin');
    return new Promise((resolve, reject) => {
        const MAX_REDIRECTS = 5;
        let settled = false;
        let timer = null;
        let activeReq = null;
        let activeFile = null;

        // Every exit funnels through these two, so the timer is always
        // cleared, the socket always destroyed, and the partial file always
        // unlinked. Rejecting without aborting is how the old code kept
        // downloading long after the caller had given up.
        function fail(err) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { activeReq?.destroy(); } catch {}
            if (activeFile) {
                activeFile.destroy();
                activeFile.once('close', () => fs.unlink(dest, () => {}));
            } else {
                fs.unlink(dest, () => {});
            }
            reject(err);
        }
        function succeed() {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(dest);
        }

        if (timeoutMs > 0) {
            timer = setTimeout(() => fail(new Error(`Download timed out after ${timeoutMs}ms`)), timeoutMs);
        }

        function readSmallBody(res, maxChars = 400) {
            return new Promise((resResolve) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    if (body.length < maxChars) body += chunk;
                });
                res.on('end', () => resResolve(body.trim().slice(0, maxChars)));
                res.on('error', () => resResolve(''));
            });
        }

        function get(u, redirects = 0) {
            const mod = u.startsWith('https') ? https : http;
            activeReq = mod.get(u, {
                headers: {
                    'User-Agent': 'MoksisBazaarBot/1.0',
                    Accept: '*/*',
                },
            }, async (res) => {
                if ([301, 302, 307, 308].includes(res.statusCode)) {
                    if (redirects >= MAX_REDIRECTS) {
                        res.resume();
                        return fail(new Error('Too many redirects downloading media'));
                    }
                    const location = res.headers.location;
                    if (!location) {
                        res.resume();
                        return fail(new Error('Redirect missing location header while downloading media'));
                    }
                    let nextUrl;
                    try {
                        nextUrl = new URL(location, u).toString();
                    } catch {
                        res.resume();
                        return fail(new Error('Invalid redirect URL while downloading media'));
                    }
                    res.resume();
                    return get(nextUrl, redirects + 1);
                }

                if (res.statusCode !== 200) {
                    const body = await readSmallBody(res);
                    const suffix = body ? `: ${body}` : '';
                    return fail(new Error(`HTTP ${res.statusCode} downloading media${suffix}`));
                }

                const declared = Number(res.headers['content-length'] || 0);
                if (maxBytes > 0 && declared > maxBytes) {
                    res.resume();
                    return fail(new Error(`Media is ${declared} bytes, over the ${maxBytes} byte cap`));
                }

                const contentType = String(res.headers['content-type'] || '').toLowerCase();
                const looksLikeText = contentType.startsWith('text/')
                    || contentType.includes('json')
                    || contentType.includes('xml')
                    || contentType.includes('javascript');

                if (looksLikeText) {
                    const body = await readSmallBody(res);
                    const suffix = body ? `: ${body}` : '';
                    return fail(new Error(`Unexpected non-media download response (${contentType || 'unknown'})${suffix}`));
                }

                const file = fs.createWriteStream(dest);
                activeFile = file;
                let received = 0;
                if (maxBytes > 0) {
                    res.on('data', chunk => {
                        received += chunk.length;
                        if (received > maxBytes) {
                            fail(new Error(`Media exceeded the ${maxBytes} byte cap mid-download`));
                        }
                    });
                }
                res.pipe(file);
                file.on('finish', () => file.close(() => succeed()));
                file.on('error', err => fail(err));
            });
            activeReq.on('error', err => fail(err));
        }
        get(url);
    });
}

async function cleanup(...paths) {
    for (const p of paths) {
        if (!p) continue;
        try { await fs.promises.unlink(p); } catch {}
    }
}

function extFromUrl(url) {
    return path.extname(url.split('?')[0]).slice(1).toLowerCase() || 'bin';
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma']);
const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS]);

module.exports = { createTempPath, downloadToTemp, cleanup, extFromUrl, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, MEDIA_EXTS };
