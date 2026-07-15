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

function readWebchatHandlers() {
    return fs.readdirSync(path.join(ROOT, 'cli/server/handlers/webchat'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => read(path.join('cli/server/handlers/webchat', name)))
        .join('\n');
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
    const source = readWebchatHandlers();
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
