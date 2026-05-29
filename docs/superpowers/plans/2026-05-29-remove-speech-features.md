# Remove Speech Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove speech-to-text, text-to-speech, browser dictation, spoken replies, OpenAI speech endpoints, and read-aloud controls from Ploinky while preserving ordinary WebChat messaging, file uploads, WebMeet real-time audio/video, microphone mute/deafen controls, camera, and screen sharing.

**Architecture:** Treat speech features as UI and router affordances owned by Ploinky's first-party WebChat/WebMeet surfaces, not as agent runtime behavior. Delete speech-only strategy modules, remove route handlers and browser controls, simplify composer/message plumbing back to text-only, and update docs/specs so Ploinky no longer advertises or exposes speech providers. Keep WebRTC audio capture in WebMeet because it is meeting transport, not STT/TTS.

**Tech Stack:** Node.js ES modules, browser JavaScript, static HTML/CSS, `node:test`, shell smoke tests under `tests/test-functions/`.

---

## Discovery Notes

**Observed**

- `cli/server/handlers/webchat.js` imports server TTS strategy code, reads `WEBCHAT_TTS_PROVIDER` and `WEBCHAT_STT_PROVIDER`, serves `/webchat/tts`, `/webchat/stt`, and `/webchat/realtime-token`, and injects TTS/STT provider values into `chat.html`.
- `cli/server/webchat/` has dedicated speech entry modules and strategies: `speechToText.js`, `textToSpeech.js`, `strategies/stt/*`, and `strategies/tts/*`.
- `cli/server/webchat/messages.js` calls a server speech handler on assistant output, and `cli/server/webchat/composer.js` exposes voice-specific helpers used by STT modules.
- `cli/server/webmeet/` has separate browser dictation/read-aloud code: STT state in `webmeet-store.js`, STT controls in `webmeet.html`, SpeechRecognition code in `webmeet-media.js`, read-aloud buttons through `audio.js`, and TTS button attachment in `webmeet-client.js`.
- No dedicated unit or smoke tests currently assert STT/TTS behavior. Existing WebChat/WebMeet tests cover legacy auth removal and general surface behavior.
- `docs/specs/DS011-security-model.md`, `docs/webchat.html`, `docs/interfaces.html`, `docs/spec-webmeet.html`, and the WebMeet demo script still mention speech features.

**Inferred**

- Removing `/webchat/realtime-token` is part of speech removal because its only repository caller is the unused OpenAI realtime STT strategy.
- `OPENAI_API_KEY` must not be removed globally because unrelated agent/runtime tests and manifests still use it.
- WebMeet microphone mute/deafen and WebRTC audio/video must remain; only dictation/transcription and read-aloud synthesis are in scope.

**Unknown / Not Yet Verified**

- Whether any external consumers call `/webchat/stt`, `/webchat/tts`, or `/webchat/realtime-token` directly. This plan removes them as public Ploinky speech surfaces; downstream compatibility, if needed, should move to an agent-owned HTTP service declared in an agent manifest.

---

## File Structure

**Create**

- `tests/unit/speechFeatureRemoval.test.mjs` - regression tests that fail while Ploinky still exposes speech code, UI, routes, or docs.

**Modify**

- `cli/server/handlers/webchat.js` - remove WebChat speech provider constants, `/tts`, `/stt`, `/realtime-token` handlers, route registration, speech imports, and template replacements.
- `cli/server/webchat/chat.html` - remove speech data attributes, microphone SVG symbols, Voice settings rows, and the STT composer button.
- `cli/server/webchat/domSetup.js` - stop querying and returning speech DOM elements and speech provider dataset values.
- `cli/server/webchat/index.js` - remove STT/TTS imports, initialization, assistant-output speech callback wiring, and STT icon refocus handling.
- `cli/server/webchat/messages.js` - remove speech debounce state, speech scheduling, and `setServerSpeechHandler`.
- `cli/server/webchat/composer.js` - remove voice-only text append and purge callback API after STT modules are gone.
- `cli/server/webchat/webchat.css` - remove WebChat voice-control and mic icon styling.
- `cli/server/webmeet/webmeet.html` - remove dictation settings, STT composer button/status, `audio.js` script, and dictation placeholder copy.
- `cli/server/webmeet/webmeet-ui.js` - remove speech-language population, STT element queries, STT render logic, and speechSynthesis listener.
- `cli/server/webmeet/webmeet-store.js` - remove STT state and `vc_stt_*` localStorage reads.
- `cli/server/webmeet/webmeet-media.js` - remove SpeechRecognition state/functions/exports while keeping camera, screen, deafen, and remote media functions.
- `cli/server/webmeet/webmeet-client.js` - stop adding read-aloud buttons and remove dictation settings/button bindings.
- `cli/server/webmeet/webrtc-room.js` - remove STT cleanup from microphone shutdown; keep microphone stream shutdown.
- `cli/server/webmeet/webmeet.css` - remove `.wa-voice-control`, `.wa-voice-status`, and `.wa-tts-btn` rules.
- `cli/server/handlers/webmeet.js` - remove demo copy that advertises speech-to-text.
- `docs/specs/DS011-security-model.md` - remove the WebChat speech/OpenAI token exception and replace it with a no-speech-token-surface statement.
- `docs/webchat.html` - remove optional STT/TTS feature bullet.
- `docs/interfaces.html` - remove WebChat speech support from the current behavior row.
- `docs/spec-webmeet.html` - avoid advertising transcription as a built-in WebMeet/Ploinky capability.

