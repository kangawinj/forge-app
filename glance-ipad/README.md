# Glance for iPad

A face-unlock **PWA** for iPad (and any modern browser with a front camera): private
notes locked behind your face, with a 6-digit passcode as backup. Inspired by
[Glance for Mac](https://github.com/jonnyoo/glance). Everything runs on-device — no
network calls, no accounts.

Open `/glance-ipad/` in Safari on the iPad (HTTPS or localhost is required for the
camera) → Share → **Add to Home Screen**.

## What it does

- **Onboarding**: create a passcode, then enroll your face (front, turn left, turn
  right, front again). Only 128-number embeddings are stored — never camera frames.
- **Lock screen**: scans automatically, matches against your enrolled embeddings, then
  asks for a random head-turn (liveness: off / light = 1 turn / heavy = 2 turns).
  Three failed scans fall back to the passcode.
- **Notes vault**: simple split-view notes app, auto-locks on leaving the app or after
  an idle timeout.
- **Settings**: strictness, liveness level, auto-lock, language (English/ไทย),
  re-enroll, add another look (glasses, lighting), change passcode, erase everything.

## How it works

| Piece | Implementation |
|---|---|
| Detection / landmarks / embedding | [`@vladmandic/face-api`](https://github.com/vladmandic/face-api) 1.7.15 (MIT), vendored in `vendor/` with the tiny detector, 68-point landmark and recognition models (~7 MB) so the app works offline |
| Match | Euclidean distance between 128-d embeddings; thresholds 0.45 / 0.50 / 0.55 |
| Liveness | Head-yaw estimated from landmarks; identity is re-verified when the turn completes |
| Storage | IndexedDB. Notes are AES-GCM encrypted with a random 256-bit vault key. That key is wrapped twice: by a PBKDF2 (310k iterations) key derived from the passcode, and by a non-extractable device key (used for face unlock). Face embeddings are sealed with the device key |
| Passcode throttling | 5 wrong attempts → 30 s lockout, doubling up to 1 h |
| Offline | `sw.js` caches the shell and models (bump `VERSION` when changing files) |

## Limits — please read

- A web app **cannot unlock iPadOS** or replace Face ID. This only gates the notes inside
  this app. iPads with Face ID/Touch ID should keep using those for the device itself.
- The iPad camera is 2D. Head-turn liveness stops printed photos and a static image on a
  screen, but **a video of you may still pass**. Treat face unlock as convenience, not
  security; the passcode is the real protection.
- The device key lives in the same browser origin as the data, so it protects against
  casual access, not against someone who can run script in this origin.

## Develop

Static files only — serve the repo root (`npx http-server .`) and open
`http://localhost:8080/glance-ipad/`. Firebase Hosting (`public: "."`) already serves it.
