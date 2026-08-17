// src/utils/commandScope.js
/**
 * Which commands a given guild is offered.
 *
 * Registration here is already per guild: handleCommands deletes the global
 * copies and PUTs the payload to each guild the bot is in. That makes "this
 * command belongs to one server" a matter of leaving it out of everybody
 * else's payload, rather than a command every server can see and click that
 * answers with a refusal.
 *
 * A command opts in by exporting `guilds: ['id', ...]`. Everything without one
 * is offered everywhere, which is all of them but /sleepy.
 *
 * The persona reads this too, and that is the half that is easy to miss:
 * botCapabilities() hands the bot a command list and tells it outright that it
 * has no others, so a command scoped away from this guild must not appear in
 * the list it is given here, or it will offer something nobody can run.
 *
 * This is about visibility, not access control. A registration outlives the
 * deploy that made it, and Discord keeps offering whatever it was last given,
 * so a scoped command still checks the guild itself when it runs.
 */

/**
 * The allowlist a command declares about itself, normalised.
 *
 * @param {{guilds?: unknown}} cmd a loaded command module
 * @returns {string[]|null} guild ids, or null for "offered everywhere"
 */
function guildAllowlist(cmd) {
    if (!Array.isArray(cmd?.guilds)) return null;
    const ids = cmd.guilds.map(id => String(id ?? '').trim()).filter(Boolean);
    // An empty list reads as a mistake, not as "nowhere": a command nobody can
    // reach is never what someone meant to write, and failing open leaves it
    // visible where it can be noticed rather than silently gone.
    return ids.length ? ids : null;
}

/**
 * Keeps only the entries this guild is allowed to see.
 *
 * @template T
 * @param {Iterable<T>} items registration JSON entries, or bare command names
 * @param {Map<string, string[]>|null|undefined} scopes name -> allowed guild ids
 * @param {string|null|undefined} guildId the guild being served; anywhere else,
 *   a DM included, sees the unscoped commands only
 * @param {(item: T) => string} [nameOf] how to read a command name off an item
 * @returns {T[]}
 */
function scopeTo(items, scopes, guildId, nameOf = item => item?.name) {
    const list = [...(items ?? [])];
    if (!scopes || scopes.size === 0) return list;
    const id = guildId == null ? '' : String(guildId);
    return list.filter(item => {
        const only = scopes.get(nameOf(item));
        return !only || only.includes(id);
    });
}

/**
 * The command names offered in a guild, for the persona's capability line.
 *
 * @param {{commands?: Map<string, unknown>, commandScopes?: Map<string, string[]>}} client
 * @param {string|null|undefined} guildId
 * @returns {string[]}
 */
function commandNamesFor(client, guildId) {
    return scopeTo(client?.commands?.keys() ?? [], client?.commandScopes, guildId, name => name);
}

module.exports = { guildAllowlist, scopeTo, commandNamesFor };