**Delete**

- `cli/server/handlers/ttsStrategies/index.js`
- `cli/server/handlers/ttsStrategies/noop.js`
- `cli/server/handlers/ttsStrategies/openai.js`
- `cli/server/webchat/speechToText.js`
- `cli/server/webchat/textToSpeech.js`
- `cli/server/webchat/strategies/stt/browser.js`
- `cli/server/webchat/strategies/stt/index.js`
- `cli/server/webchat/strategies/stt/noop.js`
- `cli/server/webchat/strategies/stt/openai.js`
- `cli/server/webchat/strategies/stt/openai-realtime.js`
- `cli/server/webchat/strategies/tts/browser.js`
- `cli/server/webchat/strategies/tts/index.js`
- `cli/server/webchat/strategies/tts/noop.js`
- `cli/server/webchat/strategies/tts/openai.js`
- `cli/server/webchat/strategies/tts/voices.js`
- `cli/server/webmeet/audio.js`

---

### Task 1: Add Failing Speech-Removal Regression Test

**Files:**

- Create: `tests/unit/speechFeatureRemoval.test.mjs`

- [ ] **Step 1: Create the absence-focused regression test**

Create `tests/unit/speechFeatureRemoval.test.mjs` with this exact content:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function exists(relativePath) {
    return fs.existsSync(path.join(ROOT, relativePath));
}

function assertPatternsAbsent(source, patterns, label) {
    for (const pattern of patterns) {
        assert.doesNotMatch(source, pattern, `${label} should not contain ${pattern}`);
    }
}

test('WebChat no longer exposes speech routes or provider configuration', () => {
    const source = read('cli/server/handlers/webchat.js');
    assertPatternsAbsent(source, [
        /createServerTtsStrategy/,
        /DEFAULT_TTS_PROVIDER/,
        /DEFAULT_STT_PROVIDER/,
        /WEBCHAT_TTS_PROVIDER/,
        /WEBCHAT_STT_PROVIDER/,
        /WEBCHAT_TTS_MODEL/,
        /WEBCHAT_STT_MODEL/,
        /WEBCHAT_REALTIME_MODEL/,
        /handleTextToSpeech/,
        /handleSpeechToText/,
        /handleRealtimeToken/,
        /pathname === '\/tts'/,
        /pathname === '\/stt'/,
        /pathname === '\/realtime-token'/,
        /audio\/speech/,
        /audio\/transcriptions/,
        /client_secret/,
        /parseMultipartFormData/,
    ], 'WebChat handler');
});

test('WebChat template and entrypoint omit speech controls', () => {
    const template = read('cli/server/webchat/chat.html');
    assertPatternsAbsent(template, [
        /data-tts-provider/,
        /data-stt-provider/,
        /id="sttBtn"/,
        /id="sttEnable"/,
        /id="sttLang"/,
        /id="sttStatus"/,
        /id="ttsEnable"/,
        /id="ttsVoice"/,
        /id="ttsRate"/,
        /id="ttsRateValue"/,
        /Enable speech dictation/,
        /Enable spoken replies/,
        /Speech rate/,
        /Voice input/,
    ], 'WebChat template');

    const domSetup = read('cli/server/webchat/domSetup.js');
    assertPatternsAbsent(domSetup, [
        /sttBtn/,
        /sttStatus/,
        /sttLang/,
        /sttEnable/,
        /ttsEnable/,
        /ttsVoice/,
        /ttsRate/,
        /ttsRateValue/,
        /ttsProvider/,
        /sttProvider/,
    ], 'WebChat DOM setup');

    const entrypoint = read('cli/server/webchat/index.js');
    assertPatternsAbsent(entrypoint, [
        /initSpeechToText/,
        /initTextToSpeech/,
        /textToSpeech/,
        /sttBtn/,
        /sttStatus/,
        /sttLang/,
        /sttEnable/,
        /ttsEnable/,
        /ttsVoice/,
        /ttsRate/,
        /ttsRateValue/,
    ], 'WebChat entrypoint');

    const css = read('cli/server/webchat/webchat.css');
    assertPatternsAbsent(css, [
        /wa-voice-control/,
        /wa-mic-icon/,
        /#sttBtn/,
    ], 'WebChat CSS');
});

