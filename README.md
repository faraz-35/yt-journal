# yt-journal

Logs YouTube videos to `~/.agents/skills/about-me/yt-journal/` so any agent
reading your profile later sees what you've been watching and thinking about.

Companion to the `about-me` skill: `about-me` is the curated picture; this is
the capture layer that feeds it over time. One entry per logged video, written
as markdown following the `my-answers` convention.

## Pieces

- **Daemon** (`src/server.mjs`) — localhost HTTP server on port 8776. Writes
  entries, fetches transcripts, summarizes via GLM. Always-on via launchd.
- **Extension** (`extension/`) — Firefox MV3. Hotkey **Ctrl+Shift+V** on a
  YouTube video opens a card with title/channel/url auto-filled; you write a
  takeaway (the point), optionally hit Generate for an auto summary, then Save.
- **Storage** (`~/.agents/skills/about-me/yt-journal/`) — `SKILL.md`,
  `INDEX.md`, one `NNN.md` per video.

## Setup

1. Copy `.env.example` to `.env`, fill in `ZAI_API_KEY` (only needed for the
   Generate button; Save works without it).
2. Load the daemon:
   ```
   mkdir -p logs
   launchctl load -w ~/Library/LaunchAgents/com.faraz.yt-journal.plist
   ```
   (First time: symlink the plist into `~/Library/LaunchAgents/`.)
3. Load the extension. Two options:
   - **Temporary** (vanishes on restart): `about:debugging` → This Firefox →
     Load Temporary Add-on → select `extension/manifest.json`.
   - **Persistent** (survives restart): see [Persistent install](#persistent-install) below.
4. Open a YouTube video, press **Ctrl+Shift+V**.

## Persistent install

Firefox Release won't keep an unsigned add-on across restarts, so the temporary
load above disappears each session. This path gets you a **self-distributed
signed** XPI that installs permanently and **auto-updates** from a public
GitHub repo. Journal entries live on disk (`~/.agents/skills/about-me/yt-journal/`),
so no update can ever lose them. (The repo must be public: Firefox fetches the
update manifest unauthenticated, and the XPI is the source zipped anyway.)

### One-time setup

1. Create AMO API credentials: <https://addons.mozilla.org/developers/> →
   **API Keys** → generate a key/secret pair.
2. Put them in `.env`:
   ```
   WEB_EXT_API_KEY=user:your_jwt_issuer
   WEB_EXT_API_SECRET=your_jwt_secret
   ```
3. Auth `gh` (done already if `gh auth status` shows your account).

### First release + install

```
npm run release
```

This signs via AMO (unlisted), pushes `updates.json` to the repo, and publishes
the signed XPI to a GitHub Release. Then install it once, manually:

`about:addons` → gear → **Install Add-on From File** → pick the `.xpi` from
`web-ext-artifacts/`. Confirm the permission prompt. It now sticks across
restarts, and its `update_url` points at the hosted manifest — so future
versions arrive automatically.

### Shipping an update

```
npm run release
```

Bumps the version automatically (patch by default) in `extension/manifest.json`
+ `package.json`, signs, publishes, and pushes. Installed copies upgrade within
~a day, or immediately via `about:addons` → gear → **Check for Updates**.

Override the bump: `npm run release -- minor` (0.1.x → 0.2.0), `-- major`
(→ 1.0.0), or `-- 1.2.0` for a specific version. A bump is always required (AMO
rejects duplicate versions) — the script handles it.

How it works: the manifest's `browser_specific_settings.gecko.update_url` points
at `updates.json` on the repo's `main` branch; `npm run release` appends the new
version (with its GitHub Release URL + sha256) to that file and uploads the XPI.
Firefox fetches the HTTPS manifest, sees the higher version, and upgrades in
place. The signed add-on is bound to this profile (self-distribution).

Other commands: `npm run lint`, `npm run build`, `npm run sign` (sign only,
no release).

## Endpoints

```
POST /log-video   { title, url, channel?, takeaway?, summary?, explanation? }  -> { ok, id }
POST /summarize   { url, title }  -> { summary, explanation, warning? }  (best-effort)
GET  /health                       -> { ok: true }
```

## Notes

- Generate is best-effort. YouTube transcript scraping breaks often; when it
  does, the summary fields stay empty and you type or skip. Save never depends
  on Generate.
- The takeaway is the only irreplaceable field — everything else is fetchable.
- The daemon has no runtime dependencies — Node natives only. (`web-ext` is a
  dev-only tool, used solely to sign/package the extension.)
