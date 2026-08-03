// tests/blackjack.test.js
//
// The payout table is the part of a casino game that can silently print money
// or silently eat it, and neither shows up as a crash. These pin every outcome
// to an exact figure.

const BJ = require('../src/utils/blackjack');

const card = rank => ({ rank, suit: '♠' });
const hand = (...ranks) => ranks.map(card);

/** A settled hand as bj.js would hand it over. */
function playerHand(cards, bet = 100, overrides = {}) {
  return { ...BJ.makeHand(cards, bet), ...overrides };
}

describe('handValue', () => {
  test('counts an ace as eleven while it fits', () => {
    expect(BJ.handValue(hand('A', '6'))).toEqual({ total: 17, soft: true });
  });

  test('demotes the ace rather than busting', () => {
    expect(BJ.handValue(hand('A', '6', '10'))).toEqual({ total: 17, soft: false });
  });

  test('two aces are 12, not 22', () => {
    expect(BJ.handValue(hand('A', 'A'))).toEqual({ total: 12, soft: true });
  });

  test('demotes only as many aces as it must', () => {
    expect(BJ.handValue(hand('A', 'A', '9'))).toEqual({ total: 21, soft: true });
    expect(BJ.handValue(hand('A', 'A', 'A', '8'))).toEqual({ total: 21, soft: true });
  });

  test('a hand with no ace is never soft', () => {
    expect(BJ.handValue(hand('K', '7')).soft).toBe(false);
  });

  test('busts are reported as they are, not clamped', () => {
    expect(BJ.handValue(hand('K', 'Q', '5')).total).toBe(25);
  });
});

describe('isNatural', () => {
  test('two cards totalling 21', () => {
    expect(BJ.isNatural(hand('A', 'K'))).toBe(true);
  });
  test('three cards totalling 21 is not a natural', () => {
    expect(BJ.isNatural(hand('7', '7', '7'))).toBe(false);
  });
});

describe('isPair', () => {
  test('same rank', () => {
    expect(BJ.isPair(hand('8', '8'))).toBe(true);
  });
  test('different ten-value ranks still split', () => {
    expect(BJ.isPair(hand('K', 'Q'))).toBe(true);
  });
  test('a ten and a nine do not', () => {
    expect(BJ.isPair(hand('10', '9'))).toBe(false);
  });
});

describe('dealer stands on soft 17', () => {
  test('draws below 17', () => {
    expect(BJ.dealerShouldHit(hand('10', '6'))).toBe(true);
  });
  test('stands on a soft 17', () => {
    expect(BJ.dealerShouldHit(hand('A', '6'))).toBe(false);
  });
  test('stands on a hard 17', () => {
    expect(BJ.dealerShouldHit(hand('10', '7'))).toBe(false);
  });
});

describe('settleHand payouts', () => {
  const BET = 100;

  test('natural pays 3:2, so 250 comes back on a 100 stake', () => {
    const result = BJ.settleHand(playerHand(hand('A', 'K'), BET), hand('10', '8'), false);
    expect(result).toEqual({ outcome: 'natural', returned: 250 });
  });

  test('a natural beats a dealer who reaches 21 with three cards', () => {
    const dealer = hand('7', '7', '7');
    expect(BJ.handValue(dealer).total).toBe(21);
    const result = BJ.settleHand(playerHand(hand('A', 'K'), BET), dealer, false);
    expect(result.outcome).toBe('natural');
    expect(result.returned).toBe(250);
  });

  test('natural against natural is a push, not a win', () => {
    const result = BJ.settleHand(playerHand(hand('A', 'K'), BET), hand('A', 'Q'), true);
    expect(result).toEqual({ outcome: 'push', returned: BET });
  });

  test('a drawn 21 loses to a dealer natural', () => {
    const player = playerHand(hand('7', '7', '7'), BET);
    const result = BJ.settleHand(player, hand('A', 'Q'), true);
    expect(result).toEqual({ outcome: 'dealer_natural', returned: 0 });
  });

  test('even money returns exactly twice the stake regardless of the hole card', () => {
    const withNatural = BJ.settleHand(
      playerHand(hand('A', 'K'), BET, { evenMoney: true }), hand('A', 'Q'), true);
    const without = BJ.settleHand(
      playerHand(hand('A', 'K'), BET, { evenMoney: true }), hand('A', '5'), false);
    expect(withNatural).toEqual({ outcome: 'even_money', returned: 200 });
    expect(without).toEqual({ outcome: 'even_money', returned: 200 });
  });

  test('a bust returns nothing even when the dealer also busts', () => {
    const result = BJ.settleHand(playerHand(hand('K', 'Q', '5'), BET), hand('10', '9', '8'), false);
    expect(result).toEqual({ outcome: 'bust', returned: 0 });
  });

  test('a dealer bust pays even money on any live hand', () => {
    const result = BJ.settleHand(playerHand(hand('5', '6'), BET), hand('10', '9', '8'), false);
    expect(result).toEqual({ outcome: 'win', returned: 200 });
  });

  test('equal totals push and return the stake', () => {
    const result = BJ.settleHand(playerHand(hand('10', '9'), BET), hand('10', '9'), false);
    expect(result).toEqual({ outcome: 'push', returned: BET });
  });

  test('surrender returns half, rounded up on odd stakes', () => {
    expect(BJ.settleHand(playerHand(hand('10', '6'), 100, { surrendered: true }), hand('A', '9'), false))
      .toEqual({ outcome: 'surrender', returned: 50 });
    expect(BJ.settleHand(playerHand(hand('10', '6'), 5, { surrendered: true }), hand('A', '9'), false))
      .toEqual({ outcome: 'surrender', returned: 3 });
  });

  test('a doubled hand pays on the doubled stake', () => {
    // bj.js doubles hand.bet at the moment it takes the second wager, so the
    // settlement sees one stake of 200 rather than two of 100.
    const result = BJ.settleHand(playerHand(hand('5', '6', '10'), 200, { doubled: true }), hand('10', '7'), false);
    expect(result).toEqual({ outcome: 'win', returned: 400 });
  });

  test('a 21 built after a split is not a natural', () => {
    const split = BJ.makeHand(hand('A', 'K'), BET, { fromSplit: true });
    expect(split.natural).toBe(false);
    const result = BJ.settleHand(split, hand('10', '8'), false);
    expect(result).toEqual({ outcome: 'win', returned: 200 });
  });
});

