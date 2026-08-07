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

// Removing the goat did not stop it dodging, it just changed the dodge.
// "mp4 huh. groundbreaking." and "i don't watch that trash" are the same move
// as "i'm a goat": a reply that commits to nothing and reveals nothing.
describe('the bot has to actually say something', () => {
    const speak = () => read('src/commands/tools/speak.js');

    test('a jab must have a target, and a file type is not one', () => {
        const source = speak();
        expect(source).toContain('A jab has to be about the actual thing in front of you');
        expect(source).toMatch(/not a joke, it is a description of a file format/);
    });

    test('refusing to have an opinion is named as a dodge, like the animal bit was', () => {
        expect(speak()).toContain('Commit to opinions');
        expect(speak()).toMatch(/Asked for a favourite, name one/);
    });

    test('unbroken dismissal is called out as its own rut', () => {
        expect(speak()).toContain('Vary the shape');
    });

    test('it knows it is a bot version of Moksi, and that they are two people', () => {
        const source = speak();
        expect(source).toContain('Know who you are');
        expect(source).toMatch(/a bot Moksi built and modelled on himself/);
        expect(source).toMatch(/two different people/);
        // The specific slip: "HES JUST LIKE ME FR" answered with "you don't
        // even know who that is", because it never considered it was the "he".
        expect(source).toMatch(/third person/);
    });
});

// The prompt tells the model to treat media tags as things it saw, so a tag
// naming a file rather than contents produced confident nonsense.
describe('media tags never describe a file instead of a picture', () => {
    test('no tag hands the model a filename or the word unanalyzed', () => {
        const db = read('src/utils/db.js');
        expect(db).not.toMatch(/\[Video File: /);
        expect(db).not.toMatch(/Unanalyzed \$\{/);
        expect(db).not.toMatch(/\(Analysis Failed\)/);
    });

    test('an unseen item says so in words that cannot be mistaken for a description', () => {
        expect(read('src/utils/db.js')).toContain('contents not seen');
    });

    test('the prompt tells the model what an unseen tag means', () => {
        const source = read('src/commands/tools/speak.js');
        expect(source).toContain('"contents not seen" means exactly that');
        expect(source).toMatch(/do not comment on the file type/);
    });

    test('videos are sampled rather than named', () => {
        const db = read('src/utils/db.js');
        expect(db).toContain('firstFrameDataUri');
        expect(db).toContain('describeVideo');
    });

    test('every message in the window gets described, not only the newest', () => {
        const source = read('src/commands/tools/speak.js');
        expect(source).toContain('processMediaInMessage(msg, true,');
        expect(source).not.toContain('newestUserMsgId');
    });
});

