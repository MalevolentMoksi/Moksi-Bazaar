// tests/persona.test.js
//
// The bot used to be told it was a goat, and answered accordingly: "i don't
// play games. i'm a goat.", "movies are for softer goats". Four separate
// prompts carried that identity, which is exactly how a persona survives
// being removed from the one you remembered.
//
// The reaction emoji are still goat images and their KEY NAMES still say so;
// that is deliberate and stays. What must not come back is a prompt telling
// the model what it is.

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** Every file that puts a persona description in front of a model. */
const PROMPT_FILES = [
    'src/commands/tools/speak.js',
    'src/utils/casinoHeckle.js',
    'src/utils/speakProfile.js',
    'src/commands/tools/checkrelationship.js',
];

describe('no prompt tells the model it is an animal', () => {
    test.each(PROMPT_FILES)('%s describes no species', (file) => {
        const source = read(file);
        for (const phrase of ['goat AI', 'cynical goat', 'a goat.', 'you are a goat']) {
            expect(source.toLowerCase()).not.toContain(phrase.toLowerCase());
        }
    });

    test('the emoji keys are explicitly disclaimed, since they still say goat', () => {
        // Without this the identity walks straight back in through the key
        // names sitting in the same prompt.
        const speak = read('src/commands/tools/speak.js');
        expect(speak).toContain('NOT a description of you');
    });

    test('speak.js forbids building a bit out of what it is', () => {
        expect(read('src/commands/tools/speak.js')).toContain('no species, mascot, animal form or gimmick');
    });

    test('the bot does not call itself the Goat in its own copy', () => {
        for (const file of ['src/commands/tools/remind.js']) {
            expect(read(file)).not.toMatch(/\bthe Goat\b/);
        }
    });

    test('the goat emoji themselves are untouched: they were explicitly kept', () => {
        const constants = read('src/utils/constants.js');
        expect(constants).toContain('goat_meditate');
        expect(constants).toContain('GOAT_EMOJIS');
    });
});
