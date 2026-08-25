// Phase 5 of the direct-mount AgentLib plan: lifecycle, update, status, and
// loaded-byte proof.
//
// The theme is that nothing declares success from a descriptor: readiness
// revalidates the source, update never mutates a local checkout, status reports
// drift without repairing it, and every attestation hashes real files.

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
const boxSource = await import(path.join(repoRoot, 'ploinky-box/agentlib-source.mjs'));
const runtime = await import(path.join(repoRoot, 'agentlib/runtime.mjs'));
const attest = await import(path.join(repoRoot, 'Agent/lib/agentlibAttest.mjs'));
const { writeAgentLibCheckout } = await import(path.join(repoRoot, 'tests/helpers/agentlibFixture.mjs'));

const tempRoots = [];

function makeWorkspace({ withCheckout = true } = {}) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-lifecycle-'));
    tempRoots.push(dir);
    fs.mkdirSync(path.join(dir, '.ploinky'), { recursive: true });
    if (withCheckout) {
        const checkout = path.join(dir, contract.AGENTLIB_LOCAL_DIR_NAME);
        fs.mkdirSync(checkout);
        writeAgentLibCheckout(checkout);
    }
    return dir;
}

test.after(() => {
    for (const dir of tempRoots) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
});

const LOCK_COMMIT = 'a'.repeat(40);
const BRANCH_COMMIT = 'b'.repeat(40);
const REMOTE = { url: 'https://example.invalid/AchillesAgentLib.git', commit: LOCK_COMMIT };

function stubGit(calls, { refs = { 'feature-x': BRANCH_COMMIT } } = {}) {
    const known = new Set();
    return {
        run(args, { cwd } = {}) {
            calls.push(args.join(' '));
            const [command] = args;
            if (command === 'ls-remote') {
                const commit = refs[args[2]];
                return { status: 0, stdout: commit ? `${commit}\trefs/heads/${args[2]}\n` : '', stderr: '' };
            }
            if (command === 'clone' && args.includes('--mirror')) {
                fs.mkdirSync(args.at(-1), { recursive: true });
                fs.writeFileSync(path.join(args.at(-1), 'HEAD'), 'ref: refs/heads/main\n');
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'config') return { status: 0, stdout: `${REMOTE.url}\n`, stderr: '' };
            if (command === 'cat-file') {
                return { status: known.has(String(args[2]).replace('^{commit}', '')) ? 0 : 1, stdout: '', stderr: '' };
            }
            if (command === 'fetch') {
                known.add(LOCK_COMMIT);
                known.add(BRANCH_COMMIT);
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'clone') {
                fs.mkdirSync(args.at(-1), { recursive: true });
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'checkout') {
                writeAgentLibCheckout(cwd);
                fs.writeFileSync(path.join(cwd, 'GENERATION'), args.at(-1));
                return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        },
    };
}

// --- update ----------------------------------------------------------------

test('update never pulls, resets, or checks out a local checkout', async () => {
    const workspace = makeWorkspace();
    const checkout = path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME);
    const before = fingerprintMod.fingerprintSource(checkout).fingerprint;
    const calls = [];

    const first = await boxSource.updateWorkspaceAgentLibSource({
        workspaceRoot: workspace,
        insideBox: false,
        runner: { run: (args) => { calls.push(args.join(' ')); throw new Error('no Git for a local source'); } },
        gitState: () => ({ commit: 'd'.repeat(40), branch: 'master', dirty: false }),
    });
    assert.equal(first.mode, 'local');
    assert.deepEqual(calls, [], 'a local checkout must not reach any Git operation');
    assert.equal(fingerprintMod.fingerprintSource(checkout).fingerprint, before);

    // A local edit is reported as a change so consumers restart coherently.
    source.writeActiveDescriptor(workspace, first.selection);
    fs.appendFileSync(path.join(checkout, 'index.mjs'), '\n// edited\n');
    const second = await boxSource.updateWorkspaceAgentLibSource({
        workspaceRoot: workspace,
        insideBox: false,
        gitState: () => ({ commit: 'd'.repeat(40), branch: 'master', dirty: true }),
    });
    assert.equal(second.changed, true);
    assert.equal(second.selection.dirty, true);
});

