import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { renderLocalLoginHtml } from '../../cli/server/authHandlers/authPages.js';

function executeLoginSubmit(html, locationHash) {
    const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
    assert.ok(script, 'local login page must contain its submit script');

    const returnTo = {
        value: html.match(/name="returnTo" value="([^"]*)"/)?.[1],
    };
    const loadingClasses = new Set();
    const button = {
        classList: {
            contains(value) {
                return loadingClasses.has(value);
            },
            add(value) {
                loadingClasses.add(value);
            },
        },
        disabled: false,
        innerHTML: '',
    };
    let submit;
    const form = {
        elements: {
            namedItem(name) {
                return name === 'returnTo' ? returnTo : null;
            },
        },
        querySelector(selector) {
            return selector === 'button[type="submit"]' ? button : null;
        },
        addEventListener(name, listener) {
            assert.equal(name, 'submit');
            assert.equal(submit, undefined, 'login page must install one submit listener');
            submit = listener;
        },
    };

    vm.runInNewContext(script, {
        URL,
        document: {
            querySelector(selector) {
                return selector === 'form[data-auth-login-form]' ? form : null;
            },
        },
        window: {
            location: {
                hash: locationHash,
            },
        },
    });
    assert.equal(typeof submit, 'function');
    submit();
    return {
        returnTo: returnTo.value,
        button,
    };
}

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

test('local login submit appends the current safe Explorer hash exactly once', () => {
    const html = renderLocalLoginHtml({
        agentName: 'explorer',
        returnTo: '/explorer/index.html',
    });
    const result = executeLoginSubmit(html, '#file-exp/Confidential/My%20Space');

    assert.equal(result.returnTo, '/explorer/index.html#file-exp/Confidential/My%20Space');
    assert.equal(result.button.disabled, true);
    assert.doesNotMatch(html, /(?:localStorage|sessionStorage|document\.cookie|location\.(?:assign|replace))/);
});

test('local login submit does not append unsafe fragment authority or encoded separators', () => {
    for (const hash of [
        '#//evil.example',
        '#https://evil.example',
        '#%2f%2fevil.example',
        '#%252F%252Fevil.example',
        '#file-exp%0droute',
        '#file-exp/%zz',
    ]) {
        const html = renderLocalLoginHtml({
            agentName: 'explorer',
            returnTo: '/explorer/index.html',
        });
        assert.equal(executeLoginSubmit(html, hash).returnTo, '/explorer/index.html', hash);
    }
});

test('local login rendering replaces invalid return targets with the safe root fallback', () => {
    for (const returnTo of [
        'https://evil.example/explorer',
        '//evil.example/explorer',
        '/%2f%2fevil.example/explorer',
        '/%252f%252fevil.example/explorer',
        '/safe%0dLocation:%20https://evil.example',
        '/safe#https://evil.example',
    ]) {
        const html = renderLocalLoginHtml({
            agentName: 'explorer',
            returnTo,
        });
        assert.match(html, /<input type="hidden" name="returnTo" value="\/" \/>/, returnTo);
    }
});
