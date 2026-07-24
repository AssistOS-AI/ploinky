import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(
    new URL('../../cli/server/webchat/webchat.css', import.meta.url),
    'utf8',
);
const sidePanelSource = readFileSync(
    new URL('../../cli/server/webchat/sidePanel.js', import.meta.url),
    'utf8',
);

test('message links use a single-line ellipsis without changing their href', () => {
    const rule = css.match(/\.wa-message-text a\s*\{([^}]+)\}/)?.[1] || '';

    assert.match(rule, /display:\s*inline-block;/);
    assert.match(rule, /max-width:\s*100%;/);
    assert.match(rule, /overflow:\s*hidden;/);
    assert.match(rule, /text-overflow:\s*ellipsis;/);
    assert.match(rule, /white-space:\s*nowrap;/);
});

test('side-panel URL title shrinks inside the header and uses an ellipsis', () => {
    const titleRule = css.match(/\.wa-side-panel-title\s*\{([^}]+)\}/)?.[1] || '';
    const rowRule = css.match(/\.wa-side-panel-title-row\s*\{([^}]+)\}/)?.[1] || '';
    const linkRule = css.match(/\.wa-side-panel-title a\s*\{([^}]+)\}/)?.[1] || '';

    assert.match(titleRule, /min-width:\s*0;/);
    assert.match(rowRule, /display:\s*flex;/);
    assert.match(rowRule, /max-width:\s*100%;/);
    assert.match(linkRule, /overflow:\s*hidden;/);
    assert.match(linkRule, /text-overflow:\s*ellipsis;/);
    assert.match(linkRule, /white-space:\s*nowrap;/);
    assert.match(sidePanelSource, /anchor\.className = 'wa-side-panel-title-link'/);
    assert.doesNotMatch(sidePanelSource, /anchor\.style\.(?:wordBreak|overflowWrap)/);
});
