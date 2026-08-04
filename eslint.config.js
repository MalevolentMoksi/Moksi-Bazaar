// eslint.config.js: ESLint 9 flat config.
//
// Replaces .eslintrc.json, which ESLint 9 no longer reads. Preserves the
// original intent: Node environment, ES2021 syntax, eslint:recommended.
//
// `@eslint/js` and `globals` are direct dependencies of eslint itself and are
// deliberately NOT added to package.json: .nixpacks.toml installs with
// `pnpm i --frozen-lockfile`, so a package.json edit without a matching
// lockfile regeneration would fail the deploy. Linting is a local-only
// command, so resolving them through the installed eslint is fine. If a strict
// pnpm install ever hides them, declare both as devDependencies and refresh
// the lockfile in the same commit.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'logs/**',
            'SecretBotStuff/**',
            '.nixpacks/**',
            '.vs/**',
            // Dead experiments kept for reference only. Linting them produces
            // noise about code nobody intends to run again.
            'trashcan/**',
        ],
    },

    js.configs.recommended,

    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.es2021,
            },
        },
        rules: {
            // The codebase deliberately swallows errors on best-effort paths
            // (log sends, temp-file cleanup, deferUpdate). All 31 no-empty hits
            // were verified to be empty catch blocks specifically, not empty
            // if/loop bodies, so this suppresses a house idiom rather than
            // hiding suspicious code. Empty if/for/while blocks still error.
            'no-empty': ['error', { allowEmptyCatch: true }],

            // Same reasoning for the unused binding in `catch (e) {}`.
            // `_`-prefixed names opt out, which is the usual escape hatch for
            // positional args you must accept but do not use.
            'no-unused-vars': ['error', {
                args: 'after-used',
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],
        },
    },

    {
        files: ['**/*.test.js', '**/*.spec.js', '**/__tests__/**/*.js'],
        languageOptions: {
            globals: { ...globals.jest },
        },
    },

    // The dashboard's client script runs in a browser, not in Node.
    {
        files: ['src/web/assets/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.browser },
        },
    },
];
