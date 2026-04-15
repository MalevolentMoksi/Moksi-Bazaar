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
        function get(u) {
            const mod = u.startsWith('https') ? https : http;
            mod.get(u, res => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return get(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} downloading media`));
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
