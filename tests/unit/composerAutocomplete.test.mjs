import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createComposerAutocomplete,
    findTriggerAt,
    keepAutocompleteItemVisible,
    nextAutocompleteRenderCount,
} from '../../cli/server/webchat/composerAutocomplete.js';
import {
    createComposerMentionHighlighter,
    extractMentionTokenAt,
    findMentionRanges,
    renderMentionHighlightHtml,
} from '../../cli/server/webchat/composerMentionHighlights.js';

test('keepAutocompleteItemVisible scrolls keyboard selection into the menu viewport', () => {
    const menu = { clientHeight: 100, scrollTop: 0 };

    keepAutocompleteItemVisible(menu, { offsetTop: 90, offsetHeight: 30 });
    assert.equal(menu.scrollTop, 20);

    keepAutocompleteItemVisible(menu, { offsetTop: 5, offsetHeight: 30 });
    assert.equal(menu.scrollTop, 5);

    keepAutocompleteItemVisible(menu, { offsetTop: 35, offsetHeight: 30 });
    assert.equal(menu.scrollTop, 5);
});

test('nextAutocompleteRenderCount progressively exposes the complete suggestion list', () => {
    assert.equal(nextAutocompleteRenderCount(24, 352, 24), 48);
    assert.equal(nextAutocompleteRenderCount(336, 352, 24), 352);
    assert.equal(nextAutocompleteRenderCount(352, 352, 24), 352);
});

test('findTriggerAt detects slash at start of input', () => {
    const result = findTriggerAt('/bu', 3, ['/', '@']);
    assert.deepEqual(result, { trigger: '/', triggerIndex: 0, token: 'bu' });
});

test('findTriggerAt keeps provider slashes inside the initial command argument', () => {
    const value = '/model anthropic/claude';
    const result = findTriggerAt(value, value.length, ['/', '@']);
    assert.deepEqual(result, {
        trigger: '/',
        triggerIndex: 0,
        token: 'model anthropic/claude',
    });
});

test('findTriggerAt detects @ after whitespace', () => {
    const result = findTriggerAt('summary @open-i', 15, ['/', '@']);
    assert.deepEqual(result, { trigger: '@', triggerIndex: 8, token: 'open-i' });
});

test('findTriggerAt ends @ autocomplete after a trailing space', () => {
    assert.equal(findTriggerAt('@docs/ ', 7, ['@']), null);
    assert.equal(findTriggerAt('@docs/file.md ', 14, ['@']), null);
});

test('findTriggerAt still resolves a manual @ path when the caret is before later text', () => {
    const result = findTriggerAt('@docs/ later', 6, ['@']);
    assert.deepEqual(result, { trigger: '@', triggerIndex: 0, token: 'docs/' });
});

test('findTriggerAt prefers the most recent trigger', () => {
    const result = findTriggerAt('/build @ot', 10, ['/', '@']);
    assert.deepEqual(result, { trigger: '@', triggerIndex: 7, token: 'ot' });
});

test('findTriggerAt ignores trigger characters embedded in words', () => {
    const result = findTriggerAt('user@example.com', 16, ['@']);
    assert.equal(result, null);
});

test('findTriggerAt ignores trigger after a newline boundary between caret and token', () => {
    const result = findTriggerAt('@line1\n more', 11, ['@']);
    assert.equal(result, null);
});

