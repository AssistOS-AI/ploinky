// Phase 1 of the direct-mount AgentLib plan: the shared source contract.
//
// Every test here works on a throwaway workspace and injects the Git seam, so a
// selection can be produced, staged, revalidated, and rolled back without any
// runtime consuming it and without touching the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, '../..');

const contract = await import(path.join(repoRoot, 'agentlib/contract.mjs'));
const fingerprintMod = await import(path.join(repoRoot, 'agentlib/fingerprint.mjs'));
const source = await import(path.join(repoRoot, 'agentlib/source.mjs'));
const runtime = await import(path.join(repoRoot, 'agentlib/runtime.mjs'));
const branchPolicy = await import(path.join(repoRoot, 'agentlib/branchPolicy.mjs'));

process.env.PLOINKY_MASTER_KEY = process.env.PLOINKY_MASTER_KEY || '5'.repeat(64);
const repos = await import(path.join(repoRoot, 'cli/utils/repos.js'));

const tempRoots = [];

function makeWorkspace() {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-src-'));
    tempRoots.push(dir);
    fs.mkdirSync(path.join(dir, '.ploinky'), { recursive: true });
    return dir;
}

/** A minimal but structurally valid achillesAgentLib checkout. */
function writeAgentLibTree(dir, { name = contract.AGENTLIB_PACKAGE_NAME, marker = 'v1' } = {}) {
    fs.mkdirSync(path.join(dir, 'LLMAgents'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'utils'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'jwt'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name,
        version: '0.0.0',
        type: 'module',
        exports: {
            '.': './index.mjs',
            './LLMAgents': './LLMAgents/index.mjs',
            './utils/*': './utils/*',
            './jwt/*': './jwt/*',
        },
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'index.mjs'), `export const marker = ${JSON.stringify(marker)};\n`);
    fs.writeFileSync(path.join(dir, 'LLMAgents/index.mjs'), `export const marker = ${JSON.stringify(marker)};\n`);
    fs.writeFileSync(path.join(dir, 'LLMAgents/openAiAgenticResponder.mjs'),
        'export function isOptOutModel() { return false; }\nexport function runOpenAiAgenticResponse() { return {}; }\n');
    fs.writeFileSync(path.join(dir, 'utils/LLMClient.mjs'), 'export function getPrioritizedModels() { return []; }\n');
    fs.writeFileSync(path.join(dir, 'jwt/jwtSign.mjs'), 'export function signHmacJwt() { return ""; }\n');
    fs.writeFileSync(path.join(dir, 'jwt/jwtVerify.mjs'), 'export function verifyJws() { return null; }\n');
    return dir;
}

function localCheckout(workspace, opts) {
    const dir = source.localCandidatePath(workspace);
    fs.mkdirSync(dir, { recursive: true });
    return writeAgentLibTree(dir, opts);
}

test.after(() => {
    for (const dir of tempRoots) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
});

// --- selection ------------------------------------------------------------

test('local candidate wins without invoking any Git or network seam', () => {
    const workspace = makeWorkspace();
    localCheckout(workspace);
    const gitCalls = [];
    const result = source.selectAgentLibSource({
        workspaceRoot: workspace,
        readGitState: () => { gitCalls.push('git'); return { commit: null, dirty: false }; },
    });
    assert.equal(result.requiresMaterialization, false);
    assert.equal(result.selection.mode, 'local');
    assert.equal(result.selection.sourceRelativePath, contract.AGENTLIB_LOCAL_DIR_NAME);
    assert.match(result.selection.contentFingerprint, /^[0-9a-f]{64}$/);
    // readGitState is diagnostic context only; no clone/fetch seam is reachable.
    assert.deepEqual(gitCalls, ['git']);
});

test('absent local candidate requires the image-supplied library without host materialization', () => {
    const workspace = makeWorkspace();
    const result = source.selectAgentLibSource({ workspaceRoot: workspace });
    assert.equal(result.requiresMaterialization, false);
    assert.equal(result.requiresImageBundle, true);
    assert.equal(result.mode, 'image');
    assert.equal(result.selection, null);
});

