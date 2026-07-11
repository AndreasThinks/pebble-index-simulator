# Index Notes — voice notes from your Pebble into the Index feed

A Pebble watchapp that lets you dictate a voice note on your watch and have
it appear in the **Index** feed of the official [Pebble mobile
app](https://play.google.com/store/apps/details?id=coredevices.coreapp) —
the same feed that recordings from the [Pebble Index 01
ring](https://repebble.com/index) land in.

Everything here is open source and built only against public APIs and the
open-source [coredevices/mobileapp](https://github.com/coredevices/mobileapp)
code (GPLv3).

## How it works

The Pebble SDK doesn't give third-party watchapps raw microphone audio —
only the **Dictation API**, which hands you transcribed text. The mobile
app's Index feed, meanwhile, syncs across devices through a per-user
Firestore collection (`recordings/{uid}/recordings`) that the app's
`RecordingProcessingQueue` live-ingests. This project connects the two:

```
Watch (C app)                Phone (PebbleKit JS companion)          Cloud
─────────────                ──────────────────────────────          ─────
SELECT pressed
  → Dictation API session ─→ on-device speech-to-text
  ← transcribed text
  → AppMessage {text} ─────→ queue in localStorage
                             → Firebase auth (your own account)
                             → create RecordingDocument ───────────→ Firestore
                                                                       │
                             Pebble app's sync listener  ←────────────┘
                             → note appears in the Index feed ✨
```

The `RecordingDocument` written is byte-for-byte the shape the app itself
writes for a transcribed note (an entry with status `completed`, instants
encoded as `{epochSeconds, nanosecondsOfSecond}` maps, `updated` in epoch
millis) — so to the app it looks like a recording synced from another of
your devices.

## Repository layout

| Path | What it is |
|------|------------|
| `watchapp/` | The Pebble app: C UI + dictation (`src/c/main.c`) and the PebbleKit JS companion (`src/pkjs/`) that authenticates and writes to Firestore |
| `simulator/` | Zero-dependency Node server emulating the secure-token, identity-toolkit, and Firestore endpoints, with RecordingDocument shape validation and a live feed view — develop the whole pipeline with no watch, no account |
| `test/` | End-to-end tests that run the real companion code against the simulator |
| `docs/` | The app's settings page (host on GitHub Pages or anywhere static) |

## Quick start (no hardware needed)

```bash
npm test              # end-to-end tests: watch message → auth → ingestion
npm run simulator     # local ingestion simulator on http://localhost:8688
```

The simulator accepts any refresh token of the form `sim-refresh-<name>`
and shows ingested notes at `http://localhost:8688/` (auto-refreshing) and
as JSON at `/recordings`.

## Building the watchapp

```bash
cd watchapp
uv tool install pebble-tool   # or pipx install pebble-tool
pebble sdk install latest
pebble build                  # → build/watchapp.pbw
```

Targets all microphone-equipped Pebble platforms: `basalt`, `chalk`,
`diorite`, `emery`. CI builds the `.pbw` on every push.

## Configuring against the real Pebble app

The companion needs three things, set from the watchapp's settings page in
the Pebble mobile app:

1. **Firebase Web API key and project ID** of the Pebble app's Firebase
   project. These are public *client identifiers* (not secrets); they ship
   inside every installed copy of the app (e.g. in the Android APK's
   Firebase config resources).
2. **Credentials for your own account** — either:
   - a **Firebase refresh token** for your account, or
   - **email & password**, if the project has that provider enabled (the
     companion swaps it for a refresh token on first sign-in and forgets
     the password).
3. **Backup/sync enabled** in the Pebble app — remote ingestion is gated on
   it (`preferences.backupEnabled`).

You write only to your own account's data, over the same public Firebase
REST APIs every Firebase client uses.

### The honest caveats

- **This is an unofficial integration.** The Firestore document shape is
  taken from the open-source app and could change; the app's security
  rules or provider configuration could also restrict how third-party
  clients sign in. The included simulator + tests make it cheap to adapt.
- **Notes are text, not audio.** Third-party apps get transcription, not
  raw audio, so notes appear in the feed as transcribed text (like a ring
  note whose audio wasn't kept). The Index agent's automatic actions
  (reminders, lists) run at capture time on ring/phone notes and won't run
  on remotely-ingested ones.
- **If you use end-to-end encryption** for Index data, notes written by
  this companion are stored *unencrypted* in your collection (the app
  ingests cleartext docs fine, but be aware of the difference).
- The right long-term fix is an official ingestion API. This repo includes
  a ready-to-submit design for one —
  [`docs/upstream-proposal.md`](docs/upstream-proposal.md) proposes a
  `Pebble.addIndexNote()` PKJS method for
  [coredevices/mobileapp](https://github.com/coredevices/mobileapp)
  (modelled on the existing `Pebble.insertTimelinePin` app-service hook),
  and this companion already **feature-detects that API and prefers it**:
  if the Pebble app ever ships it, existing installs silently upgrade to
  the credential-free path and Firebase settings become unnecessary.

### Alternative: fully self-hosted

Because the mobile app is open source, you can build it against **your own
Firebase project** (with whatever auth providers you like) and point this
companion at the same project — then nothing depends on Core Devices'
infrastructure at all.

## Settings page

`docs/index.html` is the Clay-style settings page. Host it anywhere static
(GitHub Pages serving `/docs` works out of the box) and set
`CONFIG_PAGE_URL` in `watchapp/src/pkjs/index.js` to its URL. It includes
an "advanced" section for pointing every endpoint at the local simulator.
