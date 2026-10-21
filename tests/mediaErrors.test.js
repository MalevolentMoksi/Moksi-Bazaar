// tests/mediaErrors.test.js
/**
 * A failed media command used to answer with "❌ Processing failed: " and
 * ffmpeg's stderr, temp paths included. These pin the plain line it says
 * instead, and the short reason kept underneath it.
 */

const { describeMediaFailure, technicalDetail } = require('../src/utils/media/mediaErrors');

const ffmpeg = tail => new Error(`FFmpeg error: ffmpeg exited with code 1: ${tail}`);

describe('describeMediaFailure', () => {
    test('a file ffmpeg cannot read is called that, with the reason underneath', () => {
        const text = describeMediaFailure(ffmpeg('/tmp/moksi-media/9f2c.mp4: Invalid data found when processing input'));
        const [line, detail] = text.split('\n');
        expect(line).toBe("Couldn't read that file; it may be damaged or an odd format.");
        expect(detail).toBe('-# file: Invalid data found when processing input');
    });

    test('temp paths never reach the reader, on either platform', () => {
        expect(technicalDetail('C:\\Users\\bot\\AppData\\Local\\Temp\\x\\in.gif: moov atom not found'))
            .toBe('file: moov atom not found');
        expect(technicalDetail('FFmpeg GIF error: /app/tmp/a/b.gif: End of file')).toBe('file: End of file');
    });

    test.each([
        [new Error('Download timed out after 45000ms'), "Couldn't fetch that file."],
        [new Error('HTTP 404 downloading media'), "Couldn't fetch that file."],
        [new Error('Media exceeded the 67108864 byte cap mid-download'), 'That file is too big to fetch'],
        [new Error('FFmpeg timed out after 120000ms'), 'That took too long to process'],
        [ffmpeg('Stream map \'0:a\' matches no streams.'), 'That file has no audio track'],
        [new Error('ImageMagick is not installed on this host.'), "The tool this needs isn't available"],
        [new Error('Processing produced no output file.'), 'Processing finished without producing anything.'],
    ])('%p reads as a plain line', (error, start) => {
        expect(describeMediaFailure(error).startsWith(start)).toBe(true);
    });

    test('a message already written for people passes through as it is', () => {
        const message = 'No caption detected at the top of this media. Try a lower threshold.';
        expect(describeMediaFailure(new Error(message))).toBe(message);
    });

    test('an unknown failure still gets a plain line, and a command can supply its own', () => {
        expect(describeMediaFailure(new Error('something odd')))
            .toBe('Something went wrong processing that file.\n-# something odd');
        expect(describeMediaFailure(new Error('ERROR: Unsupported URL: https://x.test/a'), { fallback: 'Could not download.' }))
            .toBe('Could not download.\n-# Unsupported URL: https://x.test/a');
    });

    test('the detail is one clipped line', () => {
        const long = `${'word '.repeat(80)}\nlast line wins`;
        expect(technicalDetail(long)).toBe('last line wins');
        expect(technicalDetail('x'.repeat(400)).length).toBe(140);
        expect(technicalDetail('')).toBe('');
    });
});
