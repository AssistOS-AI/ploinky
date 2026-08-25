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
const materialize = await import(path.join(repoRoot, 'agentlib/materialize.mjs'));
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

test('absent local candidate reports that materialization is required', () => {
    const workspace = makeWorkspace();
    const result = source.selectAgentLibSource({ workspaceRoot: workspace });
    assert.equal(result.requiresMaterialization, true);
    assert.equal(result.mode, 'managed');
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
    assert.equal(plan.mode, 'managed');
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

test('present but invalid local checkout is a hard error, never a managed fallback', () => {
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
    const selection = source.buildSelection({ workspaceRoot: workspace, sourceDir: dir, mode: 'local' });
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

// --- managed materialization ----------------------------------------------

/**
 * A Git stub that materializes the fixture tree instead of talking to a remote,
 * and records every invocation so "no network" can be asserted directly.
 */
function stubGit({ commits, calls }) {
    return {
        run(args, { cwd } = {}) {
            calls.push(args.join(' '));
            const [command] = args;
            if (command === 'ls-remote') {
                const ref = args[2];
                const commit = commits.refs?.[ref];
                return { status: 0, stdout: commit ? `${commit}\trefs/heads/${ref}\n` : '', stderr: '' };
            }
            if (command === 'clone' && args.includes('--mirror')) {
                fs.mkdirSync(args[args.length - 1], { recursive: true });
                fs.writeFileSync(path.join(args[args.length - 1], 'HEAD'), 'ref: refs/heads/main\n');
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'config') return { status: 0, stdout: `${commits.url}\n`, stderr: '' };
            if (command === 'cat-file') {
                const commit = String(args[2]).replace('^{commit}', '');
                return { status: commits.known.has(commit) ? 0 : 1, stdout: '', stderr: '' };
            }
            if (command === 'fetch') {
                for (const c of commits.fetchable) commits.known.add(c);
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'clone') {
                const target = args[args.length - 1];
                fs.mkdirSync(target, { recursive: true });
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'checkout') {
                writeAgentLibTree(cwd, { marker: args[args.length - 1].slice(0, 7) });
                return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        },
    };
}

const LOCK_COMMIT = 'a'.repeat(40);
const BRANCH_COMMIT = 'b'.repeat(40);
const REMOTE = { url: 'https://example.invalid/AchillesAgentLib.git', commit: LOCK_COMMIT };

function gitFixture(extra = {}) {
    return {
        url: REMOTE.url,
        refs: { 'feature-x': BRANCH_COMMIT },
        known: new Set(),
        fetchable: [LOCK_COMMIT, BRANCH_COMMIT],
        ...extra,
    };
}

test('managed first start materializes exactly one generation at the lock commit', () => {
    const workspace = makeWorkspace();
    const calls = [];
    const { selection, viaNetwork } = materialize.selectManagedSource({
        workspaceRoot: workspace,
        remote: REMOTE,
        runner: stubGit({ commits: gitFixture(), calls }),
    });
    assert.equal(selection.mode, 'managed');
    assert.equal(selection.resolvedCommit, LOCK_COMMIT);
    assert.equal(viaNetwork, false, 'the lock commit is immutable; no ref lookup is needed');
    assert.ok(selection.sourceRelativePath.startsWith('.ploinky/agentlib/generations/'));
    assert.equal(fs.readdirSync(source.managedGenerationsDir(workspace)).length, 1);
});

test('managed offline restart reuses the active generation without any Git call', () => {
    const workspace = makeWorkspace();
    const first = materialize.selectManagedSource({
        workspaceRoot: workspace,
        remote: REMOTE,
        runner: stubGit({ commits: gitFixture(), calls: [] }),
    });
    source.writeActiveDescriptor(workspace, first.selection);

    const calls = [];
    const second = materialize.selectManagedSource({
        workspaceRoot: workspace,
        activeDescriptor: source.readActiveDescriptor(workspace),
        remote: REMOTE,
        runner: stubGit({ commits: gitFixture(), calls }),
    });
    assert.equal(second.reused, true);
    assert.deepEqual(calls, [], 'reuse must not invoke Git at all');
    assert.equal(second.selection.contentFingerprint, first.selection.contentFingerprint);
});

test('an explicit branch stages a new immutable generation and keeps the old one', () => {
    const workspace = makeWorkspace();
    const base = materialize.selectManagedSource({
        workspaceRoot: workspace,
        remote: REMOTE,
        runner: stubGit({ commits: gitFixture(), calls: [] }),
    });
    const updated = materialize.selectManagedSource({
        workspaceRoot: workspace,
        activeDescriptor: base.selection,
        branchPolicy: { branch: 'feature-x', fallback: 'default' },
        remote: REMOTE,
        runner: stubGit({ commits: gitFixture(), calls: [] }),
    });
    assert.equal(updated.selection.resolvedCommit, BRANCH_COMMIT);
    assert.equal(updated.selection.requestedRef, 'feature-x');
    assert.equal(fs.readdirSync(source.managedGenerationsDir(workspace)).length, 2,
        'the previous generation stays available for rollback');
});

test('an absent branch honors --branch-fallback default and fail', () => {
    const workspace = makeWorkspace();
    const withDefault = materialize.selectManagedSource({
        workspaceRoot: workspace,
        branchPolicy: { branch: 'missing', fallback: 'default' },
        remote: REMOTE,
        runner: stubGit({ commits: gitFixture(), calls: [] }),
    });
    assert.equal(withDefault.selection.resolvedCommit, LOCK_COMMIT);

    assert.throws(
        () => materialize.selectManagedSource({
            workspaceRoot: makeWorkspace(),
            branchPolicy: { branch: 'missing', fallback: 'fail' },
            remote: REMOTE,
            runner: stubGit({ commits: gitFixture(), calls: [] }),
        }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.branchMissing,
    );
});

test('interrupted materialization leaves no generation and never touches active.json', () => {
    const workspace = makeWorkspace();
    const working = stubGit({ commits: gitFixture(), calls: [] });
    const failing = {
        run(args, opts) {
            if (args[0] === 'checkout') return { status: 1, stdout: '', stderr: 'simulated checkout failure' };
            return working.run(args, opts);
        },
    };
    assert.throws(
        () => materialize.selectManagedSource({ workspaceRoot: workspace, remote: REMOTE, runner: failing }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.materializeFailed,
    );
    assert.equal(source.readActiveDescriptor(workspace), null);
    assert.deepEqual(
        fs.readdirSync(source.managedGenerationsDir(workspace)),
        [],
        'the aborted staging directory must be cleaned up',
    );
});

test('pruning preserves every referenced generation', () => {
    const workspace = makeWorkspace();
    const first = materialize.selectManagedSource({
        workspaceRoot: workspace, remote: REMOTE, runner: stubGit({ commits: gitFixture(), calls: [] }),
    });
    const second = materialize.selectManagedSource({
        workspaceRoot: workspace,
        branchPolicy: { branch: 'feature-x', fallback: 'default' },
        remote: REMOTE,
        runner: stubGit({ commits: gitFixture(), calls: [] }),
    });
    const referenced = [path.join(workspace, first.selection.sourceRelativePath)];
    const prunable = materialize.prunableGenerations(workspace, referenced);
    assert.deepEqual(prunable, [path.join(workspace, second.selection.sourceRelativePath)]);
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

test('imports are attested with real paths and hashes, and compare against the selection', async () => {
    const workspace = makeWorkspace();
    const dir = fs.realpathSync(localCheckout(workspace, { marker: 'attested' }));
    const selection = source.buildSelection({ workspaceRoot: workspace, sourceDir: dir, mode: 'local' });
    const env = contract.agentLibRuntimeEnv(selection, dir);

    const namespace = await runtime.importAgentLib('LLMAgents', { env });
    assert.equal(namespace.marker, 'attested');

    const attestation = runtime.buildAgentLibAttestation({ env });
    assert.equal(attestation.sourceRootRealpath, dir);
    assert.equal(attestation.deploymentFingerprint, selection.contentFingerprint);

    const verdict = runtime.compareAgentLibAttestation(attestation, {
        fingerprint: selection.contentFingerprint,
        sourceRoot: dir,
        entrypoints: runtime.agentLibEntrypointHashes(dir),
    });
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.ok, true);

    const mismatch = runtime.compareAgentLibAttestation(attestation, {
        fingerprint: 'c'.repeat(64),
        sourceRoot: dir,
        entrypoints: {},
    });
    assert.equal(mismatch.ok, false);
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

test('the canonical remote comes from the Box dependency lock', () => {
    const remote = contract.canonicalAgentLibRemote();
    assert.match(remote.commit, /^[0-9a-f]{40}$/);
    assert.match(remote.url, /AchillesAgentLib/i);
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
    const readGitState = () => ({ commit: 'd'.repeat(40), dirty: true, branch: 'ploinky-proxy' });

    const matched = source.selectAgentLibSource({
        workspaceRoot: workspace,
        readGitState,
        branchPolicy: { branch: 'ploinky-proxy', fallback: 'fail' },
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
        source.assertLocalBranchPolicy(dir, { branch: 'ploinky-proxy' }, { branch: 'other', fallback: 'default' }).matched,
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
            branchPolicy: { branch: 'ploinky-proxy', fallback: 'fail' },
        }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.branchMissing,
    );
    assert.throws(
        () => source.selectAgentLibSource({
            workspaceRoot: workspace,
            readGitState: () => ({ commit: null, dirty: false, branch: null }),
            branchPolicy: { branch: 'ploinky-proxy', fallback: 'fail' },
        }),
        /detached or unknown revision/,
    );
});
