import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNetwork } from '../../cli/server/webchat/network.js';
import { createComposer } from '../../cli/server/webchat/composer.js';
import { __testables as messageTestables } from '../../cli/server/webchat/messages.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('initial markup cannot accept input while client modules are loading or unavailable', () => {
    const html = readFileSync(new URL('../../cli/server/webchat/chat.html', import.meta.url), 'utf8');
    for (const id of ['cmd', 'send', 'attachmentBtn']) {
        const control = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0];
        assert.ok(control, `missing input control ${id}`);
        assert.match(control, /\bdisabled\b/);
    }
});

function element() {
    const listeners = new Map();
    return {
        value: '', style: {}, disabled: false, selectionStart: 0, selectionEnd: 0,
        attributes: new Map(),
        closest() { return null; },
        focus() {},
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        toggleAttribute(name, enabled) {
            if (enabled) this.attributes.set(name, '');
            else this.attributes.delete(name);
        },
        setAttribute(name, value) { this.attributes.set(name, value); },
        addEventListener(name, handler) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(handler);
        },
        dispatchEvent(event) {
            for (const handler of listeners.get(event.type) || []) handler(event);
        },
    };
}

function fixture(t, { inputResponse, uploadResponse, proofResponse } = {}) {
    const originals = new Map(['EventSource', 'fetch', 'location', 'window', 'document']
        .map((key) => [key, globalThis[key]]));
    const sources = [];
    const inputs = [];
    const uploads = [];
    const bubbles = [];
    const attachmentBubbles = [];
    const errors = [];
    const banners = [];
    const readiness = [];
    const timeline = [];
    const cmdInput = element();
    const sendBtn = element();
    const cancelBtn = element();
    const proof = () => Response.json({
        browserMutation: {
            origin: 'https://chat.example', routeKey: 'generic-agent', csrfToken: 'test-proof',
        },
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(Math, 'random', () => 0);
    globalThis.document = { activeElement: null, documentElement: { style: { setProperty() {} } } };
    globalThis.window = {
        location: { origin: 'https://chat.example' },
        addEventListener() {}, requestAnimationFrame: (fn) => fn(),
    };
    globalThis.location = { href: 'https://chat.example/webchat', origin: 'https://chat.example' };
    globalThis.EventSource = class {
        constructor() { this.listeners = new Map(); sources.push(this); }
        addEventListener(name, handler) { this.listeners.set(name, handler); }
        emit(name, payload) { this.listeners.get(name)?.({ data: JSON.stringify(payload) }); }
        close() { this.closed = true; }
    };
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).includes('/auth/token')) return proofResponse ? proofResponse(proof) : proof();
        if (String(url).includes('/uploads')) {
            uploads.push({ url, options });
            return uploadResponse ? uploadResponse(uploads.at(-1)) : Response.json({
                id: 'file-1', filename: 'note.txt', localPath: 'note.txt', downloadUrl: '/note.txt',
            });
        }
        inputs.push({ url, options });
        return inputResponse ? inputResponse(inputs.at(-1)) : new Response(null, { status: 204 });
    };
    const composer = createComposer({ cmdInput, sendBtn, cancelBtn }, { purgeTriggerRe: /__never__/ });
    const network = createNetwork({
        TAB_ID: 'tab', PAGE_INSTANCE_ID: 'page', agentName: 'generic-agent',
        toEndpoint: (route) => `/webchat/${route}`, dlog() {},
        showBanner: (...args) => banners.push(args), hideBanner() {},
    }, {
        addClientMsg: (text, options) => {
            const bubble = { text, options, pending: options.pending };
            bubbles.push(bubble);
            timeline.push(bubble);
            return {
                markSent: () => { bubble.pending = false; },
                remove: () => { bubbles.splice(bubbles.indexOf(bubble), 1); timeline.splice(timeline.indexOf(bubble), 1); },
            };
        },
        addClientAttachment: (details) => {
            const bubble = { details, pending: details.pending };
            attachmentBubbles.push(bubble);
            timeline.push(bubble);
            return {
                markUploaded: (record) => { bubble.upload = record; },
                markSent: () => { bubble.pending = false; },
                remove: () => { attachmentBubbles.splice(attachmentBubbles.indexOf(bubble), 1); timeline.splice(timeline.indexOf(bubble), 1); },
            };
        },
        addServerMsg: (text) => { errors.push(text); timeline.push({ text }); return true; },
        showTypingIndicator: () => composer.setProcessingState(true),
        hideTypingIndicator: () => composer.setProcessingState(false),
        markUserInputSent() {},
        onInputReadinessChange: (ready) => { readiness.push(ready); composer.setReadyState(ready); },
        onInteractionRequest: () => composer.setInteractionState(true),
        onInteractionResolved: () => composer.setInteractionState(false),
    });
    composer.setSendHandler((text) => network.sendCommand(text));
    t.after(() => {
        network.stop();
        for (const [key, value] of originals) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    });
    network.start();
    return {
        network, composer, cmdInput, sendBtn, cancelBtn, sources, inputs, uploads,
        bubbles, attachmentBubbles, errors, banners, readiness, timeline,
        ready() { sources.at(-1).emit('startup-state', { state: 'ready' }); },
    };
}

