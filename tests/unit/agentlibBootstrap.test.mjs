// Phase 3 of the direct-mount AgentLib plan: the launcher bootstrap and the
// explicit framework resolver.
//
// The point of these tests is that no executable path resolves achillesAgentLib
// through an install tree any more: either the runtime contract names the one
// selected source, or the attempt fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, '../..');

const contract = await import(path.join(repoRoot, 'agentlib/contract.mjs'));
const bootstrapMod = await import(path.join(repoRoot, 'agentlib/bootstrap.mjs'));
const runtime = await import(path.join(repoRoot, 'agentlib/runtime.mjs'));
const agentResolve = await import(path.join(repoRoot, 'Agent/lib/agentlibResolve.mjs'));
const { writeAgentLibCheckout } = await import(path.join(repoRoot, 'tests/helpers/agentlibFixture.mjs'));

const tempRoots = [];

function makeWorkspace({ withCheckout = true } = {}) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-boot-'));
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

function freshBootstrap() {
    bootstrapMod.resetAgentLibBootstrap();
    return bootstrapMod.bootstrapAgentLibRuntime;
}

// --- host bootstrap --------------------------------------------------------

test('a direct local checkout works with no installed achillesAgentLib', async () => {
    const workspace = makeWorkspace();
    const env = {};
    let selectorCalls = 0;
    const result = await freshBootstrap()({
        env,
        cwd: workspace,
        insideBox: false,
        select: async ({ workspaceRoot }) => {
            selectorCalls += 1;
            const { selectAgentLibSource } = await import(path.join(repoRoot, 'agentlib/source.mjs'));
            return selectAgentLibSource({ workspaceRoot });
        },
    });
    assert.equal(result.mode, 'local');
    assert.equal(result.owned, true);
    assert.equal(selectorCalls, 1);
    assert.equal(env[contract.AGENTLIB_ENV.dir], fs.realpathSync(path.join(workspace, 'achillesAgentLib')));
    assert.match(env[contract.AGENTLIB_ENV.fingerprint], /^[0-9a-f]{64}$/);
    assert.equal(env.PLOINKY_WORKSPACE_ROOT, workspace);

    // The framework resolver now reaches only the selected source.
    for (const entry of ['LLMAgents', 'utils/LLMClient.mjs', 'jwt/jwtSign.mjs', 'jwt/jwtVerify.mjs']) {
        const resolved = runtime.resolveAgentLibPath(entry, { env });
        assert.ok(resolved.startsWith(`${env[contract.AGENTLIB_ENV.dir]}${path.sep}`));
    }
});

test('bootstrap is idempotent and does not re-select', async () => {
    const workspace = makeWorkspace();
    let calls = 0;
    const boot = freshBootstrap();
    const select = async ({ workspaceRoot }) => {
        calls += 1;
        const { selectAgentLibSource } = await import(path.join(repoRoot, 'agentlib/source.mjs'));
        return selectAgentLibSource({ workspaceRoot });
    };
    const env = {};
    const first = await boot({ env, cwd: workspace, insideBox: false, select });
    const second = await boot({ env, cwd: workspace, insideBox: false, select });
    assert.equal(calls, 1);
    assert.equal(first, second);
});

