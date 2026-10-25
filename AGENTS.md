# AGENTS.md — The Fate of the Adventurers: The Trial of the Celestials (Twitch version)

Guidance for AI coding agents working in this repository.

## Git workflow — mandatory

- **NEVER push directly to `master`.** Not even a one-line fix, a copy tweak or a revert.
- **Every change goes on its own branch cut from `master`** (`git checkout master && git pull && git checkout -b <type>/<short-description>`), with `<type>` one of `feature/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`. Push that branch and integrate it into `master` through a pull request.
- Never force-push a shared branch, never rewrite pushed history, never bypass hooks (`--no-verify`).
- Commit only what you were asked to commit: run `git status` first. **Never commit `.env`, `data/` (tokens, history, settings) or anything containing a secret.** Commit messages are written in English, Conventional Commits style (`feat:`, `fix:`, `docs:`, `test:`, `chore:`…): a short imperative subject, then a body explaining the *why* for non-trivial changes.
- No tags or releases unless the maintainer asks.
- **This repository is public and `master` is protected** (pull request required, no force-push, no deletion, applies to admins too). Everything committed is publicly readable forever: never commit secrets, tokens, personal data or real participant lists.
- This repository has a **sibling**: `fate-of-the-adventurers-manual` (same engine, no Twitch). A change to a *shared file* (see below) needs the matching branch and pull request there.

## Project