describe('legalActions', () => {
  const base = { handCount: 1, balance: 1000 };

  test('an opening hand can do everything', () => {
    const actions = BJ.legalActions(BJ.makeHand(hand('8', '8'), 100), base);
    expect(actions).toEqual(expect.arrayContaining(['hit', 'stand', 'double', 'split', 'surrender']));
  });

  test('no double or split once the player has hit', () => {
    const h = BJ.makeHand(hand('8', '8'), 100);
    h.cards.push(card('2'));
    const actions = BJ.legalActions(h, base);
    expect(actions).toEqual(['hit', 'stand']);
  });

  test('no surrender after a split', () => {
    const h = BJ.makeHand(hand('9', '9'), 100, { fromSplit: true });
    expect(BJ.legalActions(h, { ...base, handCount: 2 })).not.toContain('surrender');
  });

  test('no split without the money for the second stake', () => {
    const h = BJ.makeHand(hand('8', '8'), 100);
    expect(BJ.legalActions(h, { handCount: 1, balance: 50 })).not.toContain('split');
    expect(BJ.legalActions(h, { handCount: 1, balance: 50 })).not.toContain('double');
  });

  test('no split beyond the four-hand cap', () => {
    const h = BJ.makeHand(hand('8', '8'), 100);
    expect(BJ.legalActions(h, { ...base, handCount: BJ.MAX_HANDS })).not.toContain('split');
  });

  test('split aces are finished on arrival and cannot be doubled', () => {
    const h = BJ.makeHand(hand('A', '7'), 100, { fromSplit: true, splitAces: true });
    expect(h.done).toBe(true);
    expect(BJ.legalActions(h, base)).toEqual([]);
  });

  test('a hand on 21 has nothing left to decide', () => {
    expect(BJ.legalActions(BJ.makeHand(hand('K', 'A'), 100), base)).toEqual([]);
  });
});

describe('money safety over random play', () => {
  test('no settlement ever returns more than 2.5x the stake', () => {
    const BET = 100;
    for (let i = 0; i < 5000; i++) {
      const deck = BJ.createShuffledDeck();
      const player = BJ.makeHand([BJ.drawCard(deck), BJ.drawCard(deck)], BET);
      const dealer = [BJ.drawCard(deck), BJ.drawCard(deck)];
      const dealerNatural = BJ.isNatural(dealer);
      if (!dealerNatural) BJ.playDealer(dealer, deck);
      const { returned } = BJ.settleHand(player, dealer, dealerNatural);
      expect(returned).toBeGreaterThanOrEqual(0);
      expect(returned).toBeLessThanOrEqual(BET * BJ.NATURAL_RETURN_MULTIPLIER);
    }
  });

  test('a fresh deck is 52 distinct cards', () => {
    const deck = BJ.createShuffledDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(c => `${c.rank}${c.suit}`)).size).toBe(52);
  });
});
