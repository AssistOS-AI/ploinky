import test from 'node:test';
import assert from 'node:assert/strict';
import { WhitelistPath } from '../../cli/server/policy/WhitelistPath.js';
import { HttpRouteWhitelist } from '../../cli/server/policy/HttpRouteWhitelist.js';

// Fake repository — demonstrates the dependency-injection isolation payoff:
// the whitelist matcher is tested without any temp files or real persistence.
class FakeRepo {
    constructor(entries = [], corrupt = false) { this._entries = entries; this._corrupt = corrupt; }
    listHttpRoutes() { return this._corrupt ? { corrupt: true, entries: [] } : { corrupt: false, entries: this._entries }; }
}
const route = (p, extra = {}) => ({ path: p, enabled: true, ...extra });

test('WhitelistPath.normalize accepts trailing /* and rejects the documented bad forms', () => {
    assert.equal(WhitelistPath.normalize('/explorer/public-view/folder/*').path, '/explorer/public-view/folder/*');
    assert.equal(WhitelistPath.normalize('explorer/x').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('/a/../b').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('/%2Fsecret').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('/a\\b').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('https://evil/x').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('/a//b').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('/a/*/b').code, 'INVALID_WILDCARD');
    assert.equal(WhitelistPath.normalize('/**').code, 'INVALID_WILDCARD');
    assert.equal(WhitelistPath.normalize('/*/edit').code, 'INVALID_WILDCARD');
    assert.equal(WhitelistPath.normalize('/').code, 'INVALID_PATH');
    assert.equal(WhitelistPath.normalize('/a/b?secret=1').path, '/a/b');
});

test('WhitelistPath.isInternal flags router-owned routes', () => {
    for (const p of ['/whitelist/command', '/auth', '/auth/login', '/admin/x', '/__agent/x', '/explorer/__agent/s', '/metrics', '/health/internal', '/*', '/']) {
        assert.equal(WhitelistPath.isInternal(p), true, p);
    }
    for (const p of ['/explorer/public-view/x', '/explorer/public-view/folder/*', '/x/y']) {
        assert.equal(WhitelistPath.isInternal(p), false, p);
    }
});

test('isReachableByGuest honors wildcard/exact/method/query', () => {
    const wl = new HttpRouteWhitelist({ repository: new FakeRepo([route('/explorer/public-view/folder/*'), route('/x/y')]) });
    assert.equal(wl.isReachableByGuest('/explorer/public-view/folder/a', 'GET'), true);
    assert.equal(wl.isReachableByGuest('/explorer/public-view/folder/a/b', 'GET'), true);
    assert.equal(wl.isReachableByGuest('/explorer/public-view/folder', 'GET'), true);
    assert.equal(wl.isReachableByGuest('/explorer/public-view/folderX', 'GET'), false);
    assert.equal(wl.isReachableByGuest('/explorer/public-view/other', 'GET'), false);
    assert.equal(wl.isReachableByGuest('/x/y', 'HEAD'), true);
    assert.equal(wl.isReachableByGuest('/x/y', 'POST'), false);
    assert.equal(wl.isReachableByGuest('/x/y/z', 'GET'), false);
    assert.equal(wl.isReachableByGuest('/x/y?token=secret', 'GET'), true);
});

test('an internal route is never reachable, even from a corrupted entry or a broad wildcard', () => {
    const wlInternal = new HttpRouteWhitelist({ repository: new FakeRepo([route('/auth/login'), route('/explorer/__agent/s')]) });
    assert.equal(wlInternal.isReachableByGuest('/auth/login', 'GET'), false);
    assert.equal(wlInternal.isReachableByGuest('/explorer/__agent/s', 'GET'), false);

    const wlBroad = new HttpRouteWhitelist({ repository: new FakeRepo([route('/explorer/*')]) });
    assert.equal(wlBroad.isReachableByGuest('/explorer/public', 'GET'), true);
    assert.equal(wlBroad.isReachableByGuest('/explorer/__agent/x', 'GET'), false);
});

test('a corrupt policy fails closed (nothing public)', () => {
    const wl = new HttpRouteWhitelist({ repository: new FakeRepo([], true) });
    assert.equal(wl.isReachableByGuest('/x/y', 'GET'), false);
});
