// src/utils/shopCatalogue.js
/**
 * The stock.
 *
 * These exist to take currency out of the economy. Every game puts money in
 * and, apart from losing it back to the house, nothing has ever taken money
 * out, which is why balances only ever go up and a thousand dollars stopped
 * meaning anything.
 *
 * So: nothing here affects a game. What you buy is a line in your collection
 * and, past a certain price, a title that shows on your casino profile. That
 * is the whole point. A sink that grants an advantage is not a sink, it is a
 * second economy.
 *
 * Prices are set against the actual income curve: daily pays a few thousand,
 * a good blackjack session a few tens of thousands. A Curio should be a
 * weekend, a Relic a month, a Singular something you tell people about.
 */

const TIERS = Object.freeze({
    trinket: { label: 'Trinket', price: 2_500, color: 0x9E9E9E },
    curio: { label: 'Curio', price: 10_000, color: 0x4CAF50 },
    relic: { label: 'Relic', price: 50_000, color: 0x2196F3 },
    marvel: { label: 'Marvel', price: 250_000, color: 0x9C27B0 },
    singular: { label: 'Singular', price: 1_000_000, color: 0xFFC107 },
});

/** Order matters: used for sorting and for picking the best title owned. */
const TIER_ORDER = ['trinket', 'curio', 'relic', 'marvel', 'singular'];

const ITEMS = Object.freeze([
    // ── Trinkets ────────────────────────────────────────────────────────────
    { id: 'bent_pick', name: 'Bent Plectrum', emoji: '🎸', tier: 'trinket',
        blurb: 'Warped from one too many all-nighters. Still technically works.' },
    { id: 'ticket_stub', name: 'Torn Ticket Stub', emoji: '🎫', tier: 'trinket',
        blurb: 'From a set nobody else remembers being at.' },
    { id: 'dead_battery', name: 'Dead AA Battery', emoji: '🔋', tier: 'trinket',
        blurb: 'Sold as-is. I did tell you.' },
    { id: 'lucky_coin', name: 'Allegedly Lucky Coin', emoji: '🪙', tier: 'trinket',
        blurb: 'Its previous owner sold it to me, which tells you most of what you need.' },

    // ── Curios ──────────────────────────────────────────────────────────────
    { id: 'cracked_cymbal', name: 'Cracked Cymbal', emoji: '🥁', tier: 'curio',
        blurb: 'The crack is the sound now. Nobody has the heart to replace it.' },
    { id: 'setlist', name: 'Water-Damaged Setlist', emoji: '📃', tier: 'curio',
        blurb: 'Three songs are legible. The fourth is a smudge and an argument.' },
    { id: 'stage_bulb', name: 'Burnt-Out Stage Bulb', emoji: '💡', tier: 'curio',
        blurb: 'Went out mid-chorus. Everyone agreed it improved the show.' },
    { id: 'dice_pair', name: 'Loaded Dice (Confiscated)', emoji: '🎲', tier: 'curio',
        blurb: 'Not usable at my tables. Handsome on a shelf.' },

    // ── Relics ──────────────────────────────────────────────────────────────
    { id: 'gold_pick', name: 'Gold-Plated Plectrum', emoji: '🏵️', tier: 'relic',
        title: 'Gilded', blurb: 'Plays no better. Catches the light beautifully.' },
    { id: 'first_chart', name: 'First Chart Ever Printed', emoji: '📈', tier: 'relic',
        title: 'Archivist', blurb: 'Every note in the wrong place. Historically priceless anyway.' },
    { id: 'house_ledger', name: 'The House Ledger', emoji: '📕', tier: 'relic',
        title: 'Bookkeeper', blurb: 'A record of everyone who thought they had a system.' },
    { id: 'velvet_rope', name: 'Length of Velvet Rope', emoji: '🪢', tier: 'relic',
        title: 'Doorman', blurb: 'Whichever side of it you are on is the side that matters.' },

    // ── Marvels ─────────────────────────────────────────────────────────────
    { id: 'sunken_amp', name: 'Amp Recovered from a Lake', emoji: '🔊', tier: 'marvel',
        title: 'Salvager', blurb: 'Nobody will say whose it was or how it got there.' },
    { id: 'perfect_run', name: 'A Bottled Perfect Run', emoji: '🫙', tier: 'marvel',
        title: 'Flawless', blurb: 'Do not open it. It only happens once and it already did.' },
    { id: 'dealers_hand', name: "The Dealer's Own Hand", emoji: '🖐️', tier: 'marvel',
        title: 'Card Counter', blurb: 'Framed, face down. I am not telling you what it was.' },

    // ── Singular ────────────────────────────────────────────────────────────
    { id: 'the_bazaar', name: 'A Share of the Bazaar', emoji: '🏛️', tier: 'singular',
        title: 'Proprietor', unique: true,
        blurb: 'Entitles the bearer to nothing whatsoever, in writing, notarised.' },
    { id: 'moksis_regard', name: "Moksi's Genuine Regard", emoji: '🕯️', tier: 'singular',
        title: 'Well Regarded', unique: true,
        blurb: 'Cannot be bought. You are, however, welcome to try, and you just did.' },
]);

const BY_ID = new Map(ITEMS.map(item => [item.id, item]));

function priceOf(item) {
    return TIERS[item.tier].price;
}

function getItem(id) {
    return BY_ID.get(id) ?? null;
}

function itemsByTier(tier) {
    return ITEMS.filter(item => item.tier === tier);
}

/**
 * The title a player has earned, which is the one attached to the most
 * expensive thing they own. Untitled if they own nothing that carries one.
 * @param {string[]} ownedIds
 */
function bestTitle(ownedIds) {
    let best = null;
    let bestRank = -1;
    for (const id of ownedIds) {
        const item = BY_ID.get(id);
        if (!item?.title) continue;
        const rank = TIER_ORDER.indexOf(item.tier);
        if (rank > bestRank) { bestRank = rank; best = item.title; }
    }
    return best;
}

module.exports = { TIERS, TIER_ORDER, ITEMS, getItem, itemsByTier, priceOf, bestTitle };