test('only the exact workspace-root spelling is a candidate', () => {
    const workspace = makeWorkspace();
    // A nested copy and a sibling of the workspace must both be invisible: the
    // selector does not search ancestors and does not search recursively.
    const nested = path.join(workspace, 'vendor', contract.AGENTLIB_LOCAL_DIR_NAME);
    fs.mkdirSync(nested, { recursive: true });
    writeAgentLibTree(nested);
    const plan = source.planSourceSelection(workspace);
    assert.equal(plan.candidate, path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME));
    assert.equal(plan.present, false);
    assert.equal(plan.mode, 'image');
});

test('workspace root resolution stops at the nearest .ploinky ancestor', () => {
    const workspace = makeWorkspace();
    const nested = path.join(workspace, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(source.resolveWorkspaceRoot({ cwd: nested, env: {} }), fs.realpathSync(workspace));
});

test('explicit PLOINKY_WORKSPACE_ROOT wins over ancestor discovery', () => {
    const workspace = makeWorkspace();
    const other = makeWorkspace();
    assert.equal(
        source.resolveWorkspaceRoot({ cwd: workspace, env: { PLOINKY_WORKSPACE_ROOT: other } }),
        path.resolve(other),
    );
});

// --- fail-closed validation -----------------------------------------------

test('present but invalid local checkout is a hard error, never an image fallback', () => {
    const workspace = makeWorkspace();
    const dir = source.localCandidatePath(workspace);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'not-agentlib' }));
    assert.throws(
        () => source.selectAgentLibSource({ workspaceRoot: workspace }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.sourceInvalid,
    );
});

test('a symlinked source root is rejected', () => {
    const workspace = makeWorkspace();
    const real = writeAgentLibTree(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-real-')));
    tempRoots.push(real);
    fs.symlinkSync(real, source.localCandidatePath(workspace));
    assert.throws(
        () => source.selectAgentLibSource({ workspaceRoot: workspace }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.sourceInvalid,
    );
});

test('an internal symlink escaping the tree is rejected', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    fs.symlinkSync(os.tmpdir(), path.join(dir, 'escape'));
    assert.throws(
        () => source.validateAgentLibSource(dir),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.pathEscape,
    );
});

test('a missing required entry point is rejected', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    fs.rmSync(path.join(dir, 'jwt/jwtVerify.mjs'));
    assert.throws(
        () => source.validateAgentLibSource(dir),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.sourceInvalid,
    );
});

test('source substitution between stat and realpath is detected', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    const realFs = fs;
    let swapped = false;
    const fsApi = {
        ...realFs,
        lstatSync(target, ...rest) {
            const stat = realFs.lstatSync(target, ...rest);
            if (target === dir && !swapped) {
                swapped = true;
                return { ...stat, dev: stat.dev, ino: stat.ino + 1, isSymbolicLink: () => false, isDirectory: () => true };
            }
            return stat;
        },
    };
    assert.throws(
        () => source.validateAgentLibSource(dir, { fsApi }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.sourceChanged,
    );
});

// --- fingerprint ----------------------------------------------------------

test('fingerprint is deterministic and changes with content', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace, { marker: 'v1' });
    const first = fingerprintMod.fingerprintSource(dir).fingerprint;
    assert.equal(fingerprintMod.fingerprintSource(dir).fingerprint, first);
    fs.writeFileSync(path.join(dir, 'LLMAgents/index.mjs'), 'export const marker = "v2";\n');
    assert.notEqual(fingerprintMod.fingerprintSource(dir).fingerprint, first);
});

test('fingerprint ignores Git administration data', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    const before = fingerprintMod.fingerprintSource(dir).fingerprint;
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
    assert.equal(fingerprintMod.fingerprintSource(dir).fingerprint, before);
});

test('fingerprint fails retryably when the source identity changes', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    const wrongId = { device: '1', inode: '2' };
    assert.throws(
        () => fingerprintMod.fingerprintSource(dir, { expectedSourceId: wrongId }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.sourceChanged,
    );
});