test('delayed runtime readiness blocks every input path and retains the draft until one HTTP acceptance', async (t) => {
    const response = deferred();
    const f = fixture(t, { inputResponse: () => response.promise });
    const references = [{ kind: 'workspace-path', path: 'note.txt' }];
    f.composer.setSendHandler(async (text, { isCurrentDraft }) => {
        const accepted = await f.network.sendCommand(text, { references: [...references] });
        if (accepted && isCurrentDraft()) references.length = 0;
        return accepted;
    });
    f.composer.setValue('read @note.txt');
    assert.equal(f.cmdInput.disabled, true);
    assert.equal(f.sendBtn.disabled, true);
    f.sources[0].onopen();
    f.sources[0].emit('startup-state', { state: 'starting' });
    t.mock.timers.tick(10000);
    assert.equal(await f.composer.submit(), false);
    assert.equal(await f.network.sendCommand('blocked'), false);
    assert.equal(await f.network.sendQuickCommand('/generic'), false);
    assert.equal(await f.network.sendQuickCommands(['/one', '/two']), false);
    assert.equal(await f.network.sendAttachments([{ file: new File(['data'], 'note.txt') }], 'blocked'), false);
    assert.equal(f.inputs.length, 0);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.composer.getValue(), 'read @note.txt');
    assert.equal(f.composer.typeFromKeyEvent({ key: 'x' }), false);

    f.ready();
    assert.equal(f.cmdInput.disabled, false);
    const submitted = f.composer.submit();
    await flush();
    assert.equal(f.inputs.length, 1);
    assert.equal(f.bubbles.length, 1);
    assert.equal(f.bubbles[0].pending, true);
    assert.equal(f.composer.getValue(), 'read @note.txt');
    assert.equal(references.length, 1);
    assert.equal(f.cmdInput.disabled, true);
    assert.equal(await f.composer.submit(), false);
    response.resolve(new Response(null, { status: 204 }));
    assert.equal(await submitted, true);
    assert.equal(f.composer.getValue(), '');
    assert.equal(references.length, 0);
    assert.equal(f.bubbles.length, 1);
    assert.equal(f.bubbles[0].pending, false);
    assert.deepEqual(f.bubbles[0].options.references, [{ kind: 'workspace-path', path: 'note.txt' }]);
    assert.equal(f.inputs.length, 1);
});

test('repeated 409 admissions never retry blindly, clear drafts, or render a successful user bubble', async (t) => {
    const f = fixture(t, { inputResponse: () => new Response('still starting', { status: 409 }) });
    f.ready();
    f.composer.setValue('keep this draft');
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        assert.equal(await f.composer.submit(), false);
        t.mock.timers.tick(1000);
        assert.equal(f.inputs.length, attempt);
        assert.equal(f.composer.getValue(), 'keep this draft');
        assert.equal(f.bubbles.length, 0);
        assert.equal(f.cmdInput.disabled, false);
        assert.deepEqual(f.banners.at(-1), ['Chat error', 'err']);
    }
    assert.deepEqual(f.errors, ['[input error]', '[input error]']);
});

