// tests/auditBookkeeping.test.js
//
// The audit listener does two unrelated jobs, and only one of them has an
// off switch.
//
// Recording history obeys no toggle: Discord discards its audit log after 45
// days, so a history only exists if it was being kept before anyone thought
// to ask, and it must include this bot's own work. For a while the recorder
// skipped its own entries and everything behind the gate toggle, which meant
// a gate temp-ban existed only as an embed in a channel and the dashboard
// called the member clean.
//
// The guard is the job with the switch, and it must also never alert on the
// bot's own actions: that would be alerting on its own work.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/joinGate/modlog', () => ({ record: jest.fn(async () => 'kick') }));
jest.mock('../src/utils/joinGate/guard', () => ({
    record: jest.fn(() => null),
    BUCKETS: { BOT: 'bot' },
}));
jest.mock('../src/utils/joinGate/config', () => ({ getSettings: jest.fn() }));

const event = require('../src/events/client/guildAuditLogEntryCreate');
const modlog = require('../src/utils/joinGate/modlog');
const guard = require('../src/utils/joinGate/guard');
const { getSettings } = require('../src/utils/joinGate/config');

const client = { user: { id: 'bot-id' } };
const guild = { id: 'g1' };

beforeEach(() => {
    jest.clearAllMocks();
    getSettings.mockResolvedValue({ enabled: true, guard_enabled: true });
});

describe('recording obeys no toggle', () => {
    test('the bot\'s own actions are recorded, and only the guard skips them', async () => {
        await event.execute({ executorId: 'bot-id' }, guild, client);
        expect(modlog.record).toHaveBeenCalledTimes(1);
        expect(guard.record).not.toHaveBeenCalled();
    });

    test('a disabled gate still keeps history', async () => {
        getSettings.mockResolvedValue({ enabled: false, guard_enabled: false });
        await event.execute({ executorId: 'someone' }, guild, client);
        expect(modlog.record).toHaveBeenCalledTimes(1);
        expect(guard.record).not.toHaveBeenCalled();
    });

    test('an unreadable config still keeps history', async () => {
        getSettings.mockRejectedValue(new Error('db down'));
        await event.execute({ executorId: 'someone' }, guild, client);
        expect(modlog.record).toHaveBeenCalledTimes(1);
        expect(guard.record).not.toHaveBeenCalled();
    });
});

describe('the guard still works where it should', () => {
    test('someone else\'s action feeds the thresholds when the guard is on', async () => {
        await event.execute({ executorId: 'someone' }, guild, client);
        expect(modlog.record).toHaveBeenCalledTimes(1);
        expect(guard.record).toHaveBeenCalledTimes(1);
    });

    test('guard off means counted nowhere but still written down', async () => {
        getSettings.mockResolvedValue({ enabled: true, guard_enabled: false });
        await event.execute({ executorId: 'someone' }, guild, client);
        expect(modlog.record).toHaveBeenCalledTimes(1);
        expect(guard.record).not.toHaveBeenCalled();
    });
});
