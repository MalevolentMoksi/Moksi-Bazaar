# The Dashboard

A web control room for the bot, living at a URL only you can open. It runs
inside the same Railway service as the bot itself, so it costs nothing extra
and needs no second deployment.

Until you finish the setup below, nothing changes: the bot boots, sees the
dashboard has no configuration, logs one line, and carries on exactly as
before.

## What it gives you

| Page | What it does |
| --- | --- |
| **Overview** | The morning glance: what is armed, recent moderation, bans lifting soon, live watch count. |
| **Join Gate** | Every gate setting on one page. Toggles save instantly; forms refuse bad input with an explanation. Same rules as the Discord panel, because both call the same validation module. |
| **Mod History** | The permanent record. Search and filter every ban, kick and timeout ever recorded, plus warns. Discord forgets after 45 days; this does not. |
| **Members** | Who talks, who lurks. Sortable, searchable. Click anyone for a dossier: profile, activity, history, and a live suspicion score with the full arithmetic. |
| **Guard** | Anti-nuke status, a live audit log feed, and the Snapshot Now button. |
| **Backtest** | Score all 1,600 members with the current settings, on a real screen, with cohort batches and paste-ready Dyno ban blocks. |

## The five-minute setup

You will do all of this yourself; none of it should ever pass through anyone
else, including an AI assistant. Three values end up as Railway variables.

### Step 1: give the bot service a web address

1. Open [railway.app](https://railway.app), your project, and click the **bot service** (the one that runs the bot; not the Postgres one).
2. Go to **Settings**, find **Networking** (sometimes called Public Networking).
3. Click **Generate Domain**. If it asks for a port, enter **3000**.
4. Railway shows something like `moksis-bazaar-production.up.railway.app`. Copy it; that is your dashboard address.

### Step 2: tell Discord where the login lives

1. Open [discord.com/developers/applications](https://discord.com/developers/applications) and click your bot's application.
2. In the left menu, open **OAuth2**.
3. Under **Redirects**, click **Add Redirect** and paste your address with `/oauth/callback` stuck on the end, with `https://` in front:

   ```
   https://YOUR-DOMAIN-FROM-STEP-1/oauth/callback
   ```

4. Click **Save Changes** at the bottom.

### Step 3: collect the two secrets

1. Still on that OAuth2 page, under **Client Secret**, click **Reset Secret** (unless you already have it noted somewhere safe). Copy the value it shows; Discord only shows it once.
2. Generate a signing secret for login cookies. Any long random string works. Easiest way, in a terminal:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Copy the output.

### Step 4: give Railway the variables

In the bot service on Railway, open the **Variables** tab and add:

| Variable | Value |
| --- | --- |
| `DISCORD_CLIENT_SECRET` | the client secret from step 3.1 |
| `SESSION_SECRET` | the random string from step 3.2 |
| `DASHBOARD_BASE_URL` | `https://YOUR-DOMAIN-FROM-STEP-1` (no trailing slash) |

Also check that `CLIENT_ID` already exists (it is the Application ID from the
dev portal's General Information page; the bot most likely has it already).

Railway redeploys on its own when variables change. When the deploy finishes,
open your domain in a browser, click **Log in with Discord**, and you are in.

## Why it is only you

- Logging in is Discord's own OAuth; the dashboard never sees a password.
- After Discord says who logged in, the ID is checked against the one owner ID
  hardcoded in the bot, the same check every owner command uses. There is no
  user table and no way to add a second person.
- That check runs on **every request**, not just at login. A stolen cookie
  signed for anyone but you is worthless.
- Sessions are signed with `SESSION_SECRET`; forging one means having the
  secret, which lives only in Railway.
- Anyone else who logs in gets a rejection joke and nothing more. Their
  attempt is logged with their ID.

## If something is off

- **The domain shows nothing / connection refused.** Look at the deploy logs
  for `[DASHBOARD] Disabled (missing env)`; it names the missing variable.
- **"Lighting the lanterns."** The bot is still connecting to Discord.
  Refresh in a few seconds.
- **Login loops or "expired" errors.** The redirect in the dev portal must
  match `DASHBOARD_BASE_URL` + `/oauth/callback` exactly, including https.
- **You think the client secret leaked.** Reset it in the dev portal, update
  the Railway variable. Old sessions survive (they are signed by
  `SESSION_SECRET`), but no new login can happen with the old secret.
- **You think the session secret leaked.** Change `SESSION_SECRET` in
  Railway; every existing session dies instantly, including yours, and you
  just log in again.

## What it will never do

Ban, kick or time anyone out. The one button that acts is Snapshot Now, and
what it does is read. Ban commands appear only as text for you to paste into
Dyno, so the bans land in your `?modstats`, not the bot's.
