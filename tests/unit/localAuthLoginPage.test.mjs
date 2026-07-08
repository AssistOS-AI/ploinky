import test from 'node:test';
import assert from 'node:assert/strict';

import { renderLocalLoginHtml } from '../../cli/server/authHandlers/authPages.js';

test('local login form posts to the target agent auth context', () => {
    const html = renderLocalLoginHtml({
        agentName: 'explorer',
        returnTo: '/explorer/index.html#file-exp/',
    });

    assert.match(
        html,
        /<form method="post" action="\/auth\/login\?agent=explorer"[^>]*>/,
        'local login POST must keep the agent query so auth context is resolved before reading the body',
    );
    assert.match(html, /<input type="hidden" name="agent" value="explorer" \/>/);
    assert.match(html, /<input type="hidden" name="returnTo" value="\/explorer\/index\.html#file-exp\/" \/>/);
});