test('WebChat message and composer code has no speech plumbing', () => {
    const messages = read('cli/server/webchat/messages.js');
    assertPatternsAbsent(messages, [
        /onServerOutput/,
        /serverSpeechHandler/,
        /speechDebounceTimer/,
        /emitServerOutput/,
        /scheduleSpeech/,
        /setServerSpeechHandler/,
    ], 'WebChat messages');

    const composer = read('cli/server/webchat/composer.js');
    assertPatternsAbsent(composer, [
        /appendVoiceText/,
        /setPurgeHandler/,
        /resetVoice/,
    ], 'WebChat composer');
});

test('speech-only strategy modules are deleted', () => {
    const deletedPaths = [
        'cli/server/handlers/ttsStrategies/index.js',
        'cli/server/handlers/ttsStrategies/noop.js',
        'cli/server/handlers/ttsStrategies/openai.js',
        'cli/server/webchat/speechToText.js',
        'cli/server/webchat/textToSpeech.js',
        'cli/server/webchat/strategies/stt/browser.js',
        'cli/server/webchat/strategies/stt/index.js',
        'cli/server/webchat/strategies/stt/noop.js',
        'cli/server/webchat/strategies/stt/openai.js',
        'cli/server/webchat/strategies/stt/openai-realtime.js',
        'cli/server/webchat/strategies/tts/browser.js',
        'cli/server/webchat/strategies/tts/index.js',
        'cli/server/webchat/strategies/tts/noop.js',
        'cli/server/webchat/strategies/tts/openai.js',
        'cli/server/webchat/strategies/tts/voices.js',
        'cli/server/webmeet/audio.js',
    ];

    for (const relativePath of deletedPaths) {
        assert.equal(exists(relativePath), false, `${relativePath} should be deleted`);
    }
});

test('WebMeet no longer exposes dictation or read-aloud UI', () => {
    const template = read('cli/server/webmeet/webmeet.html');
    assertPatternsAbsent(template, [
        /id="sttBtn"/,
        /id="sttEnable"/,
        /id="sttLang"/,
        /id="sttStatus"/,
        /Voice Settings/,
        /Voice dictation/,
        /speech dictation/,
        /dictate/,
        /audio\.js/,
    ], 'WebMeet template');

    const files = [
        'cli/server/webmeet/webmeet-ui.js',
        'cli/server/webmeet/webmeet-store.js',
        'cli/server/webmeet/webmeet-media.js',
        'cli/server/webmeet/webmeet-client.js',
        'cli/server/webmeet/webrtc-room.js',
        'cli/server/webmeet/webmeet.css',
        'cli/server/handlers/webmeet.js',
    ];

    for (const relativePath of files) {
        const source = read(relativePath);
        assertPatternsAbsent(source, [
            /SpeechRecognition/,
            /webkitSpeechRecognition/,
            /SpeechSynthesisUtterance/,
            /speechSynthesis/,
            /webMeetAudio/,
            /createTTSButton/,
            /toggleDictation/,
            /stopRecognition/,
            /vc_stt_/,
            /\bstt[A-Z_]/,
            /\bstt:/,
            /speech-to-text/,
            /Read aloud/,
        ], relativePath);
    }
});

test('public docs no longer advertise Ploinky speech features', () => {
    const docs = [
        'docs/specs/DS011-security-model.md',
        'docs/webchat.html',
        'docs/interfaces.html',
        'docs/spec-webmeet.html',
    ];

    for (const relativePath of docs) {
        const source = read(relativePath);
        assertPatternsAbsent(source, [
            /speech-to-text/i,
            /text-to-speech/i,
            /spoken replies/i,
            /speech dictation/i,
            /transcribing the conversation/i,
            /WEBCHAT_STT/i,
            /WEBCHAT_TTS/i,
            /realtime-token/i,
            /audio\/transcriptions/i,
            /audio\/speech/i,
        ], relativePath);
    }
});
```

- [ ] **Step 2: Run the new test and confirm it fails before implementation**

Run:

```bash
node --test tests/unit/speechFeatureRemoval.test.mjs
```

Expected: FAIL. At least one assertion should report an existing speech symbol such as `handleTextToSpeech`, `id="sttBtn"`, or an existing speech strategy file.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/unit/speechFeatureRemoval.test.mjs
git commit -m "test: cover speech feature removal"
```

---

### Task 2: Remove WebChat Router Speech Endpoints

**Files:**

