// tests/backup.test.js
//
// The dump itself needs a database; delivery does not. The build step is
// injected so these tests exercise the part that has real failure modes:
// two destinations, either of which can be dead, and a size cap that must
// refuse before anything is sent.

const { sendBackup, backupFilename, MAX_ATTACHMENT_BYTES } = require('../src/utils/backup');

const smallDump = async () => ({
    buffer: Buffer.from('pretend-gzip'),
    meta: { tables: 2, totalRows: 5, counts: { balances: 3, warns: 2 }, truncated: [], bytes: 12 },
});

function fakeWorld({ channelAlive = true, dmAlive = true } = {}) {
    const channel = { isTextBased: () => true, send: jest.fn(async () => {}) };
    const user = { send: jest.fn(async () => {}) };
    const client = {
        channels: { fetch: async () => (channelAlive ? channel : null) },
        users: {
            fetch: async () => {
                if (!dmAlive) throw new Error('Unknown User');
                return user;
            },
        },
    };
    return { client, channel, user };
}

describe('backup delivery', () => {
    test('one build, two sends: channel and DM both get the file', async () => {
        const { client, channel, user } = fakeWorld();
        const result = await sendBackup(client, { channelId: 'c1', dmUserId: 'u1' }, { build: smallDump });
        expect(result.ok).toBe(true);
        expect(result.sentTo).toEqual(['channel', 'DM']);
        expect(result.errors).toEqual([]);
        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(user.send).toHaveBeenCalledTimes(1);
    });

    test('a dead channel does not cost the DM copy', async () => {
        const { client, user } = fakeWorld({ channelAlive: false });
        const result = await sendBackup(client, { channelId: 'gone', dmUserId: 'u1' }, { build: smallDump });
        expect(result.ok).toBe(true);
        expect(result.sentTo).toEqual(['DM']);
        expect(result.errors[0]).toContain('Channel copy failed');
        expect(user.send).toHaveBeenCalledTimes(1);
    });

    test('closed DMs do not cost the channel copy', async () => {
        const { client, channel } = fakeWorld({ dmAlive: false });
        const result = await sendBackup(client, { channelId: 'c1', dmUserId: 'u1' }, { build: smallDump });
        expect(result.ok).toBe(true);
        expect(result.sentTo).toEqual(['channel']);
        expect(result.errors[0]).toContain('DM copy failed');
        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    test('an oversized dump is refused before anything is sent', async () => {
        const { client, channel, user } = fakeWorld();
        const huge = async () => ({
            buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
            meta: { tables: 1, totalRows: 1, counts: { x: 1 }, truncated: [], bytes: MAX_ATTACHMENT_BYTES + 1 },
        });
        const result = await sendBackup(client, { channelId: 'c1', dmUserId: 'u1' }, { build: huge });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain('upload limit');
        expect(channel.send).not.toHaveBeenCalled();
        expect(user.send).not.toHaveBeenCalled();
    });

    test('no destinations means an honest refusal, not a silent success', async () => {
        const { client } = fakeWorld();
        const result = await sendBackup(client, {}, { build: smallDump });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain('Nowhere');
    });

    test('a build failure is reported, not thrown', async () => {
        const { client } = fakeWorld();
        const boom = async () => { throw new Error('connection refused'); };
        const result = await sendBackup(client, { dmUserId: 'u1' }, { build: boom });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain('Building the dump failed');
    });

    test('the fallback DM stays quiet when the channel took it', async () => {
        const { client, channel, user } = fakeWorld();
        const result = await sendBackup(client, { channelId: 'c1', fallbackDmUserId: 'u1' }, { build: smallDump });
        expect(result.sentTo).toEqual(['channel']);
        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(user.send).not.toHaveBeenCalled();
    });

    test('the fallback DM fires when the channel is gone', async () => {
        const { client, user } = fakeWorld({ channelAlive: false });
        const result = await sendBackup(client, { channelId: 'gone', fallbackDmUserId: 'u1' }, { build: smallDump });
        expect(result.ok).toBe(true);
        expect(result.sentTo).toEqual(['DM']);
        expect(user.send).toHaveBeenCalledTimes(1);
    });

    test('with no channel at all, the fallback is the whole delivery', async () => {
        const { client, user } = fakeWorld();
        const result = await sendBackup(client, { fallbackDmUserId: 'u1' }, { build: smallDump });
        expect(result.sentTo).toEqual(['DM']);
        expect(user.send).toHaveBeenCalledTimes(1);
    });

    test('both destinations dead is an honest failure', async () => {
        const { client } = fakeWorld({ channelAlive: false, dmAlive: false });
        const result = await sendBackup(client, { channelId: 'gone', fallbackDmUserId: 'u1' }, { build: smallDump });
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('Fallback DM failed');
    });

    test('the filename carries the date', () => {
        expect(backupFilename(new Date('2026-08-04T12:00:00Z'))).toBe('bazaar-backup-2026-08-04.json.gz');
    });
});
