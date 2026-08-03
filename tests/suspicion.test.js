// tests/suspicion.test.js
//
// These lock in the four design rules suspicion.js states in its own header.
// They are the rules most likely to be quietly broken by a later tweak to the
// weights, and each one has a real cost when it breaks: rule 1 lets a bought
// profile launder a bad account, rule 4 bans people for writing in their own
// alphabet.

const S = require('../src/utils/joinGate/suspicion');

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/** A fake user whose defaults describe a perfectly ordinary account. */
function user(overrides = {}) {
  const {
    ageDays = 400,
    name = 'normaluser',
    globalName = 'Normal User',
    avatar = 'abc123',
    badges = [],
    id = '111111111111111111',
  } = overrides;
  return {
    id,
    username: name,
    globalName,
    avatar,
    createdTimestamp: NOW - ageDays * DAY,
    flags: { toArray: () => badges },
  };
}

const score = (u, opts = {}) => S.scoreAccount(u, { now: NOW, ...opts });

describe('rule 1: trust is capped', () => {
  test('a maximally trusted profile cannot clear a maximally damning account', () => {
    const damning = {
      ageDays: 0.1,
      name: 'xkjdhfgwqp8412',
      globalName: null,
      avatar: null,
    };
    const bare = score(user(damning));
    const bought = score(user({
      ...damning,
      avatar: 'a_animated',
      badges: S.TRUST_FLAGS.slice(),
    }));

    expect(bare.tier).not.toBe('clear');
    // Trust may pull the score down, but never all the way to innocent.
    expect(bought.score).toBeLessThan(bare.score);
    expect(bought.tier).not.toBe('clear');
  });

  test('the trust bucket never subtracts more than TRUST_CAP', () => {
    // Measured on the bucket, not on the score difference between two users:
    // giving an account an avatar also removes its default-avatar penalty,
    // which is a suspicion signal disappearing rather than trust being applied.
    const bought = score(user({
      ageDays: 0.1,
      name: 'xkjdhfgwqp8412',
      globalName: null,
      avatar: 'a_x',
      badges: S.TRUST_FLAGS.slice(),
    }));
    const trustApplied = bought.signals
      .filter(s => s.points < 0 && s.id !== 'membership_tenure')
      .reduce((sum, s) => sum + s.points, 0);
    expect(trustApplied).toBeGreaterThanOrEqual(-S.TRUST_CAP);
  });

  test('trust is also capped proportionally, so it cannot dominate a mild score', () => {
    // A barely-suspicious account gets a proportionally small allowance, so a
    // fully badged profile cannot drag the score far below where it started.
    const mild = score(user({ ageDays: 40, globalName: null }));
    const mildBadged = score(user({
      ageDays: 40,
      globalName: null,
      badges: S.TRUST_FLAGS.slice(),
    }));
    const allowance = Math.min(S.TRUST_CAP, Math.round(Math.max(0, mild.score) * S.TRUST_MAX_FRACTION));
    expect(mild.score - mildBadged.score).toBeLessThanOrEqual(allowance);
  });
});

describe('rule 4: script is not suspicion', () => {
  // Cyrillic, CJK, Arabic, Greek: whole names in one script are ordinary.
  const names = {
    Cyrillic: 'приветмир',
    CJK: 'こんにちは世界',
    Arabic: 'مرحبابالعالم',
    Greek: 'καλημερακοσμε',
  };

  for (const [script, name] of Object.entries(names)) {
    test(`a name written wholly in ${script} is clear`, () => {
      const result = score(user({ name }));
      expect(result.tier).toBe('clear');
      expect(result.signals.some(s => s.id === 'mixed_script')).toBe(false);
    });
  }

  test('but mixing scripts inside one word is the homoglyph trick', () => {
    // Latin "dministrator" with a Cyrillic a in front.
    const result = score(user({ name: 'аdministrator' }));
    expect(result.signals.some(s => s.id === 'mixed_script')).toBe(true);
  });
});

describe('rule 3: tenure forgives', () => {
  test('a long-standing member scores lower than the same account joining today', () => {
    const profile = { ageDays: 20, name: 'someone1234', globalName: null, avatar: null };
    const fresh = score(user(profile), { member: { joinedTimestamp: NOW } });
    const regular = score(user(profile), {
      member: { joinedTimestamp: NOW - 200 * DAY },
    });
    expect(regular.score).toBeLessThan(fresh.score);
  });

  test('a zero grace means "unset" and falls back to the stock timeline', () => {
    // Deliberate, and the panel says so in as many words. Reading 0 as "no
    // forgiveness at all" would turn an empty settings field into a policy
    // change nobody asked for.
    const profile = { ageDays: 20, name: 'someone1234', globalName: null, avatar: null };
    const member = { joinedTimestamp: NOW - 200 * DAY };
    expect(score(user(profile), { member, tenureGraceDays: 0 }).score)
      .toBe(score(user(profile), { member }).score);
  });

  test('a longer grace forgives more slowly, a shorter one more quickly', () => {
    const profile = { ageDays: 20, name: 'someone1234', globalName: null, avatar: null };
    const member = { joinedTimestamp: NOW - 200 * DAY };
    const strict = score(user(profile), { member, tenureGraceDays: 1095 });
    const stock = score(user(profile), { member });
    const lenient = score(user(profile), { member, tenureGraceDays: 90 });
    expect(strict.score).toBeGreaterThan(stock.score);
    expect(lenient.score).toBeLessThanOrEqual(stock.score);
  });

  test('applyTenure: false skips the damping entirely', () => {
    const profile = { ageDays: 20, name: 'someone1234', globalName: null, avatar: null };
    const member = { joinedTimestamp: NOW - 200 * DAY };
    const damped = score(user(profile), { member });
    const raw = score(user(profile), { member, applyTenure: false });
    expect(raw.score).toBeGreaterThan(damped.score);
  });
});

describe('hidden characters', () => {
  test('zero-width characters in a name are always caught', () => {
    expect(S.hasInvisibleChars(`ad${String.fromCharCode(0x200B)}min`)).toBe(true);
    expect(S.hasInvisibleChars('admin')).toBe(false);
  });

  test('an ordinary account is never flagged for them', () => {
    expect(score(user()).signals.some(s => s.id === 'invisible_chars')).toBe(false);
  });
});

describe('tierFor', () => {
  test('boundaries are inclusive at the bottom of each tier', () => {
    const t = S.DEFAULT_THRESHOLDS;
    expect(S.tierFor(t.watch - 1)).toBe('clear');
    expect(S.tierFor(t.watch)).toBe('watch');
    expect(S.tierFor(t.suspect)).toBe('suspect');
    expect(S.tierFor(t.malicious)).toBe('malicious');
    expect(S.tierFor(t.malicious + 500)).toBe('malicious');
  });
});

describe('false-positive safety', () => {
  const ordinary = [
    ['established user', user()],
    ['newish but complete profile', user({ ageDays: 60 })],
    ['nitro user, young account', user({ ageDays: 5, avatar: 'a_animated' })],
    ['badged user, young account', user({ ageDays: 4, badges: ['PremiumEarlySupporter'] })],
    ['name with a few digits', user({ name: 'gamer99' })],
  ];

  for (const [label, u] of ordinary) {
    test(`${label} stays clear`, () => {
      expect(score(u).tier).toBe('clear');
    });
  }
});