test('an ambient host contract cannot bypass workspace selection', async () => {
    const workspace = makeWorkspace();
    const sourceDir = fs.realpathSync(path.join(workspace, 'achillesAgentLib'));
    const env = {
        [contract.AGENTLIB_ENV.dir]: '/ambient/wrong-agentlib',
        [contract.AGENTLIB_ENV.mode]: 'managed',
        [contract.AGENTLIB_ENV.fingerprint]: 'c'.repeat(64),
        [contract.AGENTLIB_ENV.commit]: '',
        [contract.AGENTLIB_ENV.sourceId]: 'd'.repeat(64),
    };
    let calls = 0;
    const result = await freshBootstrap()({
        env,
        cwd: workspace,
        insideBox: false,
        select: async ({ workspaceRoot }) => {
            calls += 1;
            const { selectAgentLibSource } = await import(path.join(repoRoot, 'agentlib/source.mjs'));
            return selectAgentLibSource({ workspaceRoot });
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.sourceDir, sourceDir);
    assert.equal(result.owned, true);
    assert.equal(env[contract.AGENTLIB_ENV.dir], sourceDir);
    assert.notEqual(env[contract.AGENTLIB_ENV.fingerprint], 'c'.repeat(64));
    assert.match(env[contract.AGENTLIB_ENV.sourceId], /^[a-f0-9]{64}$/);
});

// --- in-Box bootstrap ------------------------------------------------------

test('the in-Box launcher validates only and never selects', async () => {
    const workspace = makeWorkspace();
    const sourceDir = fs.realpathSync(path.join(workspace, 'achillesAgentLib'));

    await assert.rejects(
        freshBootstrap()({
            env: {},
            insideBox: true,
            select: async () => { throw new Error('the Box must never select a source'); },
        }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.contractMissing,
    );

    // Inside the Box the contract must name exactly the stable mount path.
    await assert.rejects(
        freshBootstrap()({
            env: { [contract.AGENTLIB_ENV.dir]: sourceDir, [contract.AGENTLIB_ENV.fingerprint]: 'c'.repeat(64) },
            insideBox: true,
        }),
        new RegExp(`must be ${contract.AGENTLIB_STABLE_MOUNT_PATH}`),
    );
});

test('the in-Box source owner guard is explicit', async () => {
    const { assertNotInBoxSourceOwner } = await import(path.join(repoRoot, 'ploinky-box/agentlib-source.mjs'));
    assert.doesNotThrow(() => assertNotInBoxSourceOwner(false));
    assert.throws(
        () => assertNotInBoxSourceOwner(true),
        /host supervisor owns it/,
    );
});

// --- read-only commands ----------------------------------------------------

test('read-only bootstrap reuses without creating workspace state', async () => {
    const workspace = makeWorkspace({ withCheckout: false });
    const { selectWorkspaceAgentLibSource } = await import(path.join(repoRoot, 'ploinky-box/agentlib-source.mjs'));
    await assert.rejects(
        selectWorkspaceAgentLibSource({
            workspaceRoot: workspace,
            readOnly: true,
            runner: { run: () => { throw new Error('read-only must not invoke Git'); } },
        }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.sourceMissing,
    );
    assert.equal(
        fs.existsSync(path.join(workspace, '.ploinky', 'agentlib')),
        false,
        'a read-only command must not create managed source state',
    );
});

test('help loads without any AgentLib runtime contract', async () => {
    const { launchCli } = await import(path.join(repoRoot, 'cli/index.js'));
    let helped = null;
    const code = await launchCli(['help'], {
        showHelpImpl: (args, options) => { helped = { args, options }; },
        bootstrapAgentLibImpl: () => { throw new Error('help must not bootstrap AgentLib'); },
        env: {},
    });
    assert.equal(code, 0);
    assert.deepEqual(helped, { args: [], options: { surface: 'core' } });
});

test('status bootstraps read-only and core commands bootstrap fully', async () => {
    const { launchCli } = await import(path.join(repoRoot, 'cli/index.js'));
    const bootstraps = [];
    const bootstrapAgentLibImpl = async (options) => {
        bootstraps.push({ readOnly: options.readOnly === true, branch: options.branchPolicy?.branch ?? null });
        return { sourceDir: '/selected', mode: 'local', fingerprint: 'f', commit: '', owned: false };
    };

    await launchCli(['status'], {
        bootstrapAgentLibImpl,
        statusWorkspaceImpl: async () => {},
        env: {},
    });
    assert.deepEqual(bootstraps, [{ readOnly: true, branch: null }]);

    bootstraps.length = 0;
    await launchCli(['start', 'demo', '--branch', 'ploinky-proxy'], {
        bootstrapAgentLibImpl,
        importCoreImpl: async () => ({ runCoreCli: async () => 0 }),
        env: {},
    });
    assert.deepEqual(bootstraps, [{ readOnly: false, branch: 'ploinky-proxy' }]);
});

test('a malformed branch policy does not pre-empt the command that owns the error', async () => {
    const { launchCli } = await import(path.join(repoRoot, 'cli/index.js'));
    let bootstrapped = null;
    let coreArgs = null;
    await launchCli(['start', 'demo', '--branch-fallback', 'maybe'], {
        bootstrapAgentLibImpl: async (options) => {
            bootstrapped = options.branchPolicy;
            return { sourceDir: '/selected', mode: 'local', fingerprint: 'f', commit: '', owned: false };
        },
        importCoreImpl: async () => ({ runCoreCli: async (args) => { coreArgs = args; return 0; } }),
        env: {},
    });
    assert.equal(bootstrapped, null, 'an unparsable policy is treated as absent by bootstrap');
    assert.deepEqual(coreArgs, ['start', 'demo', '--branch-fallback', 'maybe']);
});

test('direct start commits active.json only after graph attestation and source revalidation', async () => {
    const { launchCli } = await import(path.join(repoRoot, 'cli/index.js'));
    const { buildSelection } = await import(path.join(repoRoot, 'agentlib/source.mjs'));
    const workspace = makeWorkspace();
    const selection = buildSelection({
        workspaceRoot: workspace,
        sourceDir: path.join(workspace, 'achillesAgentLib'),
        mode: 'local',
    });
    const env = { PLOINKY_WORKSPACE_ROOT: workspace };
    const events = [];
    const result = await launchCli(['start', 'demo'], {
        env,
        bootstrapAgentLibImpl: async () => {
            Object.assign(env, contract.agentLibRuntimeEnv(selection, selection.sourceDir));
            return { owned: true, selection };
        },
        readActiveImpl: () => null,
        importCoreImpl: async () => ({
            runCoreCli: async (args, options) => {
                events.push(['core', args, options]);
                return 0;
            },
        }),
        attestDeploymentImpl: () => { events.push('attest'); return { ok: true }; },
        writeActiveImpl: (_workspaceRoot, active) => events.push(['commit', active]),
    });
    assert.equal(result, 0);
    assert.equal(events[0][0], 'core');
    assert.deepEqual(events[0][1], ['start', 'demo']);
    assert.equal(events[1], 'attest');
    assert.equal(events[2][0], 'commit');
    assert.equal(events[2][1], selection);
});

test('direct start tears down a failed admission and never commits the candidate', async () => {
    const { launchCli } = await import(path.join(repoRoot, 'cli/index.js'));
    const { buildSelection } = await import(path.join(repoRoot, 'agentlib/source.mjs'));
    const workspace = makeWorkspace();
    const selection = buildSelection({
        workspaceRoot: workspace,
        sourceDir: path.join(workspace, 'achillesAgentLib'),
        mode: 'local',
    });
    const env = { PLOINKY_WORKSPACE_ROOT: workspace };
    const coreCalls = [];
    let committed = false;
    await assert.rejects(
        launchCli(['start', 'demo'], {
            env,
            bootstrapAgentLibImpl: async () => {
                Object.assign(env, contract.agentLibRuntimeEnv(selection, selection.sourceDir));
                return { owned: true, selection };
            },
            readActiveImpl: () => null,
            importCoreImpl: async () => ({
                runCoreCli: async (args) => { coreCalls.push(args); return 0; },
            }),
            attestDeploymentImpl: () => { throw new Error('agent proof diverged'); },
            writeActiveImpl: () => { committed = true; },
        }),
        /agent proof diverged/,
    );
    assert.deepEqual(coreCalls, [['start', 'demo'], ['stop']]);
    assert.equal(committed, false);
});

test('direct update forwards branch policy to the source owner and activates in a fresh process', async () => {
    const { launchCli } = await import(path.join(repoRoot, 'cli/index.js'));
    const { buildSelection } = await import(path.join(repoRoot, 'agentlib/source.mjs'));
    const workspace = makeWorkspace();
    const current = buildSelection({
        workspaceRoot: workspace,
        sourceDir: path.join(workspace, 'achillesAgentLib'),
        mode: 'local',
    });
    const candidateDir = path.join(workspace, '.ploinky', 'agentlib', 'generations', 'candidate');
    writeAgentLibCheckout(candidateDir);
    const candidate = buildSelection({
        workspaceRoot: workspace,
        sourceDir: candidateDir,
        mode: 'managed',
        remoteUrl: 'https://example.invalid/achillesAgentLib.git',
        requestedRef: 'candidate',
        resolvedCommit: '1'.repeat(40),
    });
    const env = { PLOINKY_WORKSPACE_ROOT: workspace };
    let coreInvocation = null;
    let staged = null;
    let activation = null;
    await launchCli(['update', '--branch', 'candidate', '--branch-fallback', 'fail'], {
        env,
        bootstrapAgentLibImpl: async ({ branchPolicy }) => {
            assert.equal(branchPolicy.branch, 'candidate');
            Object.assign(env, contract.agentLibRuntimeEnv(current, current.sourceDir));
            return { owned: true, selection: current };
        },
        readActiveImpl: () => current,
        importCoreImpl: async () => ({
            runCoreCli: async (args, options) => {
                coreInvocation = { args, options };
                return { agentLib: { selection: candidate, previous: current } };
            },
        }),
        writeTransactionImpl: (_workspaceRoot, value) => { staged = value; },
        spawnActivationImpl: (command, args, options) => {
            activation = { command, args, options };
            return { status: 0 };
        },
    });
    assert.deepEqual(coreInvocation.args, ['update']);
    assert.deepEqual(coreInvocation.options.agentLibBranchPolicy, {
        branch: 'candidate', repoBranches: {}, fallback: 'fail', resetRepos: false,
    });
    assert.equal(staged, candidate);
    assert.equal(activation.command, process.execPath);
    assert.deepEqual(activation.args.slice(-2), ['--agentlib-activate-transaction', 'commit']);
    assert.equal(activation.options.env.PLOINKY_WORKSPACE_ROOT, workspace);
});

test('direct update activation failure stages and restarts the exact prior selection', async () => {
    const { launchCli } = await import(path.join(repoRoot, 'cli/index.js'));
    const { buildSelection } = await import(path.join(repoRoot, 'agentlib/source.mjs'));
    const workspace = makeWorkspace();
    const prior = buildSelection({
        workspaceRoot: workspace,
        sourceDir: path.join(workspace, 'achillesAgentLib'),
        mode: 'local',
    });
    const candidateDir = path.join(workspace, '.ploinky', 'agentlib', 'generations', 'candidate-failure');
    writeAgentLibCheckout(candidateDir);
    const candidate = buildSelection({
        workspaceRoot: workspace,
        sourceDir: candidateDir,
        mode: 'managed',
        remoteUrl: 'https://example.invalid/achillesAgentLib.git',
        resolvedCommit: '2'.repeat(40),
    });
    const env = { PLOINKY_WORKSPACE_ROOT: workspace };
    const staged = [];
    let spawnCalls = 0;
    await assert.rejects(
        launchCli(['update'], {
            env,
            bootstrapAgentLibImpl: async () => {
                Object.assign(env, contract.agentLibRuntimeEnv(prior, prior.sourceDir));
                return { owned: true, selection: prior };
            },
            readActiveImpl: () => prior,
            importCoreImpl: async () => ({
                runCoreCli: async () => ({ agentLib: { selection: candidate, previous: prior } }),
            }),
            writeTransactionImpl: (_workspaceRoot, value) => staged.push(value),
            spawnActivationImpl: () => ({ status: spawnCalls++ === 0 ? 23 : 0 }),
        }),
        /activation failed with status 23/,
    );
    assert.deepEqual(staged, [candidate, prior]);
    assert.equal(spawnCalls, 2);
});

// --- the standalone Agent tree --------------------------------------------

test('the Agent runtime resolver is self-contained and fails closed', () => {
    const workspace = makeWorkspace();
    const sourceDir = fs.realpathSync(path.join(workspace, 'achillesAgentLib'));
    const env = { [agentResolve.AGENTLIB_DIR_ENV]: sourceDir };

    assert.equal(
        agentResolve.resolveAgentLibFile('jwt/jwtSign.mjs', env),
        path.join(sourceDir, 'jwt/jwtSign.mjs'),
    );
    assert.throws(
        () => agentResolve.resolveAgentLibFile('jwt/jwtSign.mjs', {}),
        (error) => error.code === 'PLOINKY_AGENTLIB_CONTRACT_MISSING',
    );
    assert.throws(
        () => agentResolve.resolveAgentLibFile('../../etc/passwd', env),
        /escapes the source/,
    );

    const wrongPackage = path.join(workspace, 'not-agentlib');
    fs.mkdirSync(wrongPackage);
    writeAgentLibCheckout(wrongPackage);
    fs.writeFileSync(path.join(wrongPackage, 'package.json'), JSON.stringify({ name: 'other' }));
    assert.throws(
        () => agentResolve.resolveAgentLibFile('jwt/jwtSign.mjs', { [agentResolve.AGENTLIB_DIR_ENV]: wrongPackage }),
        /declares package name 'other'/,
    );
});

test('the Agent tree resolver imports nothing outside its own tree', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'Agent/lib/agentlibResolve.mjs'), 'utf8');
    const relativeImports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const specifier of relativeImports) {
        assert.equal(
            specifier.startsWith('..'),
            false,
            `Agent/lib/agentlibResolve.mjs must stay self-contained, but imports ${specifier}`,
        );
    }
});

