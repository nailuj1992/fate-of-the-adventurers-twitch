# Architecture

How the pieces of this repository fit together, and the rules that keep them that way. For the file-by-file table see `AGENTS.md`; for what changed during the refactoring and why, see `REFACTORING.md`.

## Layers and dependencies

```
 page (browser)                       server (Node)                     outside
 ───────────────                      ─────────────                     ───────
 public/index.html                    server.js (entry)
 public/adapter.js ── HTTP/SSE ─────► server/app.js ──► tenants.js ──► twitch.js ──► Twitch (OAuth, EventSub)
 ui/*.js, css/app.css                   │                 │               ├─ twitch/auth.js
        │                               │                 └─► game.js     └─ twitch/eventsub.js
        ▼                               ▼                       │
   core.js, i18n.js, locales/  ◄────────┴───────────────────────┘      store.js ──► data/ (disk)
   (shared, pure: no DOM, no network, no disk)
```

Rules (each one is checked by a test or by the structure itself):
- **`core.js` is pure.** No DOM, no Twitch, no disk, no `require` of anything except `i18n.js`. It runs unchanged in Node and in the browser and in the manual version.
- **The page never decides.** It renders the state it receives (`Engine.view()`) and sends commands. The deadline of the confirmation is the engine's.
- **One timer.** Every phase goes through `Engine.schedule`/`fire`. Tests drive it with a simulated clock.
- **Twitch is behind `twitch.js`.** `twitch/auth.js` knows tokens and Helix; `twitch/eventsub.js` knows the WebSocket; neither knows the engine. `game.js` is the only place that connects the two worlds.
- **Persistence goes through `store.js`**, keyed by the authenticated Twitch user ID. No other module touches `data/`.
- **Every route resolves its tenant from the session** (`tenantOf(req)` in `server/app.js`); no state is shared between streamers.

## Two repositories, one engine

`fate-of-the-adventurers-manual` is the same page without the server. These files must be **byte-identical** in both repositories:

| Shared | Different (by design) |
|---|---|
| `core.js`, `i18n.js`, `locales/*`, `css/app.css`, `ui/*.js`, and the page (`public/index.html` here, `index.html` there) | `adapter.js` (`public/adapter.js` here): the capabilities (`ADAPTER`), how commands reach the engine (`api`) and how the state starts (`boot`) |

`tests/shared.test.js` checks it; the CI `parity` job does it against the manual repository's `master`. The shared UI asks the adapter's **capabilities** (`ADAPTER.twitchNames`, `ADAPTER.helpSuffix`) and never "which version am I".

A change to a shared file is therefore always **two pull requests**: merge the manual one first, then the Twitch one (otherwise `parity` fails until the manual `master` has the change).

## Why classic scripts

The manual version must work by double-clicking `index.html` (`file://`), and browsers refuse ES modules there. So the page loads classic scripts in a fixed order (`locales`, `i18n`, `core`, `ui/util`, `ui/state`, `ui/admin`, `ui/stage`, `ui/fx`, `adapter`, `ui/main`) that share the global scope. The only rule this imposes: top-level code of a file may reference symbols from itself or from files loaded **before** it; anything else must be inside a function that runs later.

Adding a file the page loads means touching four places: the `<script>` tag in `index.html`, the closed static list in `server/pages.js`, the Assemble and Validate steps of the manual repository's Pages workflow, and the shared-file lists in `tests/shared.test.js`.

## Error and message conventions

- The engine and the server never return user text: they return `{ok:false, errorKey:'err.<code>', errorParams, error: <English>}`, or log entries as `key + params`. The page translates, so a language switch re-translates what is already on screen.
- Console messages carry a bracketed source (`[game]`, `[twitch]`, `[server]`) and go through `logging.forLog`.