- Modify: `cli/server/handlers/webchat.js`
- Delete: `cli/server/handlers/ttsStrategies/index.js`
- Delete: `cli/server/handlers/ttsStrategies/noop.js`
- Delete: `cli/server/handlers/ttsStrategies/openai.js`

- [ ] **Step 1: Delete server-side TTS strategies**

Run:

```bash
git rm -r cli/server/handlers/ttsStrategies
```

Expected: Git stages deletion of the three server TTS strategy files.

- [ ] **Step 2: Remove speech imports and provider constants from `webchat.js`**

In `cli/server/handlers/webchat.js`, change the common import to remove multipart parsing:

```js
import { parseCookies, buildCookie, appendSetCookie } from './common.js';
```

Also delete this import:

```js
import { createServerTtsStrategy } from './ttsStrategies/index.js';
```

Delete these constants:

```js
const DEFAULT_TTS_PROVIDER = (process.env.WEBCHAT_TTS_PROVIDER || 'browser').trim().toLowerCase();
const DEFAULT_STT_PROVIDER = (process.env.WEBCHAT_STT_PROVIDER || 'browser').trim().toLowerCase();
```

- [ ] **Step 3: Delete speech handler functions from `webchat.js`**

Remove the complete function bodies for:

```js
async function handleTextToSpeech(req, res) { ... }
async function handleSpeechToText(req, res) { ... }
async function handleRealtimeToken(req, res) { ... }
```

The deletion starts at the current `handleTextToSpeech` definition and ends immediately before `async function handleSuggestionsFiles(...)`.

- [ ] **Step 4: Remove speech route branches from `handleWebChat`**

Delete these route branches:

```js
if (pathname === '/tts' && req.method === 'POST') {
    return handleTextToSpeech(req, res);
}

if (pathname === '/stt' && req.method === 'POST') {
    return handleSpeechToText(req, res);
}

if (pathname === '/realtime-token' && req.method === 'POST') {
    return handleRealtimeToken(req, res);
}
```

Do not add replacement branches. These paths should fall through to the existing final `404` response.

- [ ] **Step 5: Stop injecting speech provider template values**

In the `renderTemplate` replacement object for the WebChat HTML route, remove:

```js
'__TTS_PROVIDER__': DEFAULT_TTS_PROVIDER,
'__STT_PROVIDER__': DEFAULT_STT_PROVIDER,
```

- [ ] **Step 6: Verify backend speech endpoint removal**

Run:

```bash
node --check cli/server/handlers/webchat.js
node --test tests/unit/speechFeatureRemoval.test.mjs
```

Expected: `node --check` passes. The speech-removal test should still fail only on remaining WebChat frontend, WebMeet, or docs assertions; it should no longer fail on `handleTextToSpeech`, `handleSpeechToText`, `/tts`, `/stt`, `/realtime-token`, or deleted server TTS strategy files.

- [ ] **Step 7: Commit backend endpoint removal**

```bash
git add cli/server/handlers/webchat.js
git commit -m "remove WebChat speech endpoints"
```

---

### Task 3: Remove WebChat Frontend Speech UI and Plumbing

**Files:**

- Modify: `cli/server/webchat/chat.html`
- Modify: `cli/server/webchat/domSetup.js`
- Modify: `cli/server/webchat/index.js`
- Modify: `cli/server/webchat/messages.js`
- Modify: `cli/server/webchat/composer.js`
- Modify: `cli/server/webchat/webchat.css`
- Delete: `cli/server/webchat/speechToText.js`
- Delete: `cli/server/webchat/textToSpeech.js`
- Delete: `cli/server/webchat/strategies/stt/browser.js`
- Delete: `cli/server/webchat/strategies/stt/index.js`
- Delete: `cli/server/webchat/strategies/stt/noop.js`
- Delete: `cli/server/webchat/strategies/stt/openai.js`
- Delete: `cli/server/webchat/strategies/stt/openai-realtime.js`
- Delete: `cli/server/webchat/strategies/tts/browser.js`
- Delete: `cli/server/webchat/strategies/tts/index.js`
- Delete: `cli/server/webchat/strategies/tts/noop.js`
- Delete: `cli/server/webchat/strategies/tts/openai.js`
- Delete: `cli/server/webchat/strategies/tts/voices.js`

- [ ] **Step 1: Delete WebChat speech modules**

Run:

```bash
git rm cli/server/webchat/speechToText.js cli/server/webchat/textToSpeech.js
git rm -r cli/server/webchat/strategies/stt cli/server/webchat/strategies/tts
```

Expected: Git stages deletion of all WebChat speech modules and strategy files.

- [ ] **Step 2: Remove WebChat speech attributes, settings, and mic button from `chat.html`**

In `cli/server/webchat/chat.html`:

Delete the speech provider attributes from the `<body>` tag so it becomes:

