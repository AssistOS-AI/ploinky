// Phase 4 of the direct-mount AgentLib plan: the dependency-cache adapter and
// the per-runtime source grants.
//
// The cache never contains copied achillesAgentLib bytes. It contains one
// symlink into the selected source, created after every npm operation and
// verified before the cache is stamped.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, '../..');

const contract = await import(path.join(repoRoot, 'agentlib/contract.mjs'));
const link = await import(path.join(repoRoot, 'cli/utils/dependencies/agentLibLink.js'));
const grantMod = await import(path.join(repoRoot, 'cli/sandbox/agentLibGrant.js'));

const tempRoots = [];
const SOURCE_ID_HASH = 'd1'.repeat(32);

function tempDir(prefix = 'agentlib-cache-') {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    tempRoots.push(dir);
    return dir;
}

test.after(() => {
    for (const dir of tempRoots) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
});

const SELECTION = Object.freeze({
    sourceDir: '/workspace/achillesAgentLib',
    mode: 'local',
    fingerprint: 'a1'.repeat(32),
    commit: '',
    sourceIdHash: SOURCE_ID_HASH,
});

// --- link target per runtime family ---------------------------------------

test('container and bwrap link into the stable mount path; seatbelt links to the host source', () => {
    assert.equal(
        link.agentLibLinkTarget('container-linux-x64-node25', SELECTION),
        contract.AGENTLIB_STABLE_MOUNT_PATH,
    );
    assert.equal(
        link.agentLibLinkTarget('bwrap-linux-x64-node25', SELECTION),
        contract.AGENTLIB_STABLE_MOUNT_PATH,
    );
    // Seatbelt creates no mount namespace, so the stable path does not exist there.
    assert.equal(
        link.agentLibLinkTarget('seatbelt-darwin-arm64-node25', SELECTION),
        SELECTION.sourceDir,
    );
});

test('the stamp section separates a family whose link target differs', () => {
    const containerStamp = link.agentLibStampSection('container-linux-x64-node25', SELECTION);
    const seatbeltStamp = link.agentLibStampSection('seatbelt-darwin-arm64-node25', SELECTION);
    assert.notEqual(containerStamp.linkTarget, seatbeltStamp.linkTarget);
    // A cache prepared for one family cannot be silently adopted by the other.
    assert.match(
        link.agentLibStampProblem({ agentLib: containerStamp }, seatbeltStamp),
        /linkTarget changed/,
    );
    assert.equal(link.agentLibStampProblem({ agentLib: containerStamp }, containerStamp), '');
});

// --- link creation and npm pruning ----------------------------------------

test('an npm prune between install and stamp is repaired by the final link step', () => {
    const cachePath = tempDir();
    const target = contract.AGENTLIB_STABLE_MOUNT_PATH;
    fs.mkdirSync(path.join(cachePath, 'node_modules'), { recursive: true });

    link.ensureAgentLibCacheLink(cachePath, target);
    assert.equal(link.agentLibCacheLinkProblem(cachePath, target), '');

    // npm 11 treats an unlisted node_modules entry as extraneous and removes it.
    fs.rmSync(link.agentLibLinkPath(cachePath), { force: true });
    assert.match(link.agentLibCacheLinkProblem(cachePath, target), /missing/);

    // The post-npm repair step restores it, and it is verified before stamping.
    const repaired = link.ensureAgentLibCacheLink(cachePath, target);
    assert.equal(repaired.created, true);
    assert.equal(link.agentLibCacheLinkProblem(cachePath, target), '');
});

test('the link is repaired when it points at the wrong target and is idempotent otherwise', () => {
    const cachePath = tempDir();
    fs.mkdirSync(path.join(cachePath, 'node_modules'), { recursive: true });
    link.ensureAgentLibCacheLink(cachePath, '/opt/stale-agentlib');
    assert.match(link.agentLibCacheLinkProblem(cachePath, contract.AGENTLIB_STABLE_MOUNT_PATH), /points at/);

    link.ensureAgentLibCacheLink(cachePath, contract.AGENTLIB_STABLE_MOUNT_PATH);
    assert.equal(link.agentLibCacheLinkProblem(cachePath, contract.AGENTLIB_STABLE_MOUNT_PATH), '');
    assert.equal(
        link.ensureAgentLibCacheLink(cachePath, contract.AGENTLIB_STABLE_MOUNT_PATH).created,
        false,
    );
});