Local web app to run a live, fair draw of in-game-time codes (prizes) for a Twitch stream, themed on the four Celestials of Pandaria (Niuzao, Yu'lon, Chi-ji and Xuen). A Node.js server reads the Twitch chat through the official **EventSub WebSocket** and confirms a chosen participant's presence automatically when they write in chat.

- **Maintainer:** Nailuj1992
- **Languages:** the UI is **English by default** with Spanish as the second language (i18n). Code comments are in Spanish; commit messages, docs for agents and the English README are in English.
- **Status:** manually tested by the maintainer against a real channel. Automated tests use a simulated Twitch.

### Stack

- **Node.js ≥ 22**, **zero npm dependencies** (native `fetch`, `WebSocket`, `node:test`). Do not add a dependency or a build step without asking.
- Frontend: a single static `public/index.html` (vanilla HTML/CSS/JS, no framework), served by the server.
- Twitch: OAuth authorization-code flow (confidential client) + EventSub WebSocket, scope **`user:read:chat`** only.

## Live deployment

- The hosted app is at **https://fate-of-the-adventurers-twitch-production.up.railway.app/** (Railway, remote mode; deploy steps in the README).
- **The live link must stay visible in three places** and be kept in sync if the URL ever changes: the repository **description** and **website** field (GitHub *About*), the top of both READMEs, and this file. When editing any of them, check the other two.

## Layout

| File | Purpose |
|---|---|
| `core.js` | **Shared** pure engine (no DOM, no network): default settings and limits, config validation, Celestial rotation, eligibility, the event state machine with its single phase scheduler, history entries. Works in Node and in the browser (UMD). |
| `i18n.js` + `locales/en.js`, `locales/es.js` | **Shared** i18n module and catalogs (flat keys, `{params}`, plural suffixes `_one`/`_other`, `{ $t: 'key' }` fragments). |
| `game.js` | Twitch wrapper around the engine: verifies the participant list against Twitch, resolves user IDs, persists settings and history per streamer (owner = Twitch user ID, set from the `identity` event). |
| `railway.json` | Railway deploy settings (start command, `/healthz` check). |
| `store.js` | `StreamerStore`: per-streamer data under `data/streamers/<twitch-id>/` (`config.json`, `historial.jsonl`); validates the ID (digits only); migrates legacy single-file data to the first account that signs in. |
| `server.js` | Local HTTP server (`127.0.0.1` only): static files, OAuth routes, SSE state stream, command routes (`/api/*`), server-side error pages (translated by cookie). |
| `twitch.js` | OAuth + EventSub client: token refresh/validation, subscription, reconnect/migration, dedupe, backoff. |
| `public/index.html` | The whole UI. Only renders the state it receives and sends commands. Contains an **adapter** section (`MODE = 'twitch'`) that differs from the manual repo. |
| `public/img/` | Celestial images (`niuzao.png`, `yulon.webp`, `chiji.png`, `xuen.webp`). Third-party artwork (not owned by the maintainer): do not add more of it or redistribute it elsewhere; the maintainer decides if it must be replaced. |
| `tests/` | `core.test.js` (engine with a simulated clock), `game.test.js` (wrapper, real timers), `twitch.test.js` (OAuth/EventSub with fake WebSocket/fetch), `i18n.test.js` (parity and key coverage). |
| `iniciar.bat` | Windows launcher (creates `.env` from `.env.example`, starts the server, opens the browser). |
| `.env.example` | Environment template. The real `.env` is git-ignored. |
| `data/` | Generated at runtime: `tokens.json` and `streamers/<twitch-id>/{config.json,historial.jsonl}`. **Git-ignored. Never commit.** |

## Domain rules (invariants — do not break them without tests and the maintainer's OK)

- **Randomness:** only `crypto.getRandomValues` with rejection sampling (`secureIndex` in `core.js`). Never `Math.random` for choosing winners. The draw happens when the countdown ends, never in advance.
- **Rounds and prizes:** `prizes` (1–50) main rounds; the Celestial is `CELESTIALS[round % 3]` (Niuzao → Yu'lon → Chi-ji). An **absence does not change the Celestial**; rotation only advances on a confirmed winner or a deserted round.
- **Eligibility** is always *computed* from records (`eligible(round)`), never from a mutable pool: not a winner, not globally disqualified, not absent **in that same round**. An absent person may be drawn again in later rounds (even if the Celestial repeats) and in Xuen.
- **Winners** are excluded forever; one prize per person. **Global disqualification** requires explicit confirmation + a written reason (≥ 3 chars) and excludes from every remaining round, Xuen included.
- **Deserted round** (no eligible left): its prize goes to recovery; the event continues. **Xuen** (round index = `prizes`) only appears if prizes remain unassigned, handles every pending prize in order, and a person absent in Xuen is excluded from *all* of Xuen.
- **Timers:** every phase goes through one scheduler (`schedule`/`fire`); never add a second timer. The confirmation clock starts when the **reveal ends** (chat is listened to from the start of the reveal); animations never consume it. The server owns the deadline; the page only draws it and never decides win/lose.
- **Resolution:** `settle()` is the single resolution point — first valid result wins; an expired deadline is processed once; after `deadline + lateSec` messages are rejected.
- **Connection drops:** never declare someone absent without a reliable connection (`verifying` state, then `graceSec` extra time).
- **Identity:** compare Twitch `chatter_user_id` with the resolved ID, never the typed name. Dedupe by message ID.
- **Prize codes are never shown or stored.** The server must not leak the chosen name before the reveal (`view().candidate`).
- **Settings** are locked once the event starts; the server must reject changes (`config_locked`).

## Conventions

- **i18n.** Every user-facing string goes through `I18n.t(...)` (UI) or through a **key + params** (engine/server). Never hard-code UI text. **English is the default**, independent of the browser language. Every key must exist in **both** `en.js` and `es.js` with the same `{params}` (the tests enforce this and that every used key exists). Spanish text uses correct orthography (accents, `ñ`). User-entered data (names, reasons) is never translated.
- **Engine messages are keys:** `this.log(kind, key, params)` stores `key` + `params` (+ English `text` for the history file); errors are `err('code', params)` → `errorKey: 'err.code'`. The UI translates them, so a language switch re-translates old history.
- **Settings** live in one place: `DEFAULT_CONFIG` / `LIMITS` in `core.js`. No hard-coded durations elsewhere.
- **Shared files** (`core.js`, `i18n.js`, `locales/*`) must stay **byte-identical** with the sibling repo. A test checks it when both repos are cloned side by side (`../fate-of-the-adventurers-manual`).
- **UI parity.** `public/index.html` here and `index.html` in the manual repo are the same UI with a different adapter block (`/* ---- Adaptador … ---- */`: `MODE`, `api()`, `boot()`). There is no generator in the repo: apply any UI change to **both** files.
- Style: 2-space indentation, `'use strict'`, match the surrounding code. `iniciar.bat` keeps CRLF line endings. Keep comments in Spanish.
- Celestial names: **Niuzao, Yu'lon, Chi-ji (lowercase *j*, as on Wowhead), Xuen**; long names live in `celestial.*.long`.

## Common tasks

- **Add a setting:** add it to `DEFAULT_CONFIG` + `LIMITS` (`core.js`), `toMs` if it is a duration, labels/help in both catalogs (`cfg.label.<k>`, `cfg.help.<k>`), the field list in `public/index.html` (`CFG_MAIN`/`CFG_ADV`), README tables (EN and ES) and tests. Sync `core.js`/locales to the sibling repo.
- **Change or add a message:** edit the key in **both** catalogs; if it is a new engine log, add the `this.log(..., 'new_key', params)` call and the `log.new_key` entry.
- **Add a language:** copy `locales/en.js`, translate, register it in `i18n.js` (`SUPPORTED`, loaders), in `server.js` (`SHARED` list) and as a `<script>` in `public/index.html`; extend the switcher; tests then enforce parity.
- **Change phase behaviour/timing semantics:** edit `core.js` only, update `core.test.js` (simulated clock) first, then `game.test.js`.
- **Touch Twitch integration** (`twitch.js`): follow the official EventSub docs (welcome → subscribe within 10 s, `session_reconnect` migration, keepalive watchdog, `message_id` dedupe). Keep `user:read:chat` as the only scope.
- **Update docs:** keep `README.md` (English) and `README.es.md` (Spanish) in sync, and this file when a convention changes.

## Testing

- Run `node --test` (≈ 25 s). All tests must pass before opening a pull request.
- Add tests for every behaviour change: engine rules → `core.test.js`; Twitch wrapper → `game.test.js`; OAuth/EventSub → `twitch.test.js`; texts → catalogs (the i18n tests catch missing keys).
- **There is no real Twitch in CI or in the agent environment.** Say so plainly; do not claim a change "works with Twitch" — the maintainer verifies it live.

## Restrictions

- **Streamer isolation**: settings and history must always be read/written through `StreamerStore` keyed by the authenticated Twitch user ID, never through a shared file. Twitch refuses a login from a different account while an event is running (`canChangeAccount`).
- **Remote mode** (`PUBLIC_URL` set, e.g. Railway): every panel route except `/healthz`, the login page and OAuth requires a session; only `ALLOWED_LOGINS` accounts can sign in (checked in `twitch.js` before any token is stored); Host/Origin must equal `PUBLIC_URL`; the server must refuse to start without an https `PUBLIC_URL` and a non-empty allow-list. Never weaken these. Local mode (no `PUBLIC_URL`) must keep listening on `127.0.0.1` only. `DATA_DIR` moves the data folder (the Railway volume). Deploy steps are in the README.
- **Never commit or print secrets**: `.env`, `TWITCH_CLIENT_SECRET`, `data/tokens.json`, access/refresh tokens. If one leaks, tell the maintainer immediately so it can be rotated.
- **Never push to `master` directly**; never push tags; never force-push.
- Never request additional Twitch scopes or store tokens in the browser. Tokens and the client secret stay server-side.
- Never widen the server beyond `127.0.0.1` or relax the `Host`/`Origin` checks.
- Don't add dependencies, a bundler or a framework.
- Don't remove the English default or let the browser language pick the UI language.
- Don't change the Celestial artwork or names without being asked.
