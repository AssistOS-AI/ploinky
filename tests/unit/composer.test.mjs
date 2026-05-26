import test from 'node:test';
import assert from 'node:assert/strict';

import { createComposer } from '../../cli/server/webchat/composer.js';

function createMockComposerDom() {
    const listeners = new Map();
    const cmdInput = {
        value: '',
        selectionStart: 0,
        selectionEnd: 0,
        scrollTop: 0,
        style: {},
        closest: () => null,
        focus() {
            globalThis.document.activeElement = cmdInput;
        },
        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        },
        addEventListener(type, handler) {
            if (!listeners.has(type)) {
                listeners.set(type, []);
            }
            listeners.get(type).push(handler);
        },
        dispatchEvent(event) {
            const handlers = listeners.get(event.type) || [];
            for (const handler of handlers) {
                handler(event);
            }
            return true;
        },
    };

    const document = {
        activeElement: null,
        documentElement: {
            style: {
                setProperty() {},
            },
        },
    };

    const window = {
        addEventListener() {},
        removeEventListener() {},
        requestAnimationFrame(callback) {
            callback();
        },
    };

    return { cmdInput, document, window };
}

test('composer.setValue dispatches input and syncs caret to the end', () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalEvent = globalThis.Event;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const { cmdInput, document, window } = createMockComposerDom();
    let inputEvents = 0;

    globalThis.document = document;
    globalThis.window = window;
    globalThis.setTimeout = (fn, ...args) => {
        fn(...args);
        return 0;
    };
    globalThis.clearTimeout = () => {};
    try {
        const composer = createComposer(
            { cmdInput, sendBtn: null, cancelBtn: null },
            { purgeTriggerRe: /__never__/ },
        );
        cmdInput.addEventListener('input', () => {
            inputEvents += 1;
        });

        composer.setValue('hello world');

        assert.equal(cmdInput.value, 'hello world');
        assert.equal(cmdInput.selectionStart, 11);
        assert.equal(cmdInput.selectionEnd, 11);
        assert.equal(inputEvents, 1);
    } finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.Event = originalEvent;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});

test('composer.focus moves the caret to the end even when the input is already active', () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalEvent = globalThis.Event;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const { cmdInput, document, window } = createMockComposerDom();

    globalThis.document = document;
    globalThis.window = window;
    globalThis.setTimeout = (fn, ...args) => {
        fn(...args);
        return 0;
    };
    globalThis.clearTimeout = () => {};
    try {
        cmdInput.value = 'inserted text';
        cmdInput.selectionStart = 0;
        cmdInput.selectionEnd = 0;
        document.activeElement = cmdInput;

        const composer = createComposer(
            { cmdInput, sendBtn: null, cancelBtn: null },
            { purgeTriggerRe: /__never__/ },
        );
        composer.focus();

        assert.equal(cmdInput.selectionStart, 13);
        assert.equal(cmdInput.selectionEnd, 13);
    } finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.Event = originalEvent;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});