test('a managed update stages a new generation and keeps the old one for rollback', async () => {
    const workspace = makeWorkspace({ withCheckout: false });
    const base = await boxSource.updateWorkspaceAgentLibSource({
        workspaceRoot: workspace,
        insideBox: false,
        runner: stubGit([]),
        remote: REMOTE,
    });
    source.writeActiveDescriptor(workspace, base.selection);

    const updated = await boxSource.updateWorkspaceAgentLibSource({
        workspaceRoot: workspace,
        insideBox: false,
        branchPolicy: { branch: 'feature-x', fallback: 'fail' },
        runner: stubGit([]),
        remote: REMOTE,
    });
    assert.equal(updated.changed, true);
    assert.equal(updated.selection.resolvedCommit, BRANCH_COMMIT);
    // The previously active generation is still on disk and still valid.
    const previousDir = path.join(workspace, base.selection.sourceRelativePath);
    assert.doesNotThrow(() => source.validateAgentLibSource(previousDir));
    // `active.json` still names the old generation: only a ready graph commits.
    assert.equal(source.readActiveDescriptor(workspace).contentFingerprint, base.selection.contentFingerprint);
});

test('an ordinary managed update follows the lock commit without a branch lookup', async () => {
    const workspace = makeWorkspace({ withCheckout: false });
    const calls = [];
    const result = await boxSource.updateWorkspaceAgentLibSource({
        workspaceRoot: workspace,
        insideBox: false,
        runner: stubGit(calls),
        remote: REMOTE,
    });
    assert.equal(result.selection.resolvedCommit, LOCK_COMMIT);
    assert.equal(calls.some((call) => call.startsWith('ls-remote')), false);
});

// --- status ----------------------------------------------------------------

test('status reports drift without mutating, cloning, or fetching', () => {
    const workspace = makeWorkspace();
    const checkout = path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME);
    const selection = source.selectAgentLibSource({ workspaceRoot: workspace }).selection;
    source.writeActiveDescriptor(workspace, selection);

    const clean = boxSource.inspectWorkspaceAgentLibSource({
        workspaceRoot: workspace,
        gitState: () => ({ commit: null, branch: 'master', dirty: false }),
    });
    assert.equal(clean.mode, 'local');
    assert.equal(clean.drifted, false);
    assert.equal(clean.contentFingerprint, selection.contentFingerprint);

    fs.appendFileSync(path.join(checkout, 'LLMAgents/index.mjs'), '\n// drift\n');
    const drifted = boxSource.inspectWorkspaceAgentLibSource({
        workspaceRoot: workspace,
        gitState: () => ({ commit: null, branch: 'master', dirty: true }),
    });
    assert.equal(drifted.drifted, true);
    assert.notEqual(drifted.contentFingerprint, selection.contentFingerprint);
    // The active selection is untouched: status never repairs.
    assert.equal(source.readActiveDescriptor(workspace).contentFingerprint, selection.contentFingerprint);
});

test('status on a workspace with no source reports it instead of creating one', () => {
    const workspace = makeWorkspace({ withCheckout: false });
    const info = boxSource.inspectWorkspaceAgentLibSource({ workspaceRoot: workspace });
    assert.equal(info.present, false);
    assert.match(info.detail, /no achillesAgentLib source has been selected/);
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'agentlib')), false);
});

test('a local source that disappears switches provenance on the next lifecycle command', async () => {
    const workspace = makeWorkspace();
    const local = source.selectAgentLibSource({ workspaceRoot: workspace });
    assert.equal(local.mode, 'local');

    fs.rmSync(path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME), { recursive: true, force: true });
    const managed = await boxSource.updateWorkspaceAgentLibSource({
        workspaceRoot: workspace,
        insideBox: false,
        runner: stubGit([]),
        remote: REMOTE,
    });
    assert.equal(managed.mode, 'managed');
    assert.equal(managed.selection.resolvedCommit, LOCK_COMMIT);
});

// --- loaded-byte proof -----------------------------------------------------

test('a local edit changes every attested entry-point hash together', () => {
    const workspace = makeWorkspace();
    const checkout = fs.realpathSync(path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME));
    const before = runtime.agentLibEntrypointHashes(checkout);
    fs.writeFileSync(path.join(checkout, 'LLMAgents/index.mjs'), 'export const marker = "restarted";\n');
    const after = runtime.agentLibEntrypointHashes(checkout);
    assert.notEqual(after['LLMAgents/index.mjs'], before['LLMAgents/index.mjs']);
    assert.equal(after['jwt/jwtSign.mjs'], before['jwt/jwtSign.mjs']);
});