test('a copied achillesAgentLib directory is not accepted in place of the link', () => {
    const cachePath = tempDir();
    fs.mkdirSync(link.agentLibLinkPath(cachePath), { recursive: true });
    assert.match(
        link.agentLibCacheLinkProblem(cachePath, contract.AGENTLIB_STABLE_MOUNT_PATH),
        /is not a symlink; a copied package is not accepted/,
    );
});

// --- reserved dependency ---------------------------------------------------

test('an agent that declares achillesAgentLib is rejected before npm runs', () => {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        assert.throws(
            () => link.assertNoReservedAgentLibDependency({ [field]: { achillesAgentLib: 'git+https://evil' } }),
            (error) => error.code === contract.AGENTLIB_ERROR_CODES.reservedDependency,
            field,
        );
    }
    assert.doesNotThrow(() => link.assertNoReservedAgentLibDependency({ dependencies: { 'mcp-sdk': '*' } }));
});

test('the global dependency manifest no longer installs achillesAgentLib', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'globalDeps/package.json'), 'utf8'));
    assert.equal(Object.hasOwn(manifest.dependencies, 'achillesAgentLib'), false);
    assert.deepEqual(Object.keys(manifest.dependencies), ['mcp-sdk']);
});

test('merging an agent package rejects the reserved dependency', async () => {
    const installer = await import(path.join(repoRoot, 'cli/utils/dependencies/dependencyInstaller.js'));
    assert.throws(
        () => installer.mergePackageJson({ dependencies: {} }, { dependencies: { achillesAgentLib: 'file:../evil' } }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.reservedDependency,
    );
});

// --- runtime grants --------------------------------------------------------

test('the active selection comes from the validated runtime contract, not the cwd', () => {
    assert.throws(
        () => link.activeAgentLibSelection({}),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.contractMissing,
    );
    const env = {
        [contract.AGENTLIB_ENV.dir]: '/selected/achillesAgentLib',
        [contract.AGENTLIB_ENV.mode]: 'managed',
        [contract.AGENTLIB_ENV.fingerprint]: 'b2'.repeat(32),
        [contract.AGENTLIB_ENV.commit]: 'c'.repeat(40),
        [contract.AGENTLIB_ENV.sourceId]: SOURCE_ID_HASH,
    };
    assert.deepEqual(link.activeAgentLibSelection(env), {
        sourceDir: '/selected/achillesAgentLib',
        mode: 'managed',
        fingerprint: 'b2'.repeat(32),
        commit: 'c'.repeat(40),
        sourceIdHash: SOURCE_ID_HASH,
    });
});

test('a grant shadows every writable alias of the selected source', () => {
    const grant = grantMod.agentLibGrant('container-linux-x64-node25', {
        sourceDir: '/host/workspace/achillesAgentLib',
        mode: 'local',
        fingerprint: 'a1'.repeat(32),
        commit: '',
        sourceIdHash: SOURCE_ID_HASH,
    });
    assert.equal(grant.runtimePath, contract.AGENTLIB_STABLE_MOUNT_PATH);

    const shadows = grantMod.agentLibAliasShadows(grant, [
        { hostPath: '/host/workspace', runtimePath: '/workspace' },
        { hostPath: '/host/workspace', runtimePath: '/host/workspace' },
        { hostPath: '/host/other', runtimePath: '/other' },
    ]);
    assert.deepEqual(shadows.map((s) => s.runtimePath).sort(), [
        '/host/workspace/achillesAgentLib',
        '/workspace/achillesAgentLib',
    ]);
    for (const shadow of shadows) assert.equal(shadow.hostPath, grant.sourceDir);

    // A writable bind that does not expose the source needs no shadow.
    assert.deepEqual(grantMod.agentLibAliasShadows(grant, [{ hostPath: '/host/other', runtimePath: '/other' }]), []);
});

test('a seatbelt grant is not namespaced and needs no shadow bind', () => {
    const grant = grantMod.agentLibGrant('seatbelt-darwin-arm64-node25', {
        sourceDir: '/host/workspace/achillesAgentLib',
        mode: 'local',
        fingerprint: 'a1'.repeat(32),
        commit: '',
        sourceIdHash: SOURCE_ID_HASH,
    });
    assert.equal(grant.namespaced, false);
    assert.equal(grant.runtimePath, grant.sourceDir);
    // The host bind IS the runtime path, so it is not reported as a separate alias.
    assert.deepEqual(
        grantMod.agentLibAliasShadows(grant, [{ hostPath: '/host/workspace/achillesAgentLib', runtimePath: '/host/workspace/achillesAgentLib' }]),
        [],
    );
});

test('the grant environment names the runtime path, never the host path, for namespaced runtimes', () => {
    const grant = grantMod.agentLibGrant('container-linux-x64-node25', SELECTION);
    assert.deepEqual(grantMod.agentLibGrantEnv(grant), {
        [contract.AGENTLIB_ENV.dir]: contract.AGENTLIB_STABLE_MOUNT_PATH,
        [contract.AGENTLIB_ENV.mode]: 'local',
        [contract.AGENTLIB_ENV.fingerprint]: SELECTION.fingerprint,
        [contract.AGENTLIB_ENV.commit]: '',
        [contract.AGENTLIB_ENV.sourceId]: SOURCE_ID_HASH,
    });
});

test('runtime records retain only the generation identity needed for reuse', () => {
    const grant = grantMod.agentLibGrant('container-linux-x64-node25', SELECTION);
    assert.deepEqual(grantMod.agentLibRuntimeRecord(grant), {
        fingerprint: SELECTION.fingerprint,
        sourceIdHash: SOURCE_ID_HASH,
    });
});

test('the reserved AgentLib environment cannot be set by a manifest or profile layer', async () => {
    const identity = await import(path.join(repoRoot, 'cli/utils/security/agentIdentityEnv.js'));
    for (const name of contract.AGENTLIB_RESERVED_ENV_NAMES) {
        assert.ok(
            identity.RESERVED_AGENT_ENV_NAMES.includes(name),
            `${name} must be stripped from config-sourced agent env`,
        );
    }
    const env = { SAFE: 'yes', [contract.AGENTLIB_ENV.dir]: '/evil/agentlib' };
    identity.stripReservedAgentEnv(env);
    assert.equal(env[contract.AGENTLIB_ENV.dir], undefined);
    assert.equal(env.SAFE, 'yes');
});

// --- coherent replacement across runtime families ---------------------------

test('a stale fingerprint is not reusable in any runtime family', () => {
    // The AgentLib selection lives outside the manifest and profile, so the
    // config-derived env hash cannot see it. Every family must compare it.
    for (const runtimeKey of [
        'container-linux-x64-node25',
        'bwrap-linux-x64-node25',
        'seatbelt-darwin-arm64-node25',
    ]) {
        const grant = grantMod.agentLibGrant(runtimeKey, SELECTION);
        const running = { agentLib: grantMod.agentLibRuntimeRecord(grant) };
        assert.equal(grantMod.agentLibReuseProblem(running, grant), '', runtimeKey);

        // A local edit changes only the content fingerprint.
        const edited = grantMod.agentLibGrant(runtimeKey, { ...SELECTION, fingerprint: 'b2'.repeat(32) });
        assert.match(
            grantMod.agentLibReuseProblem(running, edited),
            /fingerprint changed/,
            `${runtimeKey} must replace a runtime running older AgentLib bytes`,
        );

        // A legacy full record remains reusable; only its generation identity
        // is significant.
        const legacy = { agentLib: { ...grant, aliasShadows: ['/workspace/achillesAgentLib'] } };
        assert.equal(grantMod.agentLibReuseProblem(legacy, grant), '');
        assert.match(
            grantMod.agentLibReuseProblem(
                running,
                grantMod.agentLibGrant(runtimeKey, { ...SELECTION, sourceIdHash: 'c3'.repeat(32) }),
            ),
            /sourceIdHash changed/,
        );
    }
});

test('a runtime with no recorded grant is never reused', () => {
    const grant = grantMod.agentLibGrant('container-linux-x64-node25', SELECTION);
    assert.match(grantMod.agentLibReuseProblem({}, grant), /record missing/);
    assert.match(grantMod.agentLibReuseProblem(undefined, grant), /record missing/);
});

test('every runtime manager consults the reuse comparison', async () => {
    const managers = [
        'cli/sandbox/docker/agentServiceManager.js',
        'cli/sandbox/bwrap/bwrapServiceManager.js',
        'cli/sandbox/seatbelt/seatbeltServiceManager.js',
    ];
    for (const relative of managers) {
        const text = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
        assert.match(
            text,
            /agentLibReuseProblem\(/,
            `${relative} must compare the AgentLib selection before reusing a runtime`,
        );
    }
});

test('the interactive container carries the same grant as the detached service', () => {
    const text = fs.readFileSync(path.join(repoRoot, 'cli/sandbox/docker/interactive.js'), 'utf8');
    assert.match(text, /grant\.sourceDir\}:\$\{grant\.runtimePath\}/);
    assert.match(text, /agentLibAliasShadows\(grant/);
    assert.match(text, /agentLibGrantEnv\(grant\)/);
});