```html
<body data-page="chat" data-theme="explorer" data-agent="__AGENT_NAME__" data-title="__DISPLAY_NAME__"
      data-runtime="__RUNTIME__" data-auth="__REQUIRES_AUTH__" data-base="__BASE_PATH__"
      data-agent-query="__AGENT_QUERY__">
```

Delete the entire hidden SVG block containing symbols `i-mic` and `i-mic-off`.

Delete the first settings section headed `Voice`, including the STT/TTS checkboxes, language select, voice select, speech-rate range, and the divider immediately after that section.

Keep the settings panel and the `Appearance` section.

Delete this composer block:

```html
<div class="wa-voice-control">
    <button class="wa-icon-btn" id="sttBtn" title="Voice input" aria-pressed="false">
        ...
    </button>
</div>
```

- [ ] **Step 3: Remove WebChat speech DOM wiring from `domSetup.js`**

In `cli/server/webchat/domSetup.js`, delete the `document.getElementById` assignments for:

```js
sttBtn
sttStatus
sttLang
sttEnable
ttsEnable
ttsVoice
ttsRate
ttsRateValue
```

Delete:

```js
const ttsProvider = (body.dataset.ttsProvider || '').trim().toLowerCase();
const sttProvider = (body.dataset.sttProvider || '').trim().toLowerCase();
```

Remove `ttsProvider` and `sttProvider` from the returned top-level object.

Remove the STT/TTS element fields from the returned `elements` object.

- [ ] **Step 4: Remove WebChat speech initialization from `index.js`**

In `cli/server/webchat/index.js`, delete these imports:

```js
import { initSpeechToText } from './speechToText.js';
import { initTextToSpeech } from './textToSpeech.js';
```

Remove `sttBtn`, `sttStatus`, `sttLang`, `sttEnable`, `ttsEnable`, `ttsVoice`, `ttsRate`, and `ttsRateValue` from the `elements` destructuring.

Delete the `textToSpeech` initialization:

```js
const textToSpeech = initTextToSpeech({
    ttsEnable,
    ttsVoice,
    ttsRate,
    ttsRateValue
}, { dlog, toEndpoint, provider: dom.ttsProvider });
```

Remove the `onServerOutput` option from `createMessages(...)`.

Delete:

```js
refocusComposerAfterIcon(sttBtn);
```

Delete the `initSpeechToText(...)` call near the end of the file.

- [ ] **Step 5: Simplify WebChat message rendering in `messages.js`**

In `cli/server/webchat/messages.js`, remove `onServerOutput` from the options destructuring in `createMessages`.

Delete these state variables and functions:

```js
let serverSpeechHandler = typeof onServerOutput === 'function' ? onServerOutput : null;
let speechDebounceTimer = null;
function emitServerOutput(text) { ... }
function scheduleSpeech(text) { ... }
```

Delete both calls to `scheduleSpeech(...)` inside `addServerMsg`.

Delete the returned `setServerSpeechHandler` method.

- [ ] **Step 6: Simplify WebChat composer in `composer.js`**

In `cli/server/webchat/composer.js`, delete:

```js
let onPurge = null;
```

Change `purge` to a no-argument function:

```js
function purge() {
    clear();
}
```

Delete the entire `appendVoiceText` function.

Where `appendVoiceText` currently calls `purge({ resetVoice: true })`, there will be no caller after deletion. No replacement is needed.

Remove `appendVoiceText` and `setPurgeHandler` from the returned object.

- [ ] **Step 7: Remove WebChat speech styles**

In `cli/server/webchat/webchat.css`, delete the style blocks for:

```css
.wa-voice-control
#sttBtn .wa-mic-icon
#sttBtn .wa-mic-icon.off
#sttBtn.muted .wa-mic-icon.on
#sttBtn.muted .wa-mic-icon.off
.wa-voice-control .wa-icon-btn
```

Also delete responsive/mobile rules that target `.wa-voice-control` or `.wa-voice-control .wa-icon-btn`.

- [ ] **Step 8: Verify WebChat frontend removal**

Run:

```bash
node --check cli/server/webchat/domSetup.js
node --check cli/server/webchat/index.js
node --check cli/server/webchat/messages.js
node --check cli/server/webchat/composer.js
node --test tests/unit/speechFeatureRemoval.test.mjs tests/unit/webchatEnvelope.test.mjs tests/unit/composer.test.mjs
```

Expected: All checked WebChat JavaScript files parse. `webchatEnvelope.test.mjs` and `composer.test.mjs` pass. `speechFeatureRemoval.test.mjs` should still fail only on remaining WebMeet or docs assertions.

- [ ] **Step 9: Commit WebChat frontend removal**

```bash
git add cli/server/webchat tests/unit/speechFeatureRemoval.test.mjs
git commit -m "remove WebChat speech controls"
```

