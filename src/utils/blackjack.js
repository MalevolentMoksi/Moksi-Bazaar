// src/utils/blackjack.js
/**
 * Blackjack rules engine.
 *
 * Deliberately free of discord.js and of the database: everything here is a
 * pure function over cards and bets, so the payout arithmetic can be tested
 * without a gateway connection or a live balance. bj.js owns the buttons, the
 * embeds and the money; this owns what the rules say should happen.
 *
 * House rules implemented here:
 *  - Single deck, reshuffled every round.
 *  - Dealer stands on soft 17 (S17).
 *  - Dealer peeks for blackjack before the player acts, so a dealer natural
 *    can only ever take the original bet, never a doubled or split one.
 *  - A natural (two-card 21) beats a dealer who reaches 21 with three cards
 *    or more, and pushes only against another natural.
 *  - A 21 made after splitting is an ordinary 21, not a natural. This is the
 *    standard rule and it matters: otherwise splitting aces would print money.
 *  - Late surrender on the opening two cards of an unsplit hand, half back.
 *  - Split to at most four hands. Split aces get exactly one card each and
 *    cannot be resplit or doubled.
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** Natural pays 3:2, so the total returned is the stake plus 1.5 times it. */
const NATURAL_RETURN_MULTIPLIER = 2.5;
const MAX_HANDS = 4;
/** Dealer draws below this. 17 is S17; 18 would be nonsense, 16 would be H17-ish. */
const DEALER_STANDS_ON = 17;

function createShuffledDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) deck.push({ rank, suit });
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function drawCard(deck) {
    return deck.shift();
}

function cardValue(rank) {
    if (rank === 'A') return 11;
    if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
    return Number(rank);
}

/**
 * Best total for a hand, plus whether an ace is still counting as eleven.
 *
 * "Soft" is what tells a player a 17 they can safely hit apart from a 17 they
 * cannot, and it was never surfaced before.
 *
 * @returns {{total: number, soft: boolean}}
 */
function handValue(cards) {
    let total = 0;
    let aces = 0;
    for (const { rank } of cards) {
        if (rank === 'A') aces++;
        total += cardValue(rank);
    }
    let elevens = aces;
    while (total > 21 && elevens > 0) {
        total -= 10;
        elevens--;
    }
    return { total, soft: elevens > 0 };
}

/** A natural is exactly two cards totalling 21, dealt as such. */
function isNatural(cards) {
    return cards.length === 2 && handValue(cards).total === 21;
}

/** Ten-value or ace upcard means the dealer might be holding a natural. */
function upcardCanBeNatural(card) {
    return cardValue(card.rank) === 10 || card.rank === 'A';
}

function isPair(cards) {
    if (cards.length !== 2) return false;
    // By value, not by rank: a K and a Q are a splittable pair of tens
    // everywhere that matters, and refusing that would surprise players.
    return cardValue(cards[0].rank) === cardValue(cards[1].rank);
}

function dealerShouldHit(cards) {
    return handValue(cards).total < DEALER_STANDS_ON;
}

/** Plays the dealer's hand out to completion, mutating `cards`. */
function playDealer(cards, deck) {
    while (dealerShouldHit(cards)) cards.push(drawCard(deck));
    return cards;
}

/**
 * Creates a fresh player hand.
 * @param {object[]} cards
 * @param {number} bet
 */
function makeHand(cards, bet, options = {}) {
    const { fromSplit = false, splitAces = false } = options;
    return {
        cards,
        bet,
        // A hand that came out of a split can reach 21 but is never a natural.
        natural: !fromSplit && isNatural(cards),
        fromSplit,
        splitAces,
        doubled: false,
        surrendered: false,
        evenMoney: false,
        // Split aces receive one card each and are finished immediately.
        done: splitAces,
        outcome: null,
        returned: 0,
    };
}

/**
 * What the player is allowed to do with the hand in front of them.
 *
 * `handCount` and `balance` are passed in rather than inferred so this stays
 * a pure function; bj.js knows both.
 */
function legalActions(hand, { handCount = 1, balance = 0, dealerPeeked = true } = {}) {
    if (hand.done) return [];
    const value = handValue(hand.cards);
    if (value.total >= 21) return [];

    const opening = hand.cards.length === 2;
    const actions = ['hit', 'stand'];

    if (opening && !hand.splitAces && balance >= hand.bet) actions.push('double');
    if (opening && isPair(hand.cards) && handCount < MAX_HANDS
        && !hand.splitAces && balance >= hand.bet) {
        actions.push('split');
    }
    // Late surrender: only the opening two cards of a hand that was never
    // split, and only once the peek has cleared the dealer.
    if (opening && !hand.fromSplit && handCount === 1 && dealerPeeked) {
        actions.push('surrender');
    }

    return actions;
}

/**
 * Settles one hand against the dealer.
 *
 * @returns {{outcome: string, returned: number}} `returned` is gross: the
 *   whole amount that goes back to the player, stake included. A losing hand
 *   returns 0 because the stake was taken when it was wagered.
 */
function settleHand(hand, dealerCards, dealerNatural) {
    const bet = hand.bet;

    if (hand.surrendered) {
        // Rounded up: half of an odd stake is the house's rounding artifact,
        // not a decision the player made, and it costs at most one unit.
        return { outcome: 'surrender', returned: Math.ceil(bet / 2) };
    }
    if (hand.evenMoney) {
        return { outcome: 'even_money', returned: bet * 2 };
    }

    const player = handValue(hand.cards);
    if (player.total > 21) return { outcome: 'bust', returned: 0 };

    if (hand.natural && dealerNatural) return { outcome: 'push', returned: bet };
    // A natural beats a dealer 21 built from three cards or more.
    if (hand.natural) {
        return { outcome: 'natural', returned: Math.floor(bet * NATURAL_RETURN_MULTIPLIER) };
    }
    if (dealerNatural) return { outcome: 'dealer_natural', returned: 0 };

    const dealer = handValue(dealerCards);
    if (dealer.total > 21) return { outcome: 'win', returned: bet * 2 };
    if (player.total > dealer.total) return { outcome: 'win', returned: bet * 2 };
    if (player.total < dealer.total) return { outcome: 'lose', returned: 0 };
    return { outcome: 'push', returned: bet };
}

/** Human-readable line for one settled hand. */
const OUTCOME_TEXT = Object.freeze({
    natural: '🃏 Blackjack, pays 3:2',
    even_money: '🤝 Even money taken',
    win: '🎉 Win',
    push: '↔️ Push',
    lose: '💔 Loss',
    bust: '💥 Bust',
    surrender: '🏳️ Surrendered, half back',
    dealer_natural: '💔 Dealer blackjack',
});

function formatCards(cards) {
    return cards.map(c => `${c.rank}${c.suit}`).join(' ');
}

/** "17 (soft)" or "17", the way a player wants to read it. */
function formatValue(cards) {
    const { total, soft } = handValue(cards);
    return soft && total <= 21 ? `${total} (soft)` : String(total);
}

module.exports = {
    SUITS,
    RANKS,
    MAX_HANDS,
    DEALER_STANDS_ON,
    NATURAL_RETURN_MULTIPLIER,
    OUTCOME_TEXT,
    createShuffledDeck,
    drawCard,
    cardValue,
    handValue,
    isNatural,
    isPair,
    upcardCanBeNatural,
    dealerShouldHit,
    playDealer,
    makeHand,
    legalActions,
    settleHand,
    formatCards,
    formatValue,
};