test('drift detection compares content, not the commit', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    const { fingerprint } = fingerprintMod.fingerprintSource(dir);
    assert.equal(fingerprintMod.detectSourceDrift(dir, fingerprint).drifted, false);
    fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const marker = "edited";\n');
    assert.equal(fingerprintMod.detectSourceDrift(dir, fingerprint).drifted, true);
});

// --- descriptors ----------------------------------------------------------

test('descriptors round-trip and reject a foreign workspace', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    const selection = source.buildSelection({ workspaceRoot: workspace, sourceDir: dir });
    source.writeActiveDescriptor(workspace, selection);
    const read = source.readActiveDescriptor(workspace);
    assert.equal(read.contentFingerprint, selection.contentFingerprint);
    assert.equal(read.sourceDir, undefined, 'absolute paths must never be persisted');

    const resolved = source.resolveDescriptorSource(read, workspace);
    assert.equal(resolved.sourceDir, fs.realpathSync(dir));

    const foreign = makeWorkspace();
    assert.throws(
        () => source.resolveDescriptorSource(read, foreign),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.descriptorInvalid,
    );
});

test('a malformed descriptor is an error, not "no selection"', () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(source.managedRootPath(workspace), { recursive: true });
    fs.writeFileSync(source.activeDescriptorPath(workspace), '{ not json');
    assert.throws(
        () => source.readActiveDescriptor(workspace),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.descriptorInvalid,
    );
});

test('an absent descriptor reads as null', () => {
    assert.equal(source.readActiveDescriptor(makeWorkspace()), null);
});

test('descriptor schema validation rejects escaping relative paths and bad digests', () => {
    const base = {
        schemaVersion: 1,
        workspacePathHash: 'h',
        mode: 'local',
        sourceRelativePath: 'achillesAgentLib',
        sourceId: { device: '1', inode: '2' },
        remoteUrl: null,
        requestedRef: null,
        resolvedCommit: null,
        dirty: false,
        contentFingerprint: 'a'.repeat(64),
        selectedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.doesNotThrow(() => contract.validateSelectionDescriptor(base));
    assert.throws(() => contract.validateSelectionDescriptor({ ...base, sourceRelativePath: '../x' }));
    assert.throws(() => contract.validateSelectionDescriptor({ ...base, contentFingerprint: 'nope' }));
    assert.throws(() => contract.validateSelectionDescriptor({ ...base, mode: 'managed' }));
    assert.throws(() => contract.validateSelectionDescriptor({ ...base, schemaVersion: 2 }));
});

// --- source lock ----------------------------------------------------------

test('the source lock serializes writers and is released on failure', async () => {
    const workspace = makeWorkspace();
    const order = [];
    await source.withAgentLibSourceLock(workspace, () => { order.push('first'); });
    await assert.rejects(
        source.withAgentLibSourceLock(workspace, () => { throw new Error('boom'); }),
        /boom/,
    );
    await source.withAgentLibSourceLock(workspace, () => { order.push('third'); });
    assert.deepEqual(order, ['first', 'third']);
    assert.equal(fs.existsSync(path.join(source.managedRootPath(workspace), source.SOURCE_LOCK_FILENAME)), false);
});

test('the source lock times out rather than adopting a live holder', async () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(source.managedRootPath(workspace), { recursive: true });
    fs.writeFileSync(
        path.join(source.managedRootPath(workspace), source.SOURCE_LOCK_FILENAME),
        JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString() }),
    );
    await assert.rejects(
        source.withAgentLibSourceLock(workspace, () => 'never', { timeoutMs: 30, pollMs: 5 }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.lockFailed,
    );
});

// --- runtime resolution ---------------------------------------------------