---

### Task 4: Remove WebMeet Dictation and Read-Aloud

**Files:**

- Modify: `cli/server/webmeet/webmeet.html`
- Modify: `cli/server/webmeet/webmeet-ui.js`
- Modify: `cli/server/webmeet/webmeet-store.js`
- Modify: `cli/server/webmeet/webmeet-media.js`
- Modify: `cli/server/webmeet/webmeet-client.js`
- Modify: `cli/server/webmeet/webrtc-room.js`
- Modify: `cli/server/webmeet/webmeet.css`
- Modify: `cli/server/handlers/webmeet.js`
- Delete: `cli/server/webmeet/audio.js`

- [ ] **Step 1: Delete WebMeet read-aloud module**

Run:

```bash
git rm cli/server/webmeet/audio.js
```

Expected: Git stages deletion of `audio.js`.

- [ ] **Step 2: Remove WebMeet dictation controls from `webmeet.html`**

In `cli/server/webmeet/webmeet.html`, delete inline CSS rules for:

```css
.wa-tts-btn
.wa-tts-btn:hover
.wa-message.in .wa-tts-btn
.wa-message.in:hover .wa-tts-btn
```

Change the settings button title from:

```html
title="Voice settings"
```

to:

```html
title="Settings"
```

Delete these settings rows:

```html
<div class="wa-settings-header">Voice Settings</div>
<label class="wa-settings-row">
  <input type="checkbox" id="sttEnable" checked />
  <span>Enable speech dictation</span>
</label>
<label class="wa-settings-row">
  <span class="wa-settings-label">Recognition language</span>
  <select id="sttLang"></select>
</label>
```

Replace the remaining settings header with:

```html
<div class="wa-settings-header">Settings</div>
```

Delete the composer voice-control block containing `id="sttBtn"` and `id="sttStatus"`.

Change the composer placeholder from:

```html
placeholder="Type or dictate a message"
```

to:

```html
placeholder="Type a message"
```

Delete this script tag:

```html
<script src="__ASSET_BASE__/audio.js"></script>
```

- [ ] **Step 3: Remove WebMeet STT state from `webmeet-store.js`**

Delete the `initialLang` localStorage block.

Delete the entire `stt` object from the initial `state` object:

```js
stt: {
  supported: typeof (window.SpeechRecognition || window.webkitSpeechRecognition) === 'function',
  enabled: (() => { try { return localStorage.getItem('vc_stt_enabled') !== 'false'; } catch (_) { return true; } })(),
  active: false,
  listening: false,
  status: 'Off',
  lang: initialLang
}
```

- [ ] **Step 4: Remove WebMeet STT UI code from `webmeet-ui.js`**

Delete `commonLanguages`, `currentSttLang`, and `populateSpeechLanguages`.

Remove `sttBtn`, `sttStatus`, `sttEnable`, and `sttLang` from the `elements` object created in `init`.

Delete the call to `populateSpeechLanguages()` and the `speechSynthesis` `voiceschanged` listener.

In `renderButtons`, delete the blocks that update `elements.sttBtn`, `elements.sttEnable`, and `elements.sttLang`.

Delete `renderVoice(state)` and remove its call from `render(state)`.

- [ ] **Step 5: Remove WebMeet SpeechRecognition code from `webmeet-media.js`**

Delete these module-level variables:

```js
let sttRecognition = null;
let finalSegments = [];
let interimTranscript = '';
const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
```

Delete these helper functions:

```js
function voiceStatus(text) { ... }
function updateSttState(patch) { ... }
function stopRecognition() { ... }
function currentTranscript() { ... }
function handleDictationSend(sendFn) { ... }
function startRecognition(sendFn) { ... }
function toggleDictation(sendFn) { ... }
```

In `setDeafened`, remove the status update that references STT state. The function should only update `isDeafened` and call `muteAllRemoteAudio`:

```js
function setDeafened(deafened) {
  store.setState({ isDeafened: deafened });
  try { window.webMeetWebRTC?.muteAllRemoteAudio(deafened); } catch (_) {}
}
```

Remove `toggleDictation` and `stopRecognition` from `window.WebMeetMedia`.

- [ ] **Step 6: Remove WebMeet read-aloud and dictation bindings from `webmeet-client.js`**

In `createMessageBubble`, delete:

```js
if (!isSelf && window.webMeetAudio?.createTTSButton) {
  const ttsBtn = window.webMeetAudio.createTTSButton(cleanText);
  wrapper.appendChild(ttsBtn);
}
```

In `handleDisconnect`, delete:

```js
window.WebMeetMedia?.stopRecognition?.();
```

In `handleButtonBindings`, remove `sttBtn`, `sttEnable`, and `sttLang` from the destructuring and delete their event-listener blocks.

