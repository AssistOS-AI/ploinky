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
        [contract.AGENTLIB_ENV.mode]: 'local',
        [contract.AGENTLIB_ENV.fingerprint]: 'b2'.repeat(32),
        [contract.AGENTLIB_ENV.commit]: 'c'.repeat(40),
        [contract.AGENTLIB_ENV.sourceId]: SOURCE_ID_HASH,
    };
    assert.deepEqual(link.activeAgentLibSelection(env), {
        sourceDir: '/selected/achillesAgentLib',
        mode: 'local',
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

test('the interactive container carries the same grant as the detached service', async () => {
    const { buildInteractiveAgentCreateCommand } = await import(
        path.join(repoRoot, 'cli/sandbox/docker/interactive.js')
    );
    const workspaceRoot = tempDir('interactive-agentlib-grant-');
    const sourceDir = path.join(workspaceRoot, 'achillesAgentLib');
    const homeDir = path.join(workspaceRoot, '.data', 'demo');
    const sharedDir = path.join(workspaceRoot, '.data', 'shared');
    const agentLibPath = path.join(workspaceRoot, 'Agent');
    const absAgentPath = path.join(workspaceRoot, '.ploinky', 'repos', 'demo');
    for (const dir of [sourceDir, homeDir, sharedDir, agentLibPath, absAgentPath]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const grant = grantMod.agentLibGrant('container-linux-x64-node25', { ...SELECTION, sourceDir });
    for (const runtime of ['docker', 'podman']) {
        const suffix = runtime === 'podman' ? ':ro,z' : ':ro';
        const command = buildInteractiveAgentCreateCommand({
            runtime,
            containerName: 'interactive-grant-test',
            envHash: 'test-hash',
            workspaceRoot,
            projectDir: workspaceRoot,
            homeDir,
            sharedDir,
            agentLibPath,
            absAgentPath,
            agentLibGrant: grant,
            volumeSuffix: runtime === 'podman' ? ':z' : '',
            readOnlySuffix: suffix,
            containerImage: 'node:24',
        });
        const mounts = Array.from(command.matchAll(/-v "([^"]+)"/g), match => match[1]);
        assert.ok(mounts.includes(`${sourceDir}:${grant.runtimePath}${suffix}`),
            `${runtime} must grant the stable source read-only`);
        assert.ok(mounts.includes(`${sourceDir}:${sourceDir}${suffix}`),
            `${runtime} must shadow the otherwise-writable project alias`);
        for (const [name, value] of Object.entries(grantMod.agentLibGrantEnv(grant))) {
            assert.ok(command.includes(`-e ${name}="${value}"`),
                `${runtime} must carry the exact ${name} grant field`);
        }
    }
});

// --- image-supplied source ---------------------------------------------------

const OUTER_IMAGE = `sha256:${'b2'.repeat(32)}`;
const OTHER_OUTER_IMAGE = `sha256:${'d4'.repeat(32)}`;
const IMAGE_SOURCE_ID = contract.imageSourceIdHash(contract.imageSourceIdentity(OUTER_IMAGE));

function imageEnv(overrides = {}) {
    return {
        [contract.AGENTLIB_ENV.dir]: contract.AGENTLIB_STABLE_MOUNT_PATH,
        [contract.AGENTLIB_ENV.mode]: 'image',
        [contract.AGENTLIB_ENV.sourceId]: IMAGE_SOURCE_ID,
        [contract.BOX_IMAGE_ID_ENV]: OUTER_IMAGE,
        ...overrides,
    };
}

test('an image selection is read from the inherited Box image ID, with no fingerprint or commit', () => {
    assert.deepEqual(link.activeAgentLibSelection(imageEnv()), {
        sourceDir: contract.AGENTLIB_STABLE_MOUNT_PATH,
        mode: 'image',
        sourceIdHash: IMAGE_SOURCE_ID,
        supplyingImageId: OUTER_IMAGE,
    });
    for (const [label, env] of Object.entries({
        'a missing Box image ID': imageEnv({ [contract.BOX_IMAGE_ID_ENV]: undefined }),
        'a mutable image reference': imageEnv({ [contract.BOX_IMAGE_ID_ENV]: 'docker.io/assistos/ploinky-box:latest' }),
        'a bare hex ID': imageEnv({ [contract.BOX_IMAGE_ID_ENV]: 'b2'.repeat(32) }),
        'an identity for another image': imageEnv({ [contract.BOX_IMAGE_ID_ENV]: OTHER_OUTER_IMAGE }),
    })) {
        assert.throws(() => link.activeAgentLibSelection(env), undefined, `${label} must fail in a Box`);
    }
});

test('a local selection needs no Box image ID', () => {
    const selection = link.activeAgentLibSelection({
        [contract.AGENTLIB_ENV.dir]: '/selected/achillesAgentLib',
        [contract.AGENTLIB_ENV.mode]: 'local',
        [contract.AGENTLIB_ENV.fingerprint]: 'b2'.repeat(32),
        [contract.AGENTLIB_ENV.commit]: '',
        [contract.AGENTLIB_ENV.sourceId]: SOURCE_ID_HASH,
    });
    assert.equal(selection.mode, 'local');
    assert.equal(Object.hasOwn(selection, 'supplyingImageId'), false);
});

test('an image grant carries the supplying image, never a fingerprint, and never emits the Box image ID', () => {
    const selection = link.activeAgentLibSelection(imageEnv());
    for (const runtimeKey of ['container-linux-x64-node25', 'bwrap-linux-x64-node25']) {
        const grant = grantMod.agentLibGrant(runtimeKey, selection);
        assert.equal(grant.runtimePath, contract.AGENTLIB_STABLE_MOUNT_PATH);
        assert.equal(grant.supplyingImageId, OUTER_IMAGE);
        assert.equal(Object.hasOwn(grant, 'fingerprint'), false);
        assert.deepEqual(grantMod.agentLibGrantEnv(grant), {
            [contract.AGENTLIB_ENV.dir]: contract.AGENTLIB_STABLE_MOUNT_PATH,
            [contract.AGENTLIB_ENV.mode]: 'image',
            [contract.AGENTLIB_ENV.sourceId]: IMAGE_SOURCE_ID,
        });
        assert.equal(Object.hasOwn(grantMod.agentLibGrantEnv(grant), contract.BOX_IMAGE_ID_ENV), false,
            'no nested runtime consumes the outer image ID, so none receives it');
        assert.deepEqual(grantMod.agentLibRuntimeRecord(grant), {
            supplyingImageId: OUTER_IMAGE, sourceIdHash: IMAGE_SOURCE_ID,
        });
    }
    assert.throws(() => grantMod.agentLibGrant('container-linux-x64-node25', { ...selection, supplyingImageId: 'latest' }));
});

test('a runtime is reused only for the same supplying image and never across modes', () => {
    const image = grantMod.agentLibGrant('container-linux-x64-node25', link.activeAgentLibSelection(imageEnv()));
    const running = { agentLib: grantMod.agentLibRuntimeRecord(image) };
    assert.equal(grantMod.agentLibReuseProblem(running, image), '');

    const otherImage = grantMod.agentLibGrant('container-linux-x64-node25', link.activeAgentLibSelection(imageEnv({
        [contract.AGENTLIB_ENV.sourceId]: contract.imageSourceIdHash(contract.imageSourceIdentity(OTHER_OUTER_IMAGE)),
        [contract.BOX_IMAGE_ID_ENV]: OTHER_OUTER_IMAGE,
    })));
    assert.match(grantMod.agentLibReuseProblem(running, otherImage), /supplyingImageId changed/);

    const local = grantMod.agentLibGrant('container-linux-x64-node25', SELECTION);
    assert.match(grantMod.agentLibReuseProblem(running, local), /fingerprint changed/);
    const localRunning = { agentLib: grantMod.agentLibRuntimeRecord(local) };
    assert.match(grantMod.agentLibReuseProblem(localRunning, image), /supplyingImageId changed/);
    // A record of the shape earlier versions wrote for an image source matches nothing.
    assert.match(grantMod.agentLibReuseProblem({ agentLib: { fingerprint: 'a1'.repeat(32), sourceIdHash: IMAGE_SOURCE_ID } }, image),
        /supplyingImageId changed/);
});

test('the outer Box image ID is reserved so no config layer can introduce it, and it is never emitted to agents', async () => {
    const identity = await import(path.join(repoRoot, 'cli/utils/security/agentIdentityEnv.js'));
    assert.ok(identity.RESERVED_AGENT_ENV_NAMES.includes(contract.BOX_IMAGE_ID_ENV));
    const env = { SAFE: 'yes', [contract.BOX_IMAGE_ID_ENV]: OTHER_OUTER_IMAGE };
    identity.stripReservedAgentEnv(env);
    assert.equal(env[contract.BOX_IMAGE_ID_ENV], undefined);
    assert.equal(env.SAFE, 'yes');
    // Nothing that builds a nested runtime's environment emits the name.
    for (const relative of [
        'cli/sandbox/agentLibGrant.js', 'cli/sandbox/docker/agentServiceManager.js', 'cli/sandbox/docker/interactive.js',
        'cli/sandbox/bwrap/bwrapServiceManager.js', 'cli/sandbox/seatbelt/seatbeltServiceManager.js',
    ]) {
        const text = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
        assert.equal(/BOX_IMAGE_ID/.test(text.replace(/assertSupplyingImageId/g, '')), false,
            `${relative} must not reference the outer Box image ID`);
    }
});
