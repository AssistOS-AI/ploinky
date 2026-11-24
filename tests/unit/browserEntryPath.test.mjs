import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrowserEntryPath } from '../../cli/server/browserEntryPath.js';

const entry = '/base-agent-additional-server/reader/3210/';
const manifest = entryPath => ({ routerAccess: {
    entryPath, httpRoutes: [{ path: entry, access: 'public' }],
} });

test('server applications declare their browser entry without changing static agents', () => {
    assert.equal(resolveBrowserEntryPath('reader', manifest(entry)), entry);
    assert.equal(resolveBrowserEntryPath('static-app', {}), '/static-app/index.html');
    assert.equal(resolveBrowserEntryPath('reader', { routerAccess: { entryPath: entry + 'account/', httpRoutes: {
        [entry + '*']: 'authenticated',
    } } }), entry + 'account/');
});

test('browser entries reject external, ambiguous, undeclared and foreign-agent destinations', () => {
    for (const path of [null, '', '/', '//outside.example/', 'https://outside.example/',
        '/auth/logout', '/reader/../other/', entry + '?next=/', entry + '#part',
        '/base-agent-additional-server/other/3210/', entry + '%2f', entry + '*', ` ${entry}`]) {
        assert.throws(() => resolveBrowserEntryPath('reader', manifest(path)), /routerAccess.entryPath/, String(path));
    }
    assert.throws(() => resolveBrowserEntryPath('reader', { routerAccess: { entryPath: entry, httpRoutes: [] } }), /enabled HTTP route/);
    assert.throws(() => resolveBrowserEntryPath('reader', { routerAccess: { entryPath: entry,
        httpRoutes: [{ path: entry, access: 'public', enabled: false }],
    } }), /enabled HTTP route/);
});
