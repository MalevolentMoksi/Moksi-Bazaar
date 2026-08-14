// tests/mediaRefresh.test.js
//
// "HTTP 404 downloading media: This content is no longer available." on a GIF
// posted seconds ago. Discord CDN links are signed, the client re-signs what
// it renders, and a copy-pasted or forwarded link keeps the ORIGINAL long-dead
// signature: alive on screen, dead for anyone reading the raw URL. The repair
// is Discord's own refresh-urls endpoint, plus a scanner that can see into
// forwarded messages at all.

jest.mock('../src/utils/media/tempFiles', () => ({
    ...jest.requireActual('../src/utils/media/tempFiles'),
    downloadToTemp: jest.fn(),
}));

const { downloadToTemp } = require('../src/utils/media/tempFiles');
const {
    discordUrlExpiry, refreshDiscordUrls, downloadMediaToTemp, fetchRecentMedia,
} = require('../src/utils/media/mediaHelpers');

beforeEach(() => jest.clearAllMocks());

const hexAt = secondsFromNow => Math.floor(Date.now() / 1000 + secondsFromNow).toString(16);
const cdnUrl = ex => `https://cdn.discordapp.com/attachments/1/2/hi-chat.gif${ex ? `?ex=${ex}&is=abc&hm=def` : ''}`;

describe('reading the signature clock', () => {
    test('the ex param is hex epoch seconds, and only Discord hosts have one', () => {
        const ex = hexAt(3600);
        const at = discordUrlExpiry(cdnUrl(ex));
        expect(at).toBe(parseInt(ex, 16) * 1000);
        expect(discordUrlExpiry(`https://media.discordapp.net/attachments/1/2/a.png?ex=${ex}`)).not.toBeNull();
    });

    test('other hosts, missing params and garbage hex are all "not signed"', () => {
        expect(discordUrlExpiry('https://media.tenor.com/x/y.mp4?ex=abcdef')).toBeNull();
        expect(discordUrlExpiry(cdnUrl(null))).toBeNull();
        expect(discordUrlExpiry('https://cdn.discordapp.com/attachments/1/2/a.gif?ex=zz!!')).toBeNull();
        expect(discordUrlExpiry(null)).toBeNull();
    });
});

describe('asking Discord for fresh signatures', () => {
    test('refreshed urls come back mapped to their originals', async () => {
        const dead = cdnUrl(hexAt(-3600));
        const rest = { post: jest.fn().mockResolvedValue({ refreshed_urls: [{ original: dead, refreshed: cdnUrl(hexAt(3600)) }] }) };
        const map = await refreshDiscordUrls(rest, [dead, 'https://media.tenor.com/x.mp4']);
        expect(map.get(dead)).toContain('cdn.discordapp.com');
        // The tenor URL is not Discord's to refresh and was never sent.
        expect(rest.post.mock.calls[0][1].body.attachment_urls).toEqual([dead]);
    });

    test('a refresh that fails leaves the originals to fail and say why', async () => {
        const rest = { post: jest.fn().mockRejectedValue(new Error('403')) };
        const map = await refreshDiscordUrls(rest, [cdnUrl(hexAt(-1))]);
        expect(map.size).toBe(0);
    });

    test('no rest client and no eligible urls both cost zero requests', async () => {
        expect((await refreshDiscordUrls(null, [cdnUrl(hexAt(-1))])).size).toBe(0);
        const rest = { post: jest.fn() };
        expect((await refreshDiscordUrls(rest, ['https://media.tenor.com/x.mp4'])).size).toBe(0);
        expect(rest.post).not.toHaveBeenCalled();
    });
});

describe('the download path heals a dead signature', () => {
    test('a signature already dead is refreshed BEFORE the doomed request', async () => {
        const dead = cdnUrl(hexAt(-3600));
        const fresh = cdnUrl(hexAt(3600));
        const rest = { post: jest.fn().mockResolvedValue({ refreshed_urls: [{ original: dead, refreshed: fresh }] }) };
        downloadToTemp.mockResolvedValue('/tmp/ok.gif');

        await expect(downloadMediaToTemp({ url: dead, backupUrl: null, ext: 'gif' }, rest)).resolves.toBe('/tmp/ok.gif');
        expect(downloadToTemp).toHaveBeenCalledTimes(1);
        expect(downloadToTemp.mock.calls[0][0]).toBe(fresh);
    });

    test('a 404 on an unsigned-looking Discord link earns one refresh and one retry', async () => {
        const url = cdnUrl(null);
        const fresh = cdnUrl(hexAt(3600));
        const rest = { post: jest.fn().mockResolvedValue({ refreshed_urls: [{ original: url, refreshed: fresh }] }) };
        downloadToTemp
            .mockRejectedValueOnce(new Error('HTTP 404 downloading media: This content is no longer available.'))
            .mockResolvedValueOnce('/tmp/ok.gif');

        await expect(downloadMediaToTemp({ url, backupUrl: null, ext: 'gif' }, rest)).resolves.toBe('/tmp/ok.gif');
        expect(downloadToTemp).toHaveBeenLastCalledWith(fresh, 'gif', expect.any(Object));
    });

    test('a 404 on a host Discord cannot refresh stays an honest 404', async () => {
        const rest = { post: jest.fn() };
        downloadToTemp.mockRejectedValue(new Error('HTTP 404 downloading media'));
        await expect(downloadMediaToTemp({ url: 'https://media.tenor.com/x/y.mp4', backupUrl: null, ext: 'mp4' }, rest))
            .rejects.toThrow('HTTP 404');
        expect(rest.post).not.toHaveBeenCalled();
    });

    test('the proxy url still gets its turn when the primary fails outright', async () => {
        downloadToTemp
            .mockRejectedValueOnce(new Error('HTTP 500 downloading media'))
            .mockResolvedValueOnce('/tmp/ok.png');
        const info = { url: 'https://example.com/a.png', backupUrl: 'https://example.com/proxy/a.png', ext: 'png' };
        await expect(downloadMediaToTemp(info, null)).resolves.toBe('/tmp/ok.png');
        expect(downloadToTemp.mock.calls[1][0]).toBe(info.backupUrl);
    });
});

describe('the scanner sees forwarded messages', () => {
    const message = over => ({ attachments: new Map(), embeds: [], ...over });

    const interactionWith = messages => ({
        channel: { messages: { fetch: jest.fn().mockResolvedValue(new Map(messages.map((m, i) => [String(i), m]))) } },
    });

    test('a forward-only GIF is found inside its snapshot', async () => {
        const snapshot = message({
            attachments: new Map([['1', {
                url: cdnUrl(hexAt(-3600)), contentType: 'image/gif', proxyURL: 'https://media.discordapp.net/x.gif',
            }]]),
        });
        const forward = message({ messageSnapshots: new Map([['0', snapshot]]) });

        const info = await fetchRecentMedia(interactionWith([forward]), { allowImage: true });
        expect(info?.ext).toBe('gif');
        expect(info.url).toContain('hi-chat.gif');
    });

    test('a plain message without snapshots still scans exactly as before', async () => {
        const plain = message({
            attachments: new Map([['1', { url: 'https://example.com/a.png', contentType: 'image/png', proxyURL: null }]]),
        });
        const info = await fetchRecentMedia(interactionWith([plain]), { allowImage: true });
        expect(info?.ext).toBe('png');
    });
});
