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

function downloadToTemp(url, ext) {
    const dest = createTempPath(ext || 'bin');
    return new Promise((resolve, reject) => {
        const MAX_REDIRECTS = 5;

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
            mod.get(u, {
                headers: {
                    'User-Agent': 'MoksisBazaarBot/1.0',
                    Accept: '*/*',
                },
            }, async (res) => {
                if ([301, 302, 307, 308].includes(res.statusCode)) {
                    if (redirects >= MAX_REDIRECTS) {
                        res.resume();
                        return reject(new Error('Too many redirects downloading media'));
                    }
                    const location = res.headers.location;
                    if (!location) {
                        res.resume();
                        return reject(new Error('Redirect missing location header while downloading media'));
                    }
                    let nextUrl;
                    try {
                        nextUrl = new URL(location, u).toString();
                    } catch {
                        res.resume();
                        return reject(new Error('Invalid redirect URL while downloading media'));
                    }
                    res.resume();
                    return get(nextUrl, redirects + 1);
                }

                if (res.statusCode !== 200) {
                    const body = await readSmallBody(res);
                    const suffix = body ? `: ${body}` : '';
                    return reject(new Error(`HTTP ${res.statusCode} downloading media${suffix}`));
                }

                const contentType = String(res.headers['content-type'] || '').toLowerCase();
                const looksLikeText = contentType.startsWith('text/')
                    || contentType.includes('json')
                    || contentType.includes('xml')
                    || contentType.includes('javascript');

                if (looksLikeText) {
                    const body = await readSmallBody(res);
                    const suffix = body ? `: ${body}` : '';
                    return reject(new Error(`Unexpected non-media download response (${contentType || 'unknown'})${suffix}`));
                }

                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => file.close(() => resolve(dest)));
                file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
            }).on('error', reject);
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
const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);

module.exports = { createTempPath, downloadToTemp, cleanup, extFromUrl, IMAGE_EXTS, VIDEO_EXTS, MEDIA_EXTS };
