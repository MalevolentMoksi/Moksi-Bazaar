// tests/snapshot.test.js
//
// The structure snapshot had two destination resolutions: one in the weekly
// scheduler and one behind the "Snapshot now" button, and they disagreed about
// the fallback. That is the worst shape a backup bug can take. You press the
// button, watch the file arrive where you expected, and the scheduled copy has
// been going somewhere else the whole time.
//
// There is one resolver now, and these pin it.

const { resolveChannel } = require('../src/utils/joinGate/snapshot');

describe('one destination, resolved in one place', () => {
    test('the guard channel wins when it is set', () => {
        expect(resolveChannel({ guard_channel_id: 'g', log_channel_id: 'l' }, 'b')).toBe('g');
    });

    test('the log channel is next', () => {
        expect(resolveChannel({ guard_channel_id: null, log_channel_id: 'l' }, 'b')).toBe('l');
    });

    test('the backup channel is the last resort', () => {
        expect(resolveChannel({ guard_channel_id: null, log_channel_id: null }, 'b')).toBe('b');
    });

    test('nothing set resolves to nothing, rather than to a guess', () => {
        expect(resolveChannel({}, null)).toBeNull();
        expect(resolveChannel(null, null)).toBeNull();
    });

    test('an empty string is not a channel', () => {
        // The settings row stores '' rather than NULL in places, and sending a
        // backup to channel "" fails in a much more confusing way than not
        // sending it at all.
        expect(resolveChannel({ guard_channel_id: '', log_channel_id: '' }, 'b')).toBe('b');
    });
});

describe('the module cannot restore anything', () => {
    test('it only ever reads the guild', () => {
        // Capture only, deliberately. Recreating a server from a file is
        // destructive and should not sit one mis-click away inside a panel.
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'src', 'utils', 'joinGate', 'snapshot.js'), 'utf8');
        for (const call of [
            'channels.create(', 'roles.create(', '.setPermissions(', '.roles.add(',
            '.setName(', '.edit(', '.delete(',
        ]) {
            expect(source).not.toContain(call);
        }
    });
});