- [ ] **Step 7: Remove WebMeet STT cleanup from `webrtc-room.js`**

In `cli/server/webmeet/webrtc-room.js`, delete the STT cleanup block from `stopMic`:

```js
// Stop STT if it's running
try {
  window.WebMeetMedia?.stopRecognition?.();
} catch (_) {}
```

Keep the microphone stream shutdown code immediately below it.

- [ ] **Step 8: Remove WebMeet speech styles**

In `cli/server/webmeet/webmeet.css`, delete:

```css
.wa-voice-control { ... }
.wa-voice-control .wa-icon-btn { ... }
.wa-voice-status { ... }
.wa-tts-btn { ... }
.wa-tts-btn:hover { ... }
.wa-message.in .wa-tts-btn { ... }
.wa-message.in:hover .wa-tts-btn { ... }
```

Do not delete mute/deafen, microphone, camera, screen-share, participant, or WebRTC media styles.

- [ ] **Step 9: Remove demo speech copy from `webmeet.js`**

In `cli/server/handlers/webmeet.js`, change this demo line:

```js
{ who: 'Agent', text: 'Remember, you can use speech-to-text or type your message.', delayMs: 2000 },
```

to:

```js
{ who: 'Agent', text: 'Remember, you can type your message or request to speak.', delayMs: 2000 },
```

- [ ] **Step 10: Verify WebMeet removal**

Run:

```bash
node --check cli/server/webmeet/webmeet-ui.js
node --check cli/server/webmeet/webmeet-store.js
node --check cli/server/webmeet/webmeet-media.js
node --check cli/server/webmeet/webmeet-client.js
node --check cli/server/webmeet/webrtc-room.js
node --check cli/server/handlers/webmeet.js
node --test tests/unit/speechFeatureRemoval.test.mjs
```

Expected: JavaScript parse checks pass. `speechFeatureRemoval.test.mjs` should still fail only on docs assertions if docs have not yet been updated.

- [ ] **Step 11: Commit WebMeet speech removal**

```bash
git add cli/server/webmeet cli/server/handlers/webmeet.js tests/unit/speechFeatureRemoval.test.mjs
git commit -m "remove WebMeet dictation and read aloud"
```

---

### Task 5: Update Documentation and Security Spec

**Files:**

- Modify: `docs/specs/DS011-security-model.md`
- Modify: `docs/webchat.html`
- Modify: `docs/interfaces.html`
- Modify: `docs/spec-webmeet.html`

- [ ] **Step 1: Update DS011 browser media section**

In `docs/specs/DS011-security-model.md`, replace the WebChat speech paragraph under `### Browser Media and Third-Party API Keys` with:

```markdown
Ploinky WebChat does not expose first-party browser dictation, spoken-reply synthesis, or browser-facing realtime provider-token endpoints. Browser-facing routes must not return external provider API keys or direct browser media credentials from the router process. Any future browser media or provider-token surface must be owned by an explicit agent manifest/service contract and documented with the same route-auth, token-lifetime, logging, and deployment constraints as other protected browser media flows.
```

Keep the SSO `/auth/token` paragraph immediately below it.

- [ ] **Step 2: Remove WebChat speech feature bullet from docs**

In `docs/webchat.html`, delete this list item:

```html
<li>✅ Optional speech-to-text and text-to-speech integrations (see <code>cli/server/webchat/strategies</code>)</li>
```

- [ ] **Step 3: Update interfaces table**

In `docs/interfaces.html`, change the `/webchat` behavior cell from:

```html
TTY-backed chat surface that persists encrypted transcripts, supports uploads, can stream speech-to-text or text-to-speech through browser or server strategies, and forwards arbitrary URL query parameters to the selected agent CLI as long-form flags encoded as single <code>--key=value</code> tokens.
```

to:

```html
TTY-backed chat surface that persists encrypted transcripts, supports uploads, and forwards arbitrary URL query parameters to the selected agent CLI as long-form flags encoded as single <code>--key=value</code> tokens.
```

- [ ] **Step 4: Update WebMeet docs**

In `docs/spec-webmeet.html`, keep real-time audio/video meeting language intact.

Change:

```html
<p>The moderator agent can be a custom agent you create to manage meetings, for example, by automatically muting participants, managing the speaking queue, or even transcribing the conversation.</p>
```

to:

```html
<p>The moderator agent can be a custom agent you create to manage meetings, for example, by automatically muting participants or managing the speaking queue.</p>
```

- [ ] **Step 5: Run docs/search verification**

Run:

