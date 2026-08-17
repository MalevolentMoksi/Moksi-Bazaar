// tests/flipDirections.test.js
//
// /flip only ever flipped one way. It turns five now, and the two halves of
// that are worth pinning separately: that the picker's choices each reach a
// different transform, and that those transforms actually move the pixels
// where they claim to.
//
// The second half runs the real sharp pipeline on a four-pixel image. A test
// that only checks which function was called cannot tell 90 clockwise from
// 90 the other way, and that is exactly the mistake worth catching.

jest.mock('../src/utils/media/mediaHelpers', () => ({ handleMediaCommand: jest.fn() }));
jest.mock('../src/utils/media/imageUtils', () => ({
    flip: jest.fn(async () => '/tmp/flipped.png'),
    flop: jest.fn(async () => '/tmp/flopped.png'),
    rotate: jest.fn(async () => '/tmp/rotated.png'),
}));

const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { handleMediaCommand } = require('../src/utils/media/mediaHelpers');
const img = require('../src/utils/media/imageUtils');
const commands = require('../src/commands/media/imageEffects');

const flip = commands.find(c => c.data.name === 'flip');

/** Runs /flip with a direction and then the processFn it handed the wrapper. */
async function runFlip(direction) {
    jest.clearAllMocks();
    await flip.execute({ options: { getString: name => (name === 'direction' ? direction : null) } });
    const { processFn } = handleMediaCommand.mock.calls[0][1];
    await processFn('/in.png', 'png', { isVideo: false });
}

describe('what the picker offers', () => {
    const json = flip.data.toJSON();
    const direction = json.options.find(o => o.name === 'direction');

    test('all five directions are offered, and none is required', () => {
        expect(direction.choices.map(c => c.value))
            .toEqual(['vertical', 'horizontal', '90', '180', '270']);
        expect(direction.required).toBeFalsy();
        // The attachment stays optional too: recent media is the usual path.
        expect(json.options.find(o => o.name === 'media').required).toBeFalsy();
    });

    test('the description no longer promises only one direction', () => {
        expect(json.description).not.toMatch(/vertically/);
        expect(json.description.length).toBeLessThanOrEqual(100);
        for (const choice of direction.choices) expect(choice.name.length).toBeLessThanOrEqual(100);
    });
});

describe('each direction reaches its own transform', () => {
    test('vertical is the flip, and stays the default', async () => {
        await runFlip('vertical');
        expect(img.flip).toHaveBeenCalledWith('/in.png', 'png', { isVideo: false });
        expect(img.flop).not.toHaveBeenCalled();
        expect(img.rotate).not.toHaveBeenCalled();

        // A bare /flip, exactly as it behaved before the option existed.
        await runFlip(null);
        expect(img.flip).toHaveBeenCalledTimes(1);
    });

    test('horizontal is the flop', async () => {
        await runFlip('horizontal');
        expect(img.flop).toHaveBeenCalledWith('/in.png', 'png', { isVideo: false });
        expect(img.flip).not.toHaveBeenCalled();
    });

    test('each right angle rotates by its own amount', async () => {
        for (const degrees of [90, 180, 270]) {
            await runFlip(String(degrees));
            expect(img.rotate).toHaveBeenCalledWith('/in.png', degrees, 'png', { isVideo: false });
        }
    });

    test('a direction Discord never offered falls back to vertical', async () => {
        // Choices are enforced by Discord, not by us, and an old client or a
        // renamed value must not leave the command doing nothing at all.
        await runFlip('sideways');
        expect(img.flip).toHaveBeenCalledTimes(1);
    });
});

describe('the pixels actually move', () => {
    // Bypasses the mock above: this half is about the real transforms.
    const real = jest.requireActual('../src/utils/media/imageUtils');
    const { cleanup } = jest.requireActual('../src/utils/media/tempFiles');

    const R = [255, 0, 0], G = [0, 255, 0], B = [0, 0, 255], W = [255, 255, 255];
    /** A 2x2 with no symmetry at all: red green over blue white. */
    const SOURCE = [R, G, B, W];

    let input;
    const written = [];

    beforeAll(async () => {
        input = path.join(os.tmpdir(), `mbazaar_test_flip_${process.pid}.png`);
        await sharp(Buffer.from(SOURCE.flat()), { raw: { width: 2, height: 2, channels: 3 } })
            .png().toFile(input);
    });

    afterAll(async () => {
        await cleanup(input, ...written);
    });

    /** The output's four pixels, row by row, as [r,g,b] triples. */
    async function pixels(outputPath) {
        written.push(outputPath);
        const { data } = await sharp(outputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        return [[...data.slice(0, 3)], [...data.slice(3, 6)], [...data.slice(6, 9)], [...data.slice(9, 12)]];
    }

    test('vertical turns it upside down', async () => {
        expect(await pixels(await real.flip(input, 'png', {}))).toEqual([B, W, R, G]);
    });

    test('horizontal mirrors it', async () => {
        expect(await pixels(await real.flop(input, 'png', {}))).toEqual([G, R, W, B]);
    });

    test('90 turns it a quarter clockwise, not anticlockwise', async () => {
        // The one a call-count test cannot catch: both directions call rotate.
        expect(await pixels(await real.rotate(input, 90, 'png', {}))).toEqual([B, R, W, G]);
    });

    test('180 is a half turn', async () => {
        expect(await pixels(await real.rotate(input, 180, 'png', {}))).toEqual([W, B, G, R]);
    });

    test('270 turns it the other quarter', async () => {
        expect(await pixels(await real.rotate(input, 270, 'png', {}))).toEqual([G, W, R, B]);
    });
});
