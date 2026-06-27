// src/utils/media/ytdlpUtils.js
// Thin wrapper around yt-dlp for the /videodl command. Downloads a web-hosted
// video or its audio to a temp file. yt-dlp is invoked via spawn with array args
// (no shell), and on Linux through `nice` to keep priority low.
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

let _binPromise = null;

// Detect yt-dlp (preferred) or youtube-dl. Cached.
function detectBinary() {
    if (!_binPromise) {
        _binPromise = (async () => {
            for (const bin of ['yt-dlp', 'youtube-dl']) {
                const ok = await new Promise(resolve => {
                    let proc;
                    try { proc = spawn(bin, ['--version']); } catch { return resolve(false); }
                    proc.on('error', () => resolve(false));
                    proc.on('close', code => resolve(code === 0));
                });
                if (ok) return bin;
            }
            return null;
        })();
    }
    return _binPromise;
}

async function ytdlpAvailable() {
    return Boolean(await detectBinary());
}

function runYtDlp(args, { timeoutMs = 120000 } = {}) {
    return detectBinary().then(bin => {
        if (!bin) throw new Error('yt-dlp is not installed on this host.');
        const useNice = process.platform !== 'win32';
        const cmd = useNice ? 'nice' : bin;
        const cmdArgs = useNice ? ['-n', '10', bin, ...args] : args;
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = spawn(cmd, cmdArgs);
            } catch (e) {
                return reject(new Error(`yt-dlp failed to start: ${e.message}`));
            }
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch {}
                reject(new Error('Download timed out.'));
            }, timeoutMs);
            proc.stdout.on('data', d => { stdout += d.toString(); });
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', err => {
                clearTimeout(timer);
                // Fall back to no-nice if `nice` is missing.
                if (useNice && err.code === 'ENOENT') {
                    return runYtDlp(args, { timeoutMs }).then(resolve, reject);
                }
                reject(new Error(`yt-dlp failed to start: ${err.message}`));
            });
            proc.on('close', code => {
                clearTimeout(timer);
                if (code === 0) return resolve({ stdout, stderr });
                const detail = (stderr || stdout).trim().split('\n').slice(-2).join(' ');
                reject(new Error(detail || `yt-dlp exited with code ${code}`));
            });
        });
    });
}

// Download `url` to a temp file. mode: 'video' | 'audio'.
// maxBytes caps the chosen format size where possible. Returns the output path.
async function download(url, mode = 'video', { maxBytes = 24 * 1024 * 1024 } = {}) {
    const id = crypto.randomUUID();
    const outTemplate = path.join(os.tmpdir(), `mbazaar_dl_${id}.%(ext)s`);

    // Build a format selector that prefers something under the size cap.
    const sizeCapMB = Math.floor(maxBytes / (1024 * 1024));
    const args = [
        '--no-playlist',
        '--no-warnings',
        '--restrict-filenames',
        '--max-filesize', `${sizeCapMB}M`,
        '-o', outTemplate,
    ];
    if (mode === 'audio') {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5');
    } else {
        // Prefer mp4-compatible, under the cap; fall back to best.
        args.push('-f', `best[filesize<${sizeCapMB}M][ext=mp4]/best[filesize<${sizeCapMB}M]/best`,
            '--merge-output-format', 'mp4');
    }
    args.push('--', url); // `--` stops option parsing; url can't be read as a flag.

    await runYtDlp(args);

    // Find the produced file (extension is templated by yt-dlp).
    const dir = os.tmpdir();
    const prefix = `mbazaar_dl_${id}.`;
    const produced = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix))
        .map(f => path.join(dir, f));
    if (produced.length === 0) {
        throw new Error('Download produced no file (it may be too large or unavailable).');
    }
    // If multiple (e.g. leftover fragments), pick the largest.
    produced.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return produced[0];
}

module.exports = { ytdlpAvailable, download };
