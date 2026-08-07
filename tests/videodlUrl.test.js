// tests/videodlUrl.test.js
//
// /videodl hands whatever URL it is given to yt-dlp, and it is open to every
// member of the server. The check in front of it only asked whether the
// protocol was http(s), which meant anyone could aim the container's network
// stack at itself: the dashboard on localhost, a Railway service reachable
// only on the private network, or a cloud metadata endpoint. None of those
// are videos, but the request still happens and the failure text comes back
// to whoever asked.

const { looksLikeUrl } = require('../src/commands/media/videodl');

describe('what /videodl will fetch', () => {
    test('ordinary public video URLs pass', () => {
        for (const url of [
            'https://www.youtube.com/watch?v=abc123',
            'http://twitter.com/someone/status/1',
            'https://www.tiktok.com/@someone/video/1',
            'https://cdn.example.co.uk/clip.mp4',
        ]) {
            expect(looksLikeUrl(url)).toBe(true);
        }
    });

    test('anything that is not http(s) is refused', () => {
        for (const url of [
            'file:///etc/passwd',
            'ftp://example.com/x.mp4',
            'gopher://example.com',
            'not a url at all',
            '',
        ]) {
            expect(looksLikeUrl(url)).toBe(false);
        }
    });

    test('the container itself is not a video host', () => {
        for (const url of [
            'http://localhost:3000/',
            'http://127.0.0.1:8080/brain',
            'http://[::1]:3000/',
            'http://0.0.0.0:3000/',
        ]) {
            expect(looksLikeUrl(url)).toBe(false);
        }
    });

    test('cloud metadata and private ranges are refused', () => {
        for (const url of [
            'http://169.254.169.254/latest/meta-data/',   // the classic
            'http://10.0.0.5/',
            'http://192.168.1.1/',
            'http://172.16.0.1/',
            'http://172.31.255.255/',
            'http://[fd00::1]/',
        ]) {
            expect(looksLikeUrl(url)).toBe(false);
        }
    });

    test('public addresses that merely look private-adjacent still pass', () => {
        // 172.32 is outside 172.16/12, and these are real public ranges.
        for (const url of ['http://172.32.0.1/', 'http://11.0.0.1/', 'http://169.253.0.1/']) {
            expect(looksLikeUrl(url)).toBe(true);
        }
    });

    test('bare service names are refused: they only resolve on a private network', () => {
        for (const url of [
            'http://postgres/',
            'http://redis:6379/',
            'https://bot.railway.internal/',
            'http://printer.local/',
        ]) {
            expect(looksLikeUrl(url)).toBe(false);
        }
    });
});