```bash
rg -n -i "speech-to-text|text-to-speech|spoken replies|speech dictation|transcribing the conversation|WEBCHAT_STT|WEBCHAT_TTS|WEBCHAT_REALTIME|realtime-token|audio/transcriptions|audio/speech" \
  cli/server docs tests/unit \
  --glob '!docs/superpowers/**' \
  --glob '!tests/unit/speechFeatureRemoval.test.mjs'
node --test tests/unit/speechFeatureRemoval.test.mjs
```

Expected: `rg` prints no matches. `speechFeatureRemoval.test.mjs` passes.

- [ ] **Step 6: Commit docs updates**

```bash
git add docs/specs/DS011-security-model.md docs/webchat.html docs/interfaces.html docs/spec-webmeet.html tests/unit/speechFeatureRemoval.test.mjs
git commit -m "document speech feature removal"
```

---

### Task 6: Final Verification and Cleanup

**Files:**

- No additional planned edits.

- [ ] **Step 1: Run targeted unit tests**

Run:

```bash
node --test \
  tests/unit/speechFeatureRemoval.test.mjs \
  tests/unit/webchatEnvelope.test.mjs \
  tests/unit/composer.test.mjs \
  tests/unit/webchatUploadPaths.test.mjs \
  tests/unit/webchatSuggestionsFiles.test.mjs \
  tests/unit/routeMounts.test.mjs
```

Expected: PASS for all listed unit tests.

- [ ] **Step 2: Run JavaScript parse checks for modified browser/server modules**

Run:

```bash
node --check cli/server/handlers/webchat.js
node --check cli/server/webchat/domSetup.js
node --check cli/server/webchat/index.js
node --check cli/server/webchat/messages.js
node --check cli/server/webchat/composer.js
node --check cli/server/webmeet/webmeet-ui.js
node --check cli/server/webmeet/webmeet-store.js
node --check cli/server/webmeet/webmeet-media.js
node --check cli/server/webmeet/webmeet-client.js
node --check cli/server/webmeet/webrtc-room.js
node --check cli/server/handlers/webmeet.js
```

Expected: all files parse successfully.

- [ ] **Step 3: Run full Ploinky regression if local services are available**

Run:

```bash
./tests/test_all.sh
```

Expected: PASS. If unavailable due to missing container runtime or environment setup, record the exact failure and keep the targeted tests from Steps 1-2 as the minimum verification evidence.

- [ ] **Step 4: Inspect remaining speech references**

Run:

```bash
rg -n -i "speech-to-text|text-to-speech|spoken replies|speech dictation|Voice input|Voice dictation|Read aloud|SpeechRecognition|webkitSpeechRecognition|SpeechSynthesisUtterance|speechSynthesis|WEBCHAT_STT|WEBCHAT_TTS|WEBCHAT_REALTIME|realtime-token|audio/transcriptions|audio/speech|whisper|gpt-4o-mini-tts" \
  cli docs tests \
  --glob '!docs/superpowers/**' \
  --glob '!tests/unit/speechFeatureRemoval.test.mjs'
```

Expected: no matches. If matches remain in unrelated historical artifacts, decide whether to delete/update them or add a narrow test exclusion with a comment explaining why they are not a Ploinky STT/TTS surface.

- [ ] **Step 5: Inspect git diff for accidental WebRTC removal**

Run:

```bash
git diff -- cli/server/webmeet/webrtc-room.js cli/server/webmeet/webmeet-media.js cli/server/webmeet/webmeet-client.js
```

Expected: the diff removes dictation/read-aloud code only. It must preserve microphone start/stop, mute/deafen, camera, screen share, remote stream handling, and participant signaling.

- [ ] **Step 6: Final commit if previous tasks were squashed during execution**

Only if tasks were not committed separately, commit all changes now:

```bash
git add cli/server/handlers/webchat.js cli/server/webchat cli/server/webmeet cli/server/handlers/webmeet.js docs/specs/DS011-security-model.md docs/webchat.html docs/interfaces.html docs/spec-webmeet.html tests/unit/speechFeatureRemoval.test.mjs
git commit -m "remove speech features from Ploinky"
```

---

## Self-Review

**Spec coverage:** The plan removes WebChat server STT/TTS routes, browser STT/TTS controls, WebMeet dictation/read-aloud controls, speech-only modules, docs/spec references, and adds regression coverage for absence.

**Placeholder scan:** No task depends on unspecified future work. Each file action, deletion, and verification command is explicit.

**Type/signature consistency:** After removal, `createMessages` no longer accepts `onServerOutput`, the WebChat composer no longer exposes `appendVoiceText`/`setPurgeHandler`, and `window.WebMeetMedia` no longer exports `toggleDictation`/`stopRecognition`. The tests assert those names are absent.

**Boundary check:** Real-time WebMeet audio/video is intentionally preserved. Global `OPENAI_API_KEY` usage outside WebChat speech is intentionally preserved.
