// tests/fontSetup.test.js
//
// /caption and /meme ask an SVG for "Impact" and let sharp render it. That
// lookup goes through fontconfig, which does not search the app directory,
// which is why the Dockerfile registered the bundled fonts with a conf file
// and fc-cache. Railway's Express builder skips the Dockerfile, so the step
// stopped happening and meme text fell back to whatever the base image had.
//
// What is pinned here is the part that has to stay true on every builder:
// the config names our font directory, it ADDS to the system config instead
// of replacing it, and it never overrules a deliberate choice already made.

const fs = require('fs');

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../src/utils/logger');
const { registerBundledFonts, FONT_DIR } = require('../src/utils/media/fontSetup');

const saved = process.env.FONTCONFIG_FILE;

beforeEach(() => {
    delete process.env.FONTCONFIG_FILE;
    jest.clearAllMocks();
});

afterAll(() => {
    if (saved === undefined) delete process.env.FONTCONFIG_FILE;
    else process.env.FONTCONFIG_FILE = saved;
});

describe('the fonts the meme commands need', () => {
    test('the bundled directory exists and actually contains Impact', () => {
        // If this ever fails, /meme has no Impact to find no matter how well
        // the config is written.
        const files = fs.readdirSync(FONT_DIR);
        expect(files.some(f => /impact/i.test(f))).toBe(true);
        expect(files.some(f => /atkinson/i.test(f))).toBe(true);
    });

    test('registration writes a config naming the font directory', () => {
        const confPath = registerBundledFonts();

        expect(confPath).toBeTruthy();
        expect(process.env.FONTCONFIG_FILE).toBe(confPath);

        const conf = fs.readFileSync(confPath, 'utf8');
        expect(conf).toContain(`<dir>${FONT_DIR}</dir>`);
    });

    test('it adds to the system fonts rather than replacing them', () => {
        // Replacing would mean a Docker deploy, which HAS a full font set,
        // silently losing every font except ours.
        const conf = fs.readFileSync(registerBundledFonts(), 'utf8');
        expect(conf).toContain('/etc/fonts/fonts.conf');
        expect(conf).toContain('ignore_missing="yes"');
    });

    test('the cache is pointed somewhere writable', () => {
        // The default lives under $HOME, which containers do not reliably
        // grant, and an unwritable cache warns on every single render.
        const conf = fs.readFileSync(registerBundledFonts(), 'utf8');
        expect(conf).toMatch(/<cachedir>.+<\/cachedir>/);
    });

    test('an existing FONTCONFIG_FILE is left exactly as it was', () => {
        process.env.FONTCONFIG_FILE = '/etc/fonts/deliberate.conf';

        expect(registerBundledFonts()).toBeNull();
        expect(process.env.FONTCONFIG_FILE).toBe('/etc/fonts/deliberate.conf');
    });

    test('a failure is logged and swallowed, never thrown at boot', () => {
        const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
            throw new Error('read-only file system');
        });

        expect(() => registerBundledFonts()).not.toThrow();
        expect(logger.warn).toHaveBeenCalled();

        spy.mockRestore();
    });
});

describe('the config is well-formed enough for fontconfig to parse', () => {
    test('it declares the doctype and closes every tag it opens', () => {
        const conf = fs.readFileSync(registerBundledFonts(), 'utf8');
        expect(conf).toContain('<!DOCTYPE fontconfig');
        expect(conf.trimEnd().endsWith('</fontconfig>')).toBe(true);

        for (const tag of ['fontconfig', 'dir', 'cachedir']) {
            const opens = (conf.match(new RegExp(`<${tag}>`, 'g')) ?? []).length;
            const closes = (conf.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
            expect(opens).toBe(closes);
        }
    });

    test('no font path lands in the config with XML-hostile characters', () => {
        // A path carrying & or < would produce a config fontconfig rejects
        // outright, which fails silently as "no fonts".
        expect(FONT_DIR).not.toMatch(/[<>&"]/);
    });
});