test('disconnect, reconnect and terminal failure revoke readiness; stale streams cannot enable the composer', async (t) => {
    const f = fixture(t);
    f.ready();
    const first = f.sources[0];
    first.onerror();
    assert.equal(f.cmdInput.disabled, true);
    first.emit('startup-state', { state: 'ready' });
    assert.equal(await f.network.sendQuickCommand('/generic'), false);
    t.mock.timers.tick(1000);
    const second = f.sources[1];
    second.onopen();
    assert.equal(f.cmdInput.disabled, true);
    f.ready();
    assert.equal(f.cmdInput.disabled, false);
    assert.equal(await f.network.sendQuickCommand('/generic'), true);
    second.emit('startup-state', { state: 'failed' });
    assert.equal(f.cmdInput.disabled, true);
    second.emit('startup-state', { state: 'ready' });
    assert.equal(await f.composer.submit(), false);
    assert.equal(await f.network.sendQuickCommands(['/one']), false);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.readiness.at(-1), false);
});

test('interaction blocking composes with startup readiness and keeps processing cancellation available only online', async (t) => {
    const f = fixture(t);
    f.ready();
    f.composer.setProcessingState(true);
    assert.equal(f.cancelBtn.attributes.has('hidden'), false);
    f.sources[0].emit('interaction-request', { id: 'choice', kind: 'choice', title: 'Choose', options: [{ id: 'a', label: 'A' }] });
    assert.equal(f.cmdInput.disabled, true);
    assert.equal(await f.network.sendCommand('blocked'), false);
    assert.equal(await f.network.sendQuickCommand('/blocked'), false);
    f.sources[0].emit('interaction-resolved', { id: 'choice' });
    assert.equal(f.cmdInput.disabled, false);
    f.sources[0].onerror();
    assert.equal(f.cancelBtn.attributes.has('hidden'), true);
    f.composer.setInteractionState(false);
    assert.equal(f.cmdInput.disabled, true);
});

test('a disconnect during browser proof acquisition prevents sending to a different runtime', async (t) => {
    const proof = deferred();
    let proofFactory;
    const f = fixture(t, { proofResponse: (makeProof) => { proofFactory = makeProof; return proof.promise; } });
    f.ready();
    f.composer.setValue('old runtime draft');
    const submitted = f.composer.submit();
    await flush();
    f.sources[0].onerror();
    t.mock.timers.tick(1000);
    f.ready();
    proof.resolve(proofFactory());
    assert.equal(await submitted, false);
    assert.equal(f.inputs.length, 0);
    assert.equal(f.bubbles.length, 0);
    assert.equal(f.composer.getValue(), 'old runtime draft');
});

test('HTTP acceptance clears only the acknowledged draft revision, not a replacement draft', async (t) => {
    const response = deferred();
    const f = fixture(t, { inputResponse: () => response.promise });
    f.ready();
    f.composer.setValue('first draft');
    const submitted = f.composer.submit();
    await flush();
    f.composer.setValue('replacement draft');
    response.resolve(new Response(null, { status: 204 }));
    assert.equal(await submitted, true);
    assert.equal(f.composer.getValue(), 'replacement draft');
    assert.equal(f.bubbles[0].text, 'first draft');
});

test('attachment admission retains uploaded selections after rejection and acknowledges them without reuploading', async (t) => {
    let status = 409;
    const response = deferred();
    const f = fixture(t, { inputResponse: () => status === 409 ? response.promise : new Response(null, { status }) });
    const selection = { selectionId: {}, file: new File(['data'], 'note.txt') };
    f.ready();
    const submitted = f.network.sendAttachments([selection], 'caption');
    await flush();
    assert.equal(f.uploads.length, 1);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.attachmentBubbles.length, 1);
    assert.equal(f.attachmentBubbles[0].pending, true);
    response.resolve(new Response('input unavailable', { status: 409 }));
    assert.equal(await submitted, false);
    assert.equal(f.attachmentBubbles.length, 0);
    status = 204;
    assert.equal(await f.network.sendAttachments([selection], 'caption'), true);
    assert.equal(f.uploads.length, 1);
    assert.equal(f.inputs.length, 2);
    assert.equal(f.attachmentBubbles.length, 1);
    assert.equal(f.attachmentBubbles[0].pending, false);
    assert.equal(f.attachmentBubbles[0].details.caption, 'caption');
    assert.equal(f.attachmentBubbles[0].upload.localPath, 'note.txt');
});

