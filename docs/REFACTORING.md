# Refactoring log

Decisions and defects handled during the architectural refactoring. Behavior changes are listed here on purpose: everything else is meant to be behavior-preserving (see the characterization tests under `tests/`).

## Defects corrected

| ID | Defect | Fix | Phase | Visible change |
|---|---|---|---|---|
| D-1 | API errors were plain texts in mixed languages (`Sign in with Twitch first`, `Content-Type debe ser…`, `Orden desconocida`) and bypassed i18n | They use the engine's error shape (`errorKey` + `errorParams` + English `error`) with the new keys `err.sign_in_required`, `err.json_required`, `err.unknown_command`, `err.invalid_json`, `err.body_too_large`; the UI translates them | 3 | Texts and error bodies of the HTTP API |
| D-2 | Invalid JSON answered HTTP 500; a body over 64 KB reset the connection | 400 `err.invalid_json`; 413 `err.body_too_large` (the connection is closed afterwards). Unexpected errors answer a generic 500 and log the detail to the console instead of returning the internal message | 3 | Status codes |
| D-3 | Expired sessions that were never looked up again stayed in memory | Expired sessions are swept whenever a session is opened | 3 | None |
| D-4 | The server kept listeners on tenants that had been released | `tenants` emits `released`; the server detaches its listeners | 3 | None |
| D-7 | History tags and the Xuen row of the settings preview built `'Xuen · '`, `'P'` and `Xuen` in code instead of the catalog | `ops.tag.main` / `ops.tag.recovery` in both catalogs; the preview row uses `Core.XUEN.name` | 6 | None: the output is the same in English and Spanish (`P3 · Niuzao`, `Xuen · P3`) because it is a letter and a proper name |

## Pending (not corrected yet)

| ID | Defect | Planned |
|---|---|---|
| D-9 | `Engine.restore` accepts any `{v:1}` object without validating its shape | To decide |

## Duplications removed (phase 6)
- `ui/util.js` no longer re-implements the rejection-sampling index: the page uses `Core.secureIndex`.
- The Twitch login rule is `Core.LOGIN_RE`, used by the page (immediate warning) and by `game.js` (real validation).
- The disqualification reason limits (3 to 200 characters) are `Core.REASON`, used by the engine and by the modal; the `maxlength` attribute is set from it.
- One log sanitizer (`logging.js`) instead of two regular expressions.

## Dead code removed (phase 6, one commit each)
`fmtTime` and `wait` (`ui/util.js`, never referenced), and the CSS variables `--jade-dark` and `--navy` (declared, never read with `var()`). Earlier: `Engine.busy`, `handleCallback`/`BusyError`/`canChangeAccount`, the `historyFile` option of `Game`.

## Cleanup (phase 7)
- Magic numbers got names: `SEEN_CHAT_MAX`, `HISTORY_VIEW_MAX` (`core.js`), `LOW_TIME_MS`, `MAX_CHIPS`, `TOAST_MS`, `UI_TICK_MS` (`ui/util.js`). Values unchanged.
- `server.openSession` removed (no code or test used it).
- `StreamerStore.loadConfig` no longer migrates legacy data behind the scenes: `Game.setOwner` calls `migrateLegacy` explicitly.
- `Game` console errors use the `[game]` prefix and `forLog`.
- READMEs: structure, test count and (manual) the list of files that must travel with `index.html` brought up to date; `docs/ARCHITECTURE.md` added.

## SonarCloud findings on `master` (phase 8)
- **Server:** `handle()` split into a GET/POST route table (same responses, checked byte for byte); `.env` parsing and `PUBLIC_URL` trimming without backtracking regular expressions; `resolveLogins` requests the Helix pages in parallel.
- **Hardening:** command names are looked up with `Object.hasOwn`, so `/api/constructor`, `/api/__proto__`… answer `404 unknown_command` (before they reached `Object` and ended in a 500).
- **Page:** the three unawaited commands are awaited. Stylesheet: explicit transitions (including `color`/`border-color` on buttons, because the Xuen theme fades them), `overflow-wrap: anywhere` instead of the deprecated `word-break: break-word`, merged `#admin` rule, no `!important` on `.manual .tw`, a background colour under the Xuen tag gradient, and a `prefers-reduced-motion` block that turns the decorative animations off for users who ask the system for less motion.
- **Left as it is on purpose:** `.hide{display:none!important}`. Some stage blocks carry an inline `display:flex`, which only `!important` can override. Suggested SonarCloud resolution: *Won't fix*.

## Notes
- `server.js` no longer reads `.env` when imported; only the entry point does.
- `twitch.js` lost `handleCallback`, `BusyError` and `canChangeAccount` (unused: sign-in goes through `Tenants.login`).
