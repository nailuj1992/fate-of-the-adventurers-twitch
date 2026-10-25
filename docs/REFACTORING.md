# Refactoring log

Decisions and defects handled during the architectural refactoring. Behavior changes are listed here on purpose: everything else is meant to be behavior-preserving (see the characterization tests under `tests/`).

## Defects corrected

| ID | Defect | Fix | Phase | Visible change |
|---|---|---|---|---|
| D-1 | API errors were plain texts in mixed languages (`Sign in with Twitch first`, `Content-Type debe ser…`, `Orden desconocida`) and bypassed i18n | They use the engine's error shape (`errorKey` + `errorParams` + English `error`) with the new keys `err.sign_in_required`, `err.json_required`, `err.unknown_command`, `err.invalid_json`, `err.body_too_large`; the UI translates them | 3 | Texts and error bodies of the HTTP API |
| D-2 | Invalid JSON answered HTTP 500; a body over 64 KB reset the connection | 400 `err.invalid_json`; 413 `err.body_too_large` (the connection is closed afterwards). Unexpected errors answer a generic 500 and log the detail to the console instead of returning the internal message | 3 | Status codes |
| D-3 | Expired sessions that were never looked up again stayed in memory | Expired sessions are swept whenever a session is opened | 3 | None |
| D-4 | The server kept listeners on tenants that had been released | `tenants` emits `released`; the server detaches its listeners | 3 | None |

## Pending (not corrected yet)

| ID | Defect | Planned |
|---|---|---|
| D-7 | UI strings not translated: `'Xuen · '`, `'P'` in the history tags, `Xuen` in the settings preview | UI phase |
| D-9 | `Engine.restore` accepts any `{v:1}` object without validating its shape | To decide |

## Notes
- `server.js` no longer reads `.env` when imported; only the entry point does.
- `twitch.js` lost `handleCallback`, `BusyError` and `canChangeAccount` (unused: sign-in goes through `Tenants.login`).