// --- no install-tree fallback remains --------------------------------------

test('no executable framework path resolves achillesAgentLib as a bare package', () => {
    const files = [
        'cli/commands/cli.js',
        'cli/commands/llmSystemCommands.js',
        'cli/commands/llmProviderUtils.js',
        'cli/shell.js',
        'cli/main.js',
        'Agent/lib/jwtSign.mjs',
        'Agent/lib/jwtVerify.mjs',
        'Agent/server/AgentServer.mjs',
    ];
    for (const relative of files) {
        const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
        assert.equal(
            /(?:from|import|require\.resolve\()\s*['"]achillesAgentLib(?:\/|['"])/.test(source),
            false,
            `${relative} still resolves achillesAgentLib as a bare package`,
        );
        assert.equal(
            /node_modules['"]?\s*,\s*['"]achillesAgentLib/.test(source),
            false,
            `${relative} still points at an achillesAgentLib install tree`,
        );
    }
});

test('the removed PLOINKY_AGENTLIB_REF setting is rejected by the bootstrap', async () => {
    await assert.rejects(
        freshBootstrap()({ env: { PLOINKY_AGENTLIB_REF: 'some-branch' }, insideBox: false }),
        (error) => error.code === contract.AGENTLIB_ERROR_CODES.unsupportedSetting,
    );
});