test('partial upload failure does not send a partial message or discard already uploaded selections', async (t) => {
    let failSecond = true;
    const f = fixture(t, {
        uploadResponse: ({ options }) => options.body.name === 'second.txt' && failSecond
            ? new Response('quota', { status: 507 })
            : Response.json({ filename: options.body.name, localPath: options.body.name }),
    });
    f.ready();
    const selections = ['first.txt', 'second.txt'].map((name) => ({ file: new File(['data'], name) }));
    assert.equal(await f.network.sendAttachments(selections, 'both files'), false);
    assert.equal(f.inputs.length, 0);
    assert.equal(f.attachmentBubbles.length, 0);
    failSecond = false;
    assert.equal(await f.network.sendAttachments(selections, 'both files'), true);
    assert.equal(f.uploads.length, 3);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.attachmentBubbles.length, 2);
});

test('an attachment upload finishing after reconnect cannot send into the replacement stream', async (t) => {
    const upload = deferred();
    const f = fixture(t, { uploadResponse: () => upload.promise });
    f.ready();
    const submitted = f.network.sendAttachments([{ file: new File(['data'], 'note.txt') }], 'caption');
    await flush();
    f.sources[0].onerror();
    t.mock.timers.tick(1000);
    f.ready();
    upload.resolve(Response.json({ localPath: 'note.txt' }));
    assert.equal(await submitted, false);
    assert.equal(f.inputs.length, 0);
    assert.equal(f.attachmentBubbles.length, 0);
});

test('fast streamed replies stay after pending user text and attachments before HTTP acceptance', async (t) => {
    const response = deferred();
    const f = fixture(t, { inputResponse: () => response.promise });
    f.ready();
    f.composer.setValue('fast question');
    const submitted = f.composer.submit();
    await flush();
    f.sources[0].onmessage({ data: JSON.stringify({ text: 'fast answer' }) });
    assert.equal(f.timeline[0], f.bubbles[0]);
    assert.equal(f.timeline[0].pending, true);
    assert.equal(f.timeline[1].text, 'fast answer');
    assert.equal(f.composer.getValue(), 'fast question');
    response.resolve(new Response(null, { status: 204 }));
    assert.equal(await submitted, true);
    assert.equal(f.timeline[0].pending, false);
    assert.equal(f.timeline[1].text, 'fast answer');

    const attachmentResponse = deferred();
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => String(url).includes('/input?')
        ? attachmentResponse.promise : oldFetch(url, options);
    const upload = f.network.sendAttachments([{ file: new File(['data'], 'note.txt') }], 'file question');
    await flush();
    f.sources[0].onmessage({ data: JSON.stringify({ text: 'file answer' }) });
    assert.equal(f.timeline[2], f.attachmentBubbles[0]);
    assert.equal(f.timeline[2].pending, true);
    assert.equal(f.timeline[3].text, 'file answer');
    attachmentResponse.resolve(new Response(null, { status: 204 }));
    assert.equal(await upload, true);
    assert.equal(f.timeline[2].pending, false);
});

test('pending delivery explicitly hides sent checkmarks and is finalized or removed by acknowledgment', (t) => {
    const originalDocument = globalThis.document;
    const icon = { style: {} };
    const labels = [];
    const wrapper = {
        dataset: {},
        querySelector: (selector) => selector === '.wa-seen-icon'
            ? icon : { appendChild: (label) => labels.push(label) },
        remove() { this.removed = true; },
    };
    globalThis.document = {
        createElement: () => ({ setAttribute() {}, remove() { this.removed = true; } }),
    };
    t.after(() => { globalThis.document = originalDocument; });
    const pending = messageTestables.createDeliveryState(wrapper, true);
    assert.equal(wrapper.dataset.deliveryState, 'pending');
    assert.equal(icon.style.display, 'none');
    assert.match(labels[0].textContent, /Sending/);
    pending.markSent();
    assert.equal(wrapper.dataset.deliveryState, 'sent');
    assert.equal(icon.style.display, '');
    assert.equal(labels[0].removed, true);
    const rejected = messageTestables.createDeliveryState(wrapper, true);
    rejected.remove();
    assert.equal(wrapper.removed, true);
    assert.equal(wrapper.dataset.deliveryState, 'pending');
});
