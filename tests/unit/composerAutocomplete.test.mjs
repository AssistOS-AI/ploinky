import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findTriggerAt,
    keepAutocompleteItemVisible,
    nextAutocompleteRenderCount,
} from '../../cli/server/webchat/composerAutocomplete.js';
import {
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

test('extractMentionTokenAt returns file mentions and ignores provider-looking tokens', () => {
    assert.equal(extractMentionTokenAt('@open-interpreter ', 18), '');
    assert.equal(extractMentionTokenAt('see @file:docs/notes.md ', 24), '@file:docs/notes.md');
});

test('renderMentionHighlightHtml bolds only recorded file mention tokens', () => {
    const html = renderMentionHighlightHtml('ask @open-interpreter about @op', ['@open-interpreter']);
    assert.doesNotMatch(html, /<strong class="wa-composer-mention">@open-interpreter<\/strong>/);
    assert.match(html, /about @op$/);

    const fileHtml = renderMentionHighlightHtml('read @file:docs/notes.md', ['@file:docs/notes.md']);
    assert.match(fileHtml, /<strong class="wa-composer-mention">@file:docs\/notes\.md<\/strong>/);
});

test('findMentionRanges detects file mentions and ignores provider-looking tokens', () => {
    assert.deepEqual(findMentionRanges('ask @open-interpreter hello'), []);
    assert.deepEqual(findMentionRanges('read @file:ploinky/cli/server'), [
        { start: 5, end: 29, token: '@file:ploinky/cli/server' },
    ]);
});

test('findMentionRanges ignores embedded email-like at signs', () => {
    assert.deepEqual(findMentionRanges('email user@example.com about @open-interpreter'), []);
});