test('runtime resolution requires the contract environment', () => {
    assert.throws(
        () => runtime.agentLibRoot({ env: {} }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.contractMissing,
    );
});

test('the removed PLOINKY_AGENTLIB_REF setting fails loudly', () => {
    assert.throws(
        () => contract.assertNoRemovedAgentLibSettings({ PLOINKY_AGENTLIB_REF: 'some-branch' }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.unsupportedSetting,
    );
});

test('fast endpoint checks resolve AgentLib through the selected-source runtime', () => {
    const harness = fs.readFileSync(
        path.join(repoRoot, 'tests', 'test-functions', 'openai_endpoints_tests.sh'),
        'utf8',
    );
    assert.match(harness, /agentlib\/runtime\.mjs/);
    assert.match(harness, /importAgentLib\('PloinkyAgentSkillsSubsystem\/AgentHttpClient\.mjs'\)/);
    assert.match(harness, /createAgentHttpClient\(\{[\s\S]*routerUrl:[\s\S]*env: \{\},[\s\S]*\}\)/);
    assert.doesNotMatch(harness, /PLOINKY_ROUTER_URL/);
    assert.doesNotMatch(harness, /PLOINKY_AGENT_LIB_DIR/);
    assert.doesNotMatch(harness, /node_modules\/achillesAgentLib/);
});

test('every framework subpath resolves inside the selected root', () => {
    const workspace = makeWorkspace();
    const dir = fs.realpathSync(localCheckout(workspace));
    for (const entry of ['LLMAgents', 'utils/LLMClient.mjs', 'jwt/jwtSign.mjs', 'jwt/jwtVerify.mjs']) {
        const resolved = runtime.resolveAgentLibPath(entry, { root: dir });
        assert.ok(resolved.startsWith(`${dir}${path.sep}`), `${entry} resolved outside the source`);
    }
});

test('a subpath escaping the selected root is refused', () => {
    const workspace = makeWorkspace();
    const dir = fs.realpathSync(localCheckout(workspace));
    assert.throws(
        () => runtime.resolveAgentLibPath('../../etc/passwd', { root: dir }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.pathEscape,
    );
});

test('imports resolve from the selected source', async () => {
    const workspace = makeWorkspace();
    const dir = fs.realpathSync(localCheckout(workspace, { marker: 'attested' }));
    const selection = source.buildSelection({ workspaceRoot: workspace, sourceDir: dir });
    const env = contract.agentLibRuntimeEnv(selection, dir);

    const namespace = await runtime.importAgentLib('LLMAgents', { env });
    assert.equal(namespace.marker, 'attested');

});

// --- shared policy --------------------------------------------------------

test('the branch policy parser is shared and validates its fallback', () => {
    assert.deepEqual(
        branchPolicy.parseBranchPolicy(['--branch', 'x', '--repo-branch', 'r=y', '--reset-repos']),
        { branch: 'x', repoBranches: { r: 'y' }, fallback: 'default', resetRepos: true },
    );
    assert.throws(() => branchPolicy.parseBranchPolicy(['--branch-fallback', 'maybe']), /Invalid --branch-fallback/);
    assert.equal(repos.parseBranchPolicy, branchPolicy.parseBranchPolicy, 'core must use the shared parser');
});

// --- workspace canonicalization -------------------------------------------

test('a workspace reached through a symlinked path still selects its own source', () => {
    const real = makeWorkspace();
    localCheckout(real);
    const linkParent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-link-'));
    tempRoots.push(linkParent);
    const aliased = path.join(linkParent, 'workspace-alias');
    fs.symlinkSync(real, aliased);

    const viaAlias = source.selectAgentLibSource({ workspaceRoot: aliased });
    const viaReal = source.selectAgentLibSource({ workspaceRoot: real });
    assert.equal(viaAlias.selection.sourceRelativePath, contract.AGENTLIB_LOCAL_DIR_NAME);
    assert.equal(
        viaAlias.selection.workspacePathHash,
        viaReal.selection.workspacePathHash,
        'one physical workspace must hash the same however it was reached',
    );

    // A descriptor written through one spelling must resolve through the other.
    source.writeActiveDescriptor(aliased, viaAlias.selection);
    assert.equal(
        source.resolveDescriptorSource(source.readActiveDescriptor(real), real).sourceDir,
        fs.realpathSync(source.localCandidatePath(real)),
    );
});

// --- explicit branch policy against a local checkout -----------------------

test('a requested branch is validated against a local checkout without modifying it', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    const before = fingerprintMod.fingerprintSource(dir).fingerprint;
    const readGitState = () => ({ commit: 'd'.repeat(40), dirty: true, branch: 'feature-agentlib' });

    const matched = source.selectAgentLibSource({
        workspaceRoot: workspace,
        readGitState,
        branchPolicy: { branch: 'feature-agentlib', fallback: 'fail' },
    });
    assert.equal(matched.selection.resolvedCommit, 'd'.repeat(40));
    assert.equal(matched.selection.dirty, true, 'a dirty local checkout is reported, not hidden');

    // A mismatch under `default` is reported but still selects the local source.
    const mismatched = source.selectAgentLibSource({
        workspaceRoot: workspace,
        readGitState,
        branchPolicy: { branch: 'other', fallback: 'default' },
    });
    assert.equal(mismatched.selection.mode, 'local');
    assert.equal(
        source.assertLocalBranchPolicy(dir, { branch: 'feature-agentlib' }, { branch: 'other', fallback: 'default' }).matched,
        false,
    );

    assert.equal(fingerprintMod.fingerprintSource(dir).fingerprint, before, 'the checkout must not be mutated');
});

test('a branch mismatch on a local checkout is fail-closed under --branch-fallback fail', () => {
    const workspace = makeWorkspace();
    localCheckout(workspace);
    assert.throws(
        () => source.selectAgentLibSource({
            workspaceRoot: workspace,
            readGitState: () => ({ commit: null, dirty: false, branch: 'master' }),
            branchPolicy: { branch: 'feature-agentlib', fallback: 'fail' },
        }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.branchMissing,
    );
    assert.throws(
        () => source.selectAgentLibSource({
            workspaceRoot: workspace,
            readGitState: () => ({ commit: null, dirty: false, branch: null }),
            branchPolicy: { branch: 'feature-agentlib', fallback: 'fail' },
        }),
        /detached or unknown revision/,
    );
});

// --- required entry points ------------------------------------------------------

test('a checkout without the responder module AgentServer imports is rejected', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    fs.rmSync(path.join(dir, 'LLMAgents/openAiAgenticResponder.mjs'));
    assert.throws(
        () => source.validateAgentLibSource(dir),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.sourceInvalid
            && /openAiAgenticResponder\.mjs/.test(error.message),
    );
});

// --- image-supplied selection ---------------------------------------------------

const OUTER_IMAGE = `sha256:${'b2'.repeat(32)}`;
const OTHER_OUTER_IMAGE = `sha256:${'d4'.repeat(32)}`;
const PROVENANCE = {
    repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git',
    branch: 'master',
    commit: 'e'.repeat(40),
    packageVersion: '1.2.3',
};

function imageDescriptor(overrides = {}) {
    return {
        schemaVersion: 1,
        workspacePathHash: 'h',
        mode: 'image',
        sourceRelativePath: 'image',
        sourceId: { library: contract.AGENTLIB_LIBRARY_NAME, supplyingImageId: OUTER_IMAGE },
        supplyingImageId: OUTER_IMAGE,
        selectedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

test('an image selection is identified by the supplying image and library, never by content', () => {
    const workspace = makeWorkspace();
    const selection = source.buildImageSelection({
        workspaceRoot: workspace, supplyingImageId: OUTER_IMAGE, provenance: PROVENANCE,
    });
    assert.equal(selection.mode, 'image');
    assert.equal(selection.sourceDir, contract.AGENTLIB_STABLE_MOUNT_PATH);
    assert.deepEqual(selection.sourceId, { library: 'achillesAgentLib', supplyingImageId: OUTER_IMAGE });
    assert.equal(selection.supplyingImageId, OUTER_IMAGE);
    for (const absent of ['contentFingerprint', 'resolvedCommit', 'remoteUrl', 'requestedRef', 'dirty', 'imageId']) {
        assert.equal(Object.hasOwn(selection, absent), false, `an image selection must not carry ${absent}`);
    }
    assert.deepEqual(selection.provenance, PROVENANCE);

    const env = contract.agentLibRuntimeEnv(selection, selection.sourceDir);
    assert.deepEqual(Object.keys(env).sort(), [
        contract.AGENTLIB_ENV.dir, contract.AGENTLIB_ENV.mode, contract.AGENTLIB_ENV.sourceId,
    ].sort(), 'the image environment carries no fingerprint and no commit');
    assert.equal(env[contract.AGENTLIB_ENV.mode], 'image');
    assert.equal(env[contract.AGENTLIB_ENV.sourceId], contract.imageSourceIdHash(selection.sourceId));
});

test('image identity follows the supplying image only; provenance never changes it', () => {
    const workspace = makeWorkspace();
    const withProvenance = source.buildImageSelection({
        workspaceRoot: workspace, supplyingImageId: OUTER_IMAGE, provenance: PROVENANCE,
    });
    const withoutProvenance = source.buildImageSelection({ workspaceRoot: workspace, supplyingImageId: OUTER_IMAGE });
    const otherProvenance = source.buildImageSelection({
        workspaceRoot: workspace, supplyingImageId: OUTER_IMAGE, provenance: { ...PROVENANCE, commit: 'f'.repeat(40) },
    });
    const otherImage = source.buildImageSelection({ workspaceRoot: workspace, supplyingImageId: OTHER_OUTER_IMAGE });
    assert.deepEqual(withoutProvenance.provenance, {
        repository: null, branch: null, commit: null, packageVersion: null,
    }, 'absent provenance reads as unavailable');
    assert.equal(contract.agentLibIdentityEquals(withProvenance, withoutProvenance), true);
    assert.equal(contract.agentLibIdentityEquals(withProvenance, otherProvenance), true);
    assert.equal(contract.agentLibIdentityEquals(withProvenance, otherImage), false);
    assert.notEqual(
        contract.agentLibRuntimeEnv(withProvenance, withProvenance.sourceDir)[contract.AGENTLIB_ENV.sourceId],
        contract.agentLibRuntimeEnv(otherImage, otherImage.sourceDir)[contract.AGENTLIB_ENV.sourceId],
    );
});

test('a mutable or noncanonical image reference is never a supplier identity', () => {
    const workspace = makeWorkspace();
    for (const bad of ['docker.io/assistos/ploinky-box:latest', 'b2'.repeat(32), `SHA256:${'b2'.repeat(32)}`, '', undefined]) {
        assert.throws(
            () => source.buildImageSelection({ workspaceRoot: workspace, supplyingImageId: bad }),
            (error) => error.code === contract.AGENTLIB_ERROR_CODES.imageInvalid,
            `${String(bad)} must be rejected`,
        );
    }
});

test('image descriptor validation rejects every shape this version does not write', () => {
    assert.doesNotThrow(() => contract.validateSelectionDescriptor(imageDescriptor()));
    const rejected = {
        'a content fingerprint': { contentFingerprint: 'a'.repeat(64) },
        'a device/inode source id': { sourceId: { device: '1', inode: '2' } },
        'a source id naming another image': {
            sourceId: { library: 'achillesAgentLib', supplyingImageId: OTHER_OUTER_IMAGE },
        },
        'a source id naming another library': { sourceId: { library: 'mcp-sdk', supplyingImageId: OUTER_IMAGE } },
        'a legacy imageId field': { imageId: OUTER_IMAGE },
        'a resolved commit as identity': { resolvedCommit: 'a'.repeat(40) },
        'a dirty flag': { dirty: true },
        'a workspace source path': { sourceRelativePath: 'achillesAgentLib' },
        'a non-canonical supplying image': { supplyingImageId: 'b2'.repeat(32) },
        'the removed managed mode': { mode: 'managed' },
        'a malformed provenance commit': { provenance: { commit: 'not-a-commit' } },
    };
    for (const [label, overrides] of Object.entries(rejected)) {
        assert.throws(
            () => contract.validateSelectionDescriptor(imageDescriptor(overrides)),
            (error) => error.code === contract.AGENTLIB_ERROR_CODES.descriptorInvalid,
            `${label} must be rejected`,
        );
    }
});

test('an image descriptor round-trips, and an unsupported one is reported with its file name', () => {
    const workspace = makeWorkspace();
    const selection = source.buildImageSelection({
        workspaceRoot: workspace, supplyingImageId: OUTER_IMAGE, provenance: PROVENANCE,
    });
    source.writeActiveDescriptor(workspace, selection);
    const read = source.readActiveDescriptor(workspace);
    assert.equal(read.mode, 'image');
    assert.equal(read.supplyingImageId, OUTER_IMAGE);
    assert.deepEqual(read.provenance, PROVENANCE);
    assert.equal(contract.agentLibIdentityEquals(read, selection), true);
    assert.equal(source.resolveDescriptorSource(read, workspace).sourceDir, contract.AGENTLIB_STABLE_MOUNT_PATH);

    for (const unsupported of [
        // The shape earlier versions wrote for an image selection.
        {
            ...imageDescriptor(), imageId: OUTER_IMAGE, contentFingerprint: 'a'.repeat(64), resolvedCommit: 'a'.repeat(40),
            sourceId: { device: `image:${OUTER_IMAGE}`, inode: 'a'.repeat(64) }, remoteUrl: null, requestedRef: null, dirty: false,
        },
        { ...imageDescriptor(), mode: 'managed', sourceRelativePath: '.ploinky/agentlib/generations/x' },
    ]) {
        fs.writeFileSync(source.activeDescriptorPath(workspace), JSON.stringify(unsupported));
        assert.throws(
            () => source.readActiveDescriptor(workspace),
            (error) => error.code === contract.AGENTLIB_ERROR_CODES.descriptorInvalid
                && error.message.includes(source.activeDescriptorPath(workspace)),
        );
        fs.writeFileSync(source.transactionDescriptorPath(workspace), JSON.stringify(unsupported));
        assert.throws(
            () => source.readTransactionDescriptor(workspace),
            (error) => error.code === contract.AGENTLIB_ERROR_CODES.descriptorInvalid
                && error.message.includes(source.transactionDescriptorPath(workspace)),
        );
    }
    assert.equal(fs.existsSync(source.activeDescriptorPath(workspace)), true, 'an unsupported descriptor is reported, not deleted');
});

test('a local descriptor keeps its shape and semantics unchanged', () => {
    const local = {
        schemaVersion: 1,
        workspacePathHash: 'h',
        mode: 'local',
        sourceRelativePath: 'achillesAgentLib',
        sourceId: { device: '1', inode: '2' },
        remoteUrl: null,
        requestedRef: null,
        resolvedCommit: 'a'.repeat(40),
        dirty: true,
        contentFingerprint: 'c'.repeat(64),
        selectedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.deepEqual(contract.validateSelectionDescriptor(local), local);
    const env = contract.agentLibRuntimeEnv({ ...local, sourceDir: '/x' }, '/opt/ploinky-agentlib');
    assert.equal(env[contract.AGENTLIB_ENV.fingerprint], local.contentFingerprint);
    assert.equal(env[contract.AGENTLIB_ENV.commit], local.resolvedCommit);
    assert.equal(env[contract.AGENTLIB_ENV.sourceId], contract.localSourceIdHash(local.sourceId));
});

test('local and image identities never compare equal', () => {
    const workspace = makeWorkspace();
    const dir = localCheckout(workspace);
    const local = source.buildSelection({ workspaceRoot: workspace, sourceDir: dir });
    const image = source.buildImageSelection({ workspaceRoot: workspace, supplyingImageId: OUTER_IMAGE });
    assert.equal(contract.agentLibIdentityEquals(local, image), false);
    assert.notEqual(contract.agentLibSourceIdHash(local), contract.agentLibSourceIdHash(image));
});