test('disabled autocomplete loading row consumes Enter without selecting or submitting', (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const bodyChildren = [];
    const createElement = () => {
        const classes = new Set();
        return {
            children: [],
            className: '',
            classList: {
                add: (name) => classes.add(name),
                remove: (name) => classes.delete(name),
            },
            style: {},
            clientHeight: 0,
            scrollTop: 0,
            appendChild(child) {
                this.children.push(child);
                this.firstChild = this.children[0] || null;
                return child;
            },
            removeChild(child) {
                this.children.splice(this.children.indexOf(child), 1);
                this.firstChild = this.children[0] || null;
            },
            addEventListener() {},
            setAttribute() {},
            querySelector() { return null; },
            remove() {},
        };
    };
    globalThis.document = {
        createElement,
        body: {
            appendChild(child) {
                bodyChildren.push(child);
                return child;
            },
        },
    };
    globalThis.window = { innerHeight: 800 };
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });

    let selected = false;
    const cmdInput = {
        value: '/',
        selectionStart: 1,
        getBoundingClientRect: () => ({ left: 10, top: 700, width: 400 }),
        closest: () => null,
        focus() {},
        dispatchEvent() {},
        setSelectionRange() {},
    };
    const autocomplete = createComposerAutocomplete({ cmdInput }, {
        positionStrategy: 'viewport',
        providers: [{
            trigger: '/',
            getSuggestions: () => [{
                label: 'Loading models…',
                disabled: true,
                onSelected: () => { selected = true; },
            }],
        }],
    });
    autocomplete.onInputChange();
    let prevented = false;
    const handled = autocomplete.handleKeydown({
        key: 'Enter',
        preventDefault: () => { prevented = true; },
    });

    assert.equal(bodyChildren.length, 1);
    assert.equal(bodyChildren[0].style.display, 'block');
    assert.equal(handled, true);
    assert.equal(prevented, true);
    assert.equal(selected, false);
});

test('extractMentionTokenAt returns a selected plain @ path token', () => {
    assert.equal(extractMentionTokenAt('@README.md ', 11), '@README.md');
    assert.equal(extractMentionTokenAt('see @docs/notes.md ', 19), '@docs/notes.md');
});

test('renderMentionHighlightHtml highlights only explicitly recorded @ path tokens', () => {
    const html = renderMentionHighlightHtml('ask @open-interpreter about @src/index.js', ['@src/index.js']);
    assert.doesNotMatch(html, /<strong class="wa-composer-mention">@open-interpreter<\/strong>/);
    assert.match(html, /<strong class="wa-composer-mention">@src\/index\.js<\/strong>$/);

    const rootFileHtml = renderMentionHighlightHtml('read @Makefile', ['@Makefile']);
    assert.match(rootFileHtml, /<strong class="wa-composer-mention">@Makefile<\/strong>/);
});

test('findMentionRanges detects only supplied workspace reference tokens', () => {
    assert.deepEqual(findMentionRanges('ask @open-interpreter hello'), []);
    assert.deepEqual(findMentionRanges('read @ploinky/cli/server', ['@ploinky/cli/server']), [
        { start: 5, end: 24, token: '@ploinky/cli/server' },
    ]);
});

test('findMentionRanges ignores embedded email-like at signs', () => {
    assert.deepEqual(findMentionRanges('email user@example.com', ['@example.com']), []);
});

test('composer mention overlay stays inactive while a folder selection remains open', () => {
    const originalDocument = globalThis.document;
    const classes = new Set();
    const listeners = new Map();
    const inserted = [];
    const wrapper = {
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
        },
        insertBefore: (node) => inserted.push(node),
    };
    const cmdInput = {
        value: '',
        scrollTop: 0,
        scrollLeft: 0,
        closest: () => wrapper,
        addEventListener: (name, listener) => {
            const entries = listeners.get(name) || [];
            entries.push(listener);
            listeners.set(name, entries);
        },
    };

    globalThis.document = {
        createElement: () => ({
            className: '',
            hidden: false,
            innerHTML: '',
            setAttribute() {},
        }),
    };

    try {
        const highlighter = createComposerMentionHighlighter({ cmdInput });
        assert.equal(inserted.length, 0);
        assert.equal(classes.has('wa-mention-highlights-active'), false);

        cmdInput.value = '@docs/';
        highlighter.recordSelection(cmdInput.value, cmdInput.value.length, { final: false });
        assert.deepEqual(highlighter.tokens, []);
        assert.equal(inserted.length, 0);
        assert.equal(classes.has('wa-mention-highlights-active'), false);

        cmdInput.value = '@docs/README.md ';
        highlighter.recordSelection(cmdInput.value, cmdInput.value.length, { final: true });
        assert.deepEqual(highlighter.tokens, ['@docs/README.md']);
        assert.equal(inserted.length, 1);
        assert.equal(classes.has('wa-mention-highlights-active'), true);

        cmdInput.value = '@docs/README.m ';
        for (const listener of listeners.get('input') || []) listener();
        assert.deepEqual(highlighter.tokens, []);
        assert.equal(inserted[0].hidden, true);
        assert.equal(classes.has('wa-mention-highlights-active'), false);
    } finally {
        globalThis.document = originalDocument;
    }
});