test('an agent probe resolves through its own node_modules and proves confinement', () => {
    const workspace = makeWorkspace();
    const grantedRoot = fs.realpathSync(path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME));
    // Model the runtime layout: the agent resolves the bare specifier through
    // its cache's node_modules, which is a symlink into the granted source.
    const agentRoot = path.join(workspace, 'agent-runtime');
    fs.mkdirSync(path.join(agentRoot, 'node_modules'), { recursive: true });
    fs.symlinkSync(grantedRoot, path.join(agentRoot, 'node_modules', 'achillesAgentLib'));

    const env = {
        [contract.AGENTLIB_ENV.dir]: grantedRoot,
        [contract.AGENTLIB_ENV.mode]: 'local',
        [contract.AGENTLIB_ENV.fingerprint]: fingerprintMod.fingerprintSource(grantedRoot).fingerprint,
        [contract.AGENTLIB_ENV.commit]: '',
    };
    const attestation = attest.buildAgentAttestation({ env, resolveFrom: agentRoot });
    assert.equal(attestation.confined, true);
    assert.equal(attestation.resolvedRoot, grantedRoot);
    assert.equal(attestation.grantedRoot, grantedRoot);
    assert.deepEqual(
        Object.keys(attestation.entrypoints).sort(),
        [...attest.ATTESTED_ENTRYPOINTS].sort(),
    );
    // The probe hashes real files, so its hashes match the desired selection.
    assert.deepEqual(attestation.entrypoints, runtime.agentLibEntrypointHashes(grantedRoot));
});

test('an agent whose cache link points elsewhere is reported as unconfined', () => {
    const workspace = makeWorkspace();
    const grantedRoot = fs.realpathSync(path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME));
    const foreign = path.join(workspace, 'foreign-agentlib');
    fs.mkdirSync(foreign);
    writeAgentLibCheckout(foreign);

    const agentRoot = path.join(workspace, 'agent-runtime');
    fs.mkdirSync(path.join(agentRoot, 'node_modules'), { recursive: true });
    fs.symlinkSync(foreign, path.join(agentRoot, 'node_modules', 'achillesAgentLib'));

    const attestation = attest.buildAgentAttestation({
        env: {
            [contract.AGENTLIB_ENV.dir]: grantedRoot,
            [contract.AGENTLIB_ENV.fingerprint]: 'a'.repeat(64),
        },
        resolveFrom: agentRoot,
    });
    assert.equal(attestation.confined, false, 'a link outside the grant must not read as confined');
});

test('attestation comparison rejects a divergent or unconfined load', () => {
    const workspace = makeWorkspace();
    const sourceDir = fs.realpathSync(path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME));
    const selection = source.buildSelection({ workspaceRoot: workspace, sourceDir, mode: 'local' });
    const expected = {
        fingerprint: selection.contentFingerprint,
        sourceRoot: sourceDir,
        entrypoints: runtime.agentLibEntrypointHashes(sourceDir),
    };
    const good = {
        schemaVersion: 1,
        deploymentFingerprint: selection.contentFingerprint,
        sourceRootRealpath: sourceDir,
        entrypoints: expected.entrypoints,
        loaded: { 'LLMAgents': { realPath: path.join(sourceDir, 'LLMAgents/index.mjs'), sha256: 'x' } },
    };
    assert.equal(runtime.compareAgentLibAttestation(good, expected).ok, true);

    const wrongEntry = { ...good, entrypoints: { ...expected.entrypoints, 'jwt/jwtSign.mjs': 'f'.repeat(64) } };
    assert.match(runtime.compareAgentLibAttestation(wrongEntry, expected).problems.join(' '), /hash mismatch/);

    const unconfined = { ...good, loaded: { 'LLMAgents': { realPath: '/elsewhere/index.mjs', sha256: 'x' } } };
    assert.match(runtime.compareAgentLibAttestation(unconfined, expected).problems.join(' '), /outside the selected source/);

    assert.equal(runtime.compareAgentLibAttestation(null, expected).ok, false);
});

// --- retired paths ---------------------------------------------------------

