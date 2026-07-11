# Proposal: `Pebble.addIndexNote()` — let watchapp companions add notes to the Index feed

A concrete, small API proposal for
[coredevices/mobileapp](https://github.com/coredevices/mobileapp), written
after building [Index Notes](../README.md) (a Pebble watchapp that submits
dictated voice notes into the Index feed) and finding that the only
externally reachable ingestion path today is writing directly to the
user's Firestore sync collection — which forces third-party companions to
handle the user's Firebase credentials.

## Problem

The Index feed has rich internal ingestion (`RecordingProcessingQueue`:
ring audio, phone microphone, typed text via `queueTextProcessing`,
Firestore sync via `ingestRemoteRecording`), but **no API surface for
watchapps**. Meanwhile the watch side already has everything needed to
capture a voice note: the Dictation API hands third-party watchapps
on-device-transcribed text through `VoiceSessionManager`
(app-initiated sessions are explicitly supported via the `appUuid`
session flag).

The result: a watchapp can *capture* a note but can't *file* it. The
workaround — authenticating against the user's own Firebase account from
PebbleKit JS and writing a `RecordingDocument` to
`recordings/{uid}/recordings` — works, but:

- users must extract client config and mint a refresh token (hostile UX);
- remotely-ingested docs skip agent processing, so no automatic
  reminders/lists/actions;
- it couples third parties to an internal document schema.

## Proposal

Add one method to the PebbleKit JS bridge, following the precedent of the
existing app-service hooks (`Pebble.insertTimelinePin` /
`deleteTimelinePin` already call straight into app internals from
companion JS):

```js
Pebble.addIndexNote(text, onSuccess, onFailure);
```

Semantics: enqueue `text` as a text note in the Index feed, exactly as if
typed into the Index compose bar — i.e. route to
`RecordingProcessingQueue.queueTextProcessing(transcription)`, which
creates the recording, runs the agent (reminder/list/action detection),
and syncs it across devices.

## Implementation sketch

The PKJS runtime lives in `libpebble3`, which must not depend on the
`experimental` module where the queue lives — so the bridge goes through a
small interface bound by the host app:

1. **`libpebble3`** — define the sink and thread it into the PKJS
   interfaces:

   ```kotlin
   fun interface IndexNoteSink {
       /** Returns true if the note was accepted. */
       suspend fun addNote(text: String, sourceAppUuid: Uuid, sourceAppName: String): Boolean
   }
   ```

   - `PrivatePKJSInterface`: `addIndexNoteAsync(text): String` (callId
     pattern, mirroring `getTimelineTokenAsync`).
   - `startup.js` (and the iOS `JSCPKJSInterface` table): expose
     `Pebble.addIndexNote(text, onSuccess, onFailure)` wired to
     success/failure events, like `getTimelineToken`.
   - Koin: optional binding; when absent, calls fail cleanly (so
     libpebble3 consumers without an Index feature are unaffected).

2. **`composeApp`** — bind the sink to the queue:

   ```kotlin
   single<IndexNoteSink> {
       IndexNoteSink { text, _, _ ->
           get<RecordingProcessingQueue>().queueTextProcessing(text)
           true
       }
   }
   ```

3. **Consent (recommended):** gate the first call per watchapp behind a
   user prompt ("Allow *Index Notes* to add notes to your Index feed?"),
   with the grant stored per app UUID — same trust model as notification
   or location access for companions. `sourceAppUuid`/`sourceAppName` are
   in the signature for exactly this.

## Why upstream benefits

- **Ring parity for every Pebble owner:** any watch with a mic becomes an
  Index capture device — press, speak, done — including for users who
  don't own an Index 01.
- **Agent processing works:** notes added via `queueTextProcessing` get
  reminders/lists/actions, unlike Firestore-injected documents.
- **No credentials, no schema coupling:** third parties never see Firebase
  config or the `RecordingDocument` shape, leaving Core free to evolve
  both.
- **Tiny surface:** one string-in, bool-out method behind an interface;
  offline behavior is inherited from the existing processing queue.

## Compatibility plan for existing apps

The [Index Notes companion](../watchapp/src/pkjs/index.js) in this repo
already feature-detects the API:

```js
if (typeof Pebble.addIndexNote === 'function') { /* use it */ }
else { /* fall back to Firestore sync-collection write */ }
```

so shipping this upstream silently upgrades existing users to the
official path.

---

*Contributions to coredevices/mobileapp require signing their CLA
(cla-assistant.io/coredevices/libpebble3) under a legally identifiable
name.*
