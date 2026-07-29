import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendLocationHashToRelativeTarget,
    normalizeRelativePath,
} from '../../cli/server/authHandlers/shared.js';

test('auth return targets retain legitimate same-origin paths, queries, and Explorer fragments', () => {
    const validTargets = [
        '/',
        '/dashboard',
        '/webchat/',
        '/auth/logged-out?next=%2Fexplorer%2Findex.html',
        '/explorer/index.html?view=list#file-exp/Confidential/My%20Space',
        '/explorer/index.html#file-exp/Confidential/My%20Space',
        '/explorer/index.html#file-exp/Percent%25Folder',
        '/search?q=Confidential%20Space&next=%2Fdashboard',
        '/search?q=100%25',
    ];

    for (const target of validTargets) {
        assert.equal(normalizeRelativePath(target, '/fallback'), target);
    }
});

test('auth return targets reject authority, separator, control, whitespace, and malformed encodings', () => {
    const invalidTargets = [
        '',
        ' ',
        ' /dashboard',
        '/dashboard ',
        'dashboard',
        'https://evil.example/explorer',
        'http:evil.example',
        '//evil.example/explorer',
        String.raw`\\evil.example\explorer`,
        String.raw`/\evil.example/explorer`,
        '/%2fevil.example/explorer',
        '/%2Fevil.example/explorer',
        '/%252fevil.example/explorer',
        '/%252Fevil.example/explorer',
        '/%25%32%66evil.example/explorer',
        '/%25%35%43evil.example/explorer',
        '/%25252f evil.example/explorer',
        '/%5cevil.example/explorer',
        '/%5Cevil.example/explorer',
        '/%255cevil.example/explorer',
        '/%255Cevil.example/explorer',
        '/safe%0dLocation:%20https://evil.example',
        '/safe%0ALocation:%20https://evil.example',
        '/safe%250DLocation:%20https://evil.example',
        '/safe%250aLocation:%20https://evil.example',
        '/safe\u0000path',
        '/safe\npath',
        '/safe%zzpath',
        '/safe%2',
        '/safe%C0%AFpath',
        '/safe%ED%A0%80path',
        '/safe#//evil.example',
        '/safe#https://evil.example',
        '/safe#%2f%2fevil.example',
        '/safe#%252F%252Fevil.example',
        '/safe#%25%32%66%25%32%66evil.example',
        '/safe#%68%74%74%70%73%3a%2f%2fevil.example',
        '/safe#%2568%2574%2574%2570%2573%253a%252f%252fevil.example',
        '/safe# route',
        '/safe#file exp',
        '/safe#route ',
    ];

    for (const target of invalidTargets) {
        assert.equal(normalizeRelativePath(target, '/fallback'), '/fallback', target);
    }
});

test('auth return targets reject mixed-case separator and control encodings through nested percent layers', () => {
    const unsafeCodes = ['2f', '2F', '5c', '5C', '0a', '0A', '0d', '0D'];
    for (const code of unsafeCodes) {
        let encoded = `%${code}`;
        for (let depth = 1; depth <= 6; depth += 1) {
            assert.equal(
                normalizeRelativePath(`/safe/${encoded}escape`, '/fallback'),
                '/fallback',
                `${code} at encoding depth ${depth}`,
            );
            assert.equal(
                normalizeRelativePath(`/safe#file-exp/${encoded}escape`, '/fallback'),
                '/fallback',
                `${code} fragment at encoding depth ${depth}`,
            );
            encoded = encoded.replace('%', '%25');
        }
    }
});

test('login fragment append preserves only safe route state on an already-normalized target', () => {
    const target = '/explorer/index.html';
    const explorerHash = '#file-exp/Confidential/My%20Space';

    assert.equal(
        appendLocationHashToRelativeTarget(target, explorerHash),
        `${target}${explorerHash}`,
    );
    assert.equal(
        appendLocationHashToRelativeTarget(target, '#file-exp/Percent%25Folder'),
        `${target}#file-exp/Percent%25Folder`,
    );
    assert.equal(
        appendLocationHashToRelativeTarget(`${target}#file-exp/Existing`, explorerHash),
        `${target}#file-exp/Existing`,
    );
    assert.equal(appendLocationHashToRelativeTarget(target, ''), target);
    assert.equal(appendLocationHashToRelativeTarget(target, '#'), target);

    for (const hash of [
        '#//evil.example',
        '#https://evil.example',
        '#%2f%2fevil.example',
        '#%252F%252Fevil.example',
        '#%25%32%66%25%32%66evil.example',
        '#%68%74%74%70%73%3a%2f%2fevil.example',
        '#%2568%2574%2574%2570%2573%253a%252f%252fevil.example',
        '#file-exp%5c..%5cevil',
        '#file-exp%255c..%255cevil',
        '#file-exp%0droute',
        '#file-exp%250Aroute',
        '# file-exp',
        '#file exp',
        '#file-exp ',
        '#file-exp/%zz',
    ]) {
        assert.equal(appendLocationHashToRelativeTarget(target, hash), target, hash);
    }
});