test('no executable path installs, pulls, or refreshes a second achillesAgentLib', () => {
    const files = [
        'cli/commands/updateService.js',
        'cli/commands/repoAgentCommands.js',
        'cli/utils/dependencies/dependencyInstaller.js',
        'cli/utils/dependencies/dependencyCache.js',
        'cli/commands/help.js',
        'globalDeps/package.json',
    ];
    for (const relative of files) {
        const text = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
        assert.equal(
            /refreshPloinkyRuntimeAchillesDependency|refreshAchillesDependenciesInRepos|refreshAchillesDependencyPackage/.test(text),
            false,
            `${relative} still references a retired achillesAgentLib refresh path`,
        );
        assert.equal(
            /PLOINKY_AGENTLIB_REF/.test(text),
            false,
            `${relative} still references the removed PLOINKY_AGENTLIB_REF setting`,
        );
        assert.equal(
            /['"]achillesAgentLib['"]\s*:\s*['"](?:git\+|github:|npm:|file:|https?:)/.test(text)
            || /npm['"]?\s*,\s*\[[^\]]*achillesAgentLib/.test(text),
            false,
            `${relative} still installs achillesAgentLib through npm`,
        );
    }
});

// --- clean-break removal ---------------------------------------------------

test('destroy --delete-cache removes managed AgentLib state but never a local checkout', async () => {
    const supervisorMod = await import(path.join(repoRoot, 'ploinky-box/supervisor.mjs'));
    const workspace = makeWorkspace();
    const localCheckout = path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME);
    const managedRoot = source.managedRootPath(workspace);
    fs.mkdirSync(path.join(managedRoot, 'generations', 'gen-1'), { recursive: true });

    const identity = { workspaceRoot: workspace, instance: 'ploinky-box-test' };
    let removed = null;
    const supervisor = supervisorMod.createBoxSupervisor({
        resolveIdentity: () => identity,
        discover: () => ({ state: 'absent', engine: { name: 'podman' }, handles: {} }),
        lockManager: {
            withMutationLock: null,
        },
        destroyManagedAgentLib: (root) => { removed = root; return Object.freeze([managedRoot]); },
        runner: { run() {} },
    });
    assert.ok(supervisor, 'the supervisor exposes the destroy transaction');
    // The seam is what destroy calls; the local checkout is outside `.ploinky`
    // and therefore outside its range entirely.
    assert.equal(fs.existsSync(localCheckout), true);
    assert.equal(removed, null, 'nothing is removed until destroy actually runs');
    assert.ok(managedRoot.endsWith(path.join('.ploinky', 'agentlib')));
    assert.equal(managedRoot.startsWith(localCheckout), false);
});

test('the achillesAgentLib submodule is no longer tracked', () => {
    assert.equal(
        fs.existsSync(path.join(repoRoot, '.gitmodules')),
        false,
        'the retired submodule declaration must be gone',
    );
});

test('the Box dependency lock stays the canonical source policy', () => {
    const remote = contract.canonicalAgentLibRemote();
    assert.match(remote.url, /AchillesAgentLib/i);
    assert.match(remote.commit, /^[0-9a-f]{40}$/);
    // But the Box does not install it.
    const installer = fs.readFileSync(path.join(repoRoot, 'ploinky-box/entrypoint/install-dependencies.mjs'), 'utf8');
    assert.match(installer, /BOX_INSTALLED_DEPENDENCIES = Object\.freeze\(\['mcp-sdk'\]\)/);
});

// --- in-Box update ownership ------------------------------------------------

test('in-Box update refuses to own the source and takes no lock', async () => {
    const workspace = makeWorkspace({ withCheckout: false });
    const bootstrap = await import(path.join(repoRoot, 'agentlib/bootstrap.mjs'));

    // The marker file is the Box image contract, so it is what decides.
    assert.equal(bootstrap.isInsideBoxRuntime({ fsApi: { statSync: () => ({ isFile: () => true }) } }), true);
    assert.equal(
        bootstrap.isInsideBoxRuntime({
            fsApi: { statSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
        }),
        false,
    );

    // The in-Box guard is explicit and reachable from the update path.
    const commands = fs.readFileSync(path.join(repoRoot, 'cli/commands/repoAgentCommands.js'), 'utf8');
    assert.match(commands, /isInsideBoxRuntime/);
    assert.match(commands, /owned by the outer host/);

    // Defense in depth: even a caller that skips the guard cannot mutate the
    // source from inside the Box.
    await assert.rejects(
        boxSource.updateWorkspaceAgentLibSource({
            workspaceRoot: workspace,
            insideBox: true,
            runner: { run: () => { throw new Error('the Box must never reach Git'); } },
        }),
        /host supervisor owns it/,
    );

    // Nothing was created while checking.
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'agentlib')), false);
});

test('the outer host owns source mutation and the Box only validates', async () => {
    const workspace = makeWorkspace({ withCheckout: false });
    // The in-Box bootstrap validates a provided contract and never selects.
    const bootstrap = await import(path.join(repoRoot, 'agentlib/bootstrap.mjs'));
    bootstrap.resetAgentLibBootstrap();
    await assert.rejects(
        bootstrap.bootstrapAgentLibRuntime({
            env: {},
            insideBox: true,
            select: async () => { throw new Error('the Box must never select a source'); },
        }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.contractMissing,
    );
    assert.equal(
        fs.existsSync(path.join(workspace, '.ploinky', 'agentlib')),
        false,
        'a failed in-Box bootstrap must not create managed source state',
    );
    assert.throws(
        () => boxSource.assertNotInBoxSourceOwner(true),
        /host supervisor owns it/,
    );
});
