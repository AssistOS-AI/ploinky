import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PLOINKY_MASTER_KEY = process.env.PLOINKY_MASTER_KEY || '5'.repeat(64);

const suffix = `?t=${Date.now()}`;
const depInstUrl = new URL('../../cli/utils/dependencies/dependencyInstaller.js', import.meta.url);
const depCacheUrl = new URL('../../cli/utils/dependencies/dependencyCache.js', import.meta.url);

const { readGlobalDepsPackage } = await import(`${depInstUrl.href}${suffix}`);
const { resolveGlobalCacheManifest } = await import(`${depCacheUrl.href}${suffix}`);

const BRANCH = 'soul-gateway-local-integration';

// readGlobalDepsPackage must honor an explicitly passed env so the cache layer
// (which may run in any process) can resolve the override deterministically.
test('readGlobalDepsPackage honors an explicit env argument', () => {
    const base = readGlobalDepsPackage({});
    const over = readGlobalDepsPackage({ PLOINKY_AGENTLIB_REF: BRANCH });
    assert.match(base.dependencies.achillesAgentLib, /#master$/);
    assert.match(over.dependencies.achillesAgentLib, new RegExp(`#${BRANCH}$`));
});

// The shared global cache key AND package contents must reflect the override,
// so the cache invalidates and rebuilds on the branch instead of serving master.
test('resolveGlobalCacheManifest: override changes both the package and the cache key', () => {
    const base = resolveGlobalCacheManifest({});
    const over = resolveGlobalCacheManifest({ PLOINKY_AGENTLIB_REF: BRANCH });
    assert.match(over.pkg.dependencies.achillesAgentLib, new RegExp(`#${BRANCH}$`));
    assert.notEqual(base.hash, over.hash);
    assert.equal(typeof over.hash, 'string');
    assert.equal(over.hash.length, 64);
});

test('resolveGlobalCacheManifest: no override resolves master with a stable hash', () => {
    const a = resolveGlobalCacheManifest({});
    const b = resolveGlobalCacheManifest({});
    assert.match(a.pkg.dependencies.achillesAgentLib, /#master$/);
    assert.equal(a.hash, b.hash);
});
