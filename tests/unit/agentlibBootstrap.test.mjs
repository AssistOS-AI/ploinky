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

test('an existing host contract is inherited rather than re-selected', async () => {
    const workspace = makeWorkspace();
    const sourceDir = fs.realpathSync(path.join(workspace, 'achillesAgentLib'));
    const env = {
        [contract.AGENTLIB_ENV.dir]: sourceDir,
        [contract.AGENTLIB_ENV.mode]: 'local',
        [contract.AGENTLIB_ENV.fingerprint]: 'c'.repeat(64),
        [contract.AGENTLIB_ENV.commit]: '',
    };
    const result = await freshBootstrap()({
        env,
        cwd: workspace,
        insideBox: false,
        select: async () => { throw new Error('must not re-select'); },
    });
    assert.equal(result.sourceDir, sourceDir);
    assert.equal(result.owned, false);
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
        return { sourceDir: '/selected', mode: 'local', fingerprint: 'f', commit: '', owned: true };
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
            return { sourceDir: '/selected', mode: 'local', fingerprint: 'f', commit: '', owned: true };
        },
        importCoreImpl: async () => ({ runCoreCli: async (args) => { coreArgs = args; return 0; } }),
        env: {},
    });
    assert.equal(bootstrapped, null, 'an unparsable policy is treated as absent by bootstrap');
    assert.deepEqual(coreArgs, ['start', 'demo', '--branch-fallback', 'maybe']);
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
