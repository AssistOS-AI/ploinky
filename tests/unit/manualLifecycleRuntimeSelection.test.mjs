import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    assertSelectedManualRuntime,
    probeSelectedManualRuntime,
    runCliWithDependencies,
} from '../../cli/commands/workspaceUtil.js';

const cliSource = fs.readFileSync(new URL('../../cli/commands/cli.js', import.meta.url), 'utf8');
const workspaceSource = fs.readFileSync(new URL('../../cli/commands/workspaceUtil.js', import.meta.url), 'utf8');

const exactIdentity = Object.freeze({
    instanceId: 'instance-selected',
    enableGeneration: 'generation-selected',
});

const cliArgs = (providerArgv = [], workdir = 'project') => [
    '--workdir', workdir, '--', ...providerArgv,
];

function runtimeRecord(runtime, overrides = {}) {
    const record = {
        type: 'agent',
        runtime,
        repoName: 'coding-agents',
        agentName: 'codingAgent',
        ...exactIdentity,
        ...overrides,
    };
    if (runtime === 'bwrap' && !record.bwrapOwner) {
        record.bwrapOwner = {
            role: 'service',
            runtimeKey: 'coding-agent-runtime-key',
            routeKey: 'codingAgent',
            rootPort: 15517,
            ...exactIdentity,
        };
    }
    if (runtime === 'podman' && record.containerId === undefined) {
        record.containerId = 'a'.repeat(64);
    }
    return record;
}

function cliHarness({
    selectedRuntime,
    recordedRuntime = selectedRuntime,
    omitRecordedRuntime = false,
    preparedOverrides = {},
    attachedOverrides = {},
    inputWorkdir = 'project',
    workdirResolution = Object.freeze({
        canonicalPath: '/workspace/project',
        runtimePath: '/workspace/project',
    }),
    manifestPath = '/fixtures/coding-agents/codingAgent/manifest.json',
    manifest = {
        cli: 'node /code/scripts/interactive-cli.mjs',
        'lite-sandbox': selectedRuntime === 'bwrap' || selectedRuntime === 'seatbelt',
        readiness: { protocol: 'none' },
    },
}) {
    const events = [];
    const record = runtimeRecord(recordedRuntime);
    if (omitRecordedRuntime) delete record.runtime;
    const preparedRecord = { ...record, ...preparedOverrides };
    const attachedRecord = { ...record, ...attachedOverrides };
    const registryRecord = {
        containerName: 'coding-agent-runtime-key',
        record,
    };
    const dependencies = {
        env: { PLOINKY_NO_TTY: '1' },
        resolveEnabledAgentRecord: () => registryRecord,
        findAgent: () => ({
            repo: 'coding-agents',
            manifestPath,
            shortAgentName: 'codingAgent',
        }),
        enableAgent: () => assert.fail('already-enabled agent must not be enabled again'),
        readManifest: () => manifest,
        admitRuntimeManifest: () => ({
            runtimeAdmission: Object.freeze({ test: 'runtime-admission' }),
            runtime: selectedRuntime,
            runtimeKind: selectedRuntime === 'bwrap' || selectedRuntime === 'seatbelt'
                ? selectedRuntime
                : 'container',
        }),
        resolveRouterEndpointForManifest: () => ({
            mode: selectedRuntime === 'bwrap' || selectedRuntime === 'seatbelt' ? 'host' : 'default',
            host: 'runtime-router',
            port: 49123,
            url: 'http://runtime-router:49123',
            env: {},
        }),
        ensureAgentService: () => {
            events.push(['ensure']);
            return {
                containerName: registryRecord.containerName,
                ...(preparedRecord.containerId ? { containerId: preparedRecord.containerId } : {}),
                hostPort: 15517,
                registryRecord: structuredClone(preparedRecord),
            };
        },
        resolveAgentReadinessProtocol: () => 'none',
        activateRuntimeAfterReadiness: async () => {
            events.push(['activate']);
        },
        withMaintenanceLock: async (_key, _options, callback) => callback(),
        withNetworkLifecycleLock: callback => callback(Object.freeze({ test: 'network-lifecycle' })),
        loadAgentsMap: () => ({
            [registryRecord.containerName]: structuredClone(attachedRecord),
        }),
        attachInteractive: (containerName, workdir, entryCommand, options) => {
            events.push(['container-attach', containerName, workdir, entryCommand, options]);
            return 31;
        },
        attachBwrapInteractive: (...callArgs) => {
            events.push(['bwrap-attach', ...callArgs]);
            return 32;
        },
        attachSeatbeltInteractive: () => {
            events.push(['seatbelt-attach']);
            return 33;
        },
        workspaceRoot: '/workspace',
        resolveWorkdir: (value, options) => {
            assert.equal(value, inputWorkdir);
            assert.deepEqual(options, { workspaceRoot: '/workspace' });
            return workdirResolution;
        },
    };
    return { dependencies, events };
}

test('selected sandbox lifecycle probes only its exact sandbox generation', () => {
    const calls = [];
    const record = runtimeRecord('bwrap');
    const running = probeSelectedManualRuntime('bwrap', 'coding-agent-runtime-key', record, {
        isSandboxRunning(runtimeKey, identity) {
            calls.push(['sandbox', runtimeKey, identity]);
            return true;
        },
        isContainerRunning() {
            calls.push(['container']);
            return true;
        },
    });

    assert.equal(running, true);
    assert.deepEqual(calls, [[
        'sandbox',
        'coding-agent-runtime-key',
        exactIdentity,
    ]]);
});

test('selected container lifecycle never probes a sandbox service', () => {
    const calls = [];
    const record = runtimeRecord('podman');
    const running = probeSelectedManualRuntime('podman', 'coding-agent-runtime-key', record, {
        isSandboxRunning() {
            calls.push(['sandbox']);
            return true;
        },
        isContainerRunning(runtimeKey, options) {
            calls.push(['container', runtimeKey, options]);
            return true;
        },
    });

    assert.equal(running, true);
    assert.deepEqual(calls, [[
        'container',
        record.containerId,
        { runtime: 'podman' },
    ]]);
});

test('manual lifecycle rejects a persisted runtime from the other selector generation', () => {
    assert.throws(
        () => assertSelectedManualRuntime('bwrap', runtimeRecord('podman'), {
            agentName: 'codingAgent',
            operation: 'restart',
        }),
        error => error?.code === 'PLOINKY_MANUAL_RUNTIME_MISMATCH'
            && /selected 'bwrap'.*recorded 'podman'.*mixed-runtime generations/i.test(error.message),
    );
    assert.throws(
        () => assertSelectedManualRuntime('podman', runtimeRecord('bwrap'), {
            agentName: 'codingAgent',
            operation: 'reinstall',
        }),
        error => error?.code === 'PLOINKY_MANUAL_RUNTIME_MISMATCH',
    );
});

test('selected Podman lifecycle rejects legacy, Docker, and non-exact registry labels', () => {
    for (const recordedRuntime of ['container', 'docker', ' podman ', 'Podman']) {
        assert.throws(
            () => assertSelectedManualRuntime('podman', runtimeRecord(recordedRuntime), {
                agentName: 'codingAgent',
                operation: 'restart',
            }),
            error => error?.code === 'PLOINKY_MANUAL_RUNTIME_MISMATCH'
                && error?.context?.selectedRuntime === 'podman'
                && error?.context?.recordedRuntime === recordedRuntime,
        );
    }
});

test('manual Podman lifecycle requires an exact generation identity', () => {
    for (const missingField of ['instanceId', 'enableGeneration']) {
        const record = runtimeRecord('podman');
        delete record[missingField];
        assert.throws(
            () => assertSelectedManualRuntime('podman', record, {
                agentName: 'codingAgent',
                operation: 'restart',
            }),
            error => error?.code === 'PLOINKY_MANUAL_RUNTIME_IDENTITY_MISSING',
        );
    }
    const missingContainerId = runtimeRecord('podman');
    delete missingContainerId.containerId;
    assert.throws(
        () => assertSelectedManualRuntime('podman', missingContainerId),
        error => error?.code === 'PLOINKY_MANUAL_RUNTIME_IDENTITY_MISSING',
    );
    for (const containerId of ['', 'a'.repeat(63), 'A'.repeat(64), ` ${'a'.repeat(64)}`]) {
        const record = runtimeRecord('podman', { containerId });
        assert.throws(
            () => assertSelectedManualRuntime('podman', record),
            error => error?.code === 'PLOINKY_MANUAL_RUNTIME_IDENTITY_MISSING',
        );
    }
    for (const [field, value] of [
        ['instanceId', ' instance-current '],
        ['enableGeneration', ' generation-current '],
    ]) {
        const record = runtimeRecord('podman', { [field]: value });
        assert.throws(
            () => assertSelectedManualRuntime('podman', record),
            error => error?.code === 'PLOINKY_MANUAL_RUNTIME_IDENTITY_MISSING',
        );
    }
});

test('manual sandbox lifecycle requires an exact generation identity before probing', () => {
    let probed = false;
    assert.throws(
        () => probeSelectedManualRuntime('bwrap', 'coding-agent-runtime-key', runtimeRecord('bwrap', {
            enableGeneration: '',
        }), {
            isSandboxRunning() {
                probed = true;
                return true;
            },
            isContainerRunning: () => assert.fail('sandbox selection must not inspect a container'),
        }),
        error => error?.code === 'PLOINKY_MANUAL_RUNTIME_IDENTITY_MISSING',
    );
    assert.equal(probed, false);
});

test('interactive CLI dispatches against the selected sandbox runtime', async () => {
    const harness = cliHarness({ selectedRuntime: 'bwrap' });
    const exitCode = await runCliWithDependencies('codingAgent', cliArgs([
        'two words', '--debug', '--sso-token=person token', "quote'arg",
    ]), harness.dependencies);

    assert.equal(exitCode, 32);
    assert.deepEqual(harness.events.map(([event]) => event), [
        'ensure',
        'activate',
        'bwrap-attach',
    ]);
    assert.equal(harness.events.at(-1)[4], '/workspace/project');
    assert.equal(
        harness.events.at(-1)[5],
        "node /code/scripts/interactive-cli.mjs --workdir '/workspace/project' -- 'two words' '--debug' '--sso-token=person token' 'quote'\\''arg'",
    );
});

test('interactive CLI rejects provider-capability manifest drift before service dispatch', async (t) => {
    const agentRoot = fs.mkdtempSync('/tmp/ploinky-provider-cli-drift-');
    t.after(() => fs.rmSync(agentRoot, { recursive: true, force: true }));
    const manifestPath = `${agentRoot}/manifest.json`;
    fs.writeFileSync(`${agentRoot}/mcp-config.json`, JSON.stringify({
        providerSandbox: { provider: 'opencode', readiness: true },
    }));
    const harness = cliHarness({
        selectedRuntime: 'bwrap',
        manifestPath,
        manifest: {
            cli: '/bin/sh -lc "printf provider-bypass"',
            'lite-sandbox': true,
            readiness: { protocol: 'none' },
        },
    });

    await assert.rejects(
        runCliWithDependencies('codingAgent', cliArgs(), harness.dependencies),
        (error) => error?.code === 'PLOINKY_PROVIDER_CLI_INVALID',
    );
    assert.deepEqual(harness.events, []);
});

test('interactive CLI rechecks provider capability after a canonical launch before dynamic drift', async (t) => {
    const agentRoot = fs.mkdtempSync('/tmp/ploinky-provider-cli-dynamic-drift-');
    t.after(() => fs.rmSync(agentRoot, { recursive: true, force: true }));
    const manifestPath = `${agentRoot}/manifest.json`;
    fs.writeFileSync(`${agentRoot}/mcp-config.json`, JSON.stringify({
        providerSandbox: { provider: 'codex', readiness: true },
    }));
    const manifest = {
        cli: 'node /code/scripts/interactive-cli.mjs',
        'lite-sandbox': true,
        readiness: { protocol: 'none' },
    };
    const harness = cliHarness({ selectedRuntime: 'bwrap', manifestPath, manifest });

    assert.equal(
        await runCliWithDependencies('codingAgent', cliArgs(), harness.dependencies),
        32,
    );
    const acceptedEventTypes = harness.events.map(([event]) => event);
    const acceptedEventCount = harness.events.length;
    manifest.cli = '/bin/sh -lc "printf provider-bypass"';
    await assert.rejects(
        runCliWithDependencies('codingAgent', cliArgs(), harness.dependencies),
        { code: 'PLOINKY_PROVIDER_CLI_INVALID' },
    );
    assert.equal(harness.events.length, acceptedEventCount);
    assert.deepEqual(harness.events.map(([event]) => event), acceptedEventTypes);
});

test('interactive CLI preserves an asynchronous signal-derived attach status exactly', async () => {
    const harness = cliHarness({ selectedRuntime: 'bwrap' });
    harness.dependencies.attachBwrapInteractive = async () => 143;

    assert.equal(
        await runCliWithDependencies('codingAgent', cliArgs(), harness.dependencies),
        143,
    );
});

test('interactive CLI transports only canonical workdir metadata to the provider adapter', async () => {
    for (const inputWorkdir of ['/workspace//project', './project', 'project/.', 'project//']) {
        const harness = cliHarness({ selectedRuntime: 'bwrap', inputWorkdir });
        const exitCode = await runCliWithDependencies(
            'codingAgent',
            cliArgs(['--model', 'x y'], inputWorkdir),
            harness.dependencies,
        );
        assert.equal(exitCode, 32);
        assert.equal(harness.events.at(-1)[4], '/workspace/project');
        assert.equal(
            harness.events.at(-1)[5],
            "node /code/scripts/interactive-cli.mjs --workdir '/workspace/project' -- '--model' 'x y'",
        );
    }
});

test('interactive CLI rejects an attach that loses its exact process status', async () => {
    const harness = cliHarness({ selectedRuntime: 'bwrap' });
    harness.dependencies.attachBwrapInteractive = async () => undefined;

    await assert.rejects(
        runCliWithDependencies('codingAgent', cliArgs(), harness.dependencies),
        error => error?.code === 'PLOINKY_INTERACTIVE_EXIT_STATUS_INVALID',
    );
});

test('interactive CLI rejects invalid grammar before resolving or starting an agent', async () => {
    const events = [];
    await assert.rejects(
        runCliWithDependencies('futureAgent', [], {
            env: {},
            resolveEnabledAgentRecord: () => events.push('resolve'),
        }),
        error => error?.code === 'PLOINKY_WORKDIR_REQUIRED',
    );
    assert.deepEqual(events, []);
});

test('interactive CLI rejects mixed sandbox/container registry state before service dispatch', async () => {
    const harness = cliHarness({ selectedRuntime: 'bwrap', recordedRuntime: 'podman' });
    await assert.rejects(
        runCliWithDependencies('codingAgent', cliArgs(), harness.dependencies),
        error => error?.code === 'PLOINKY_MANUAL_RUNTIME_MISMATCH',
    );
    assert.deepEqual(harness.events, []);
});

test('interactive CLI rejects a persisted record with no runtime before ensure', async () => {
    const harness = cliHarness({ selectedRuntime: 'podman', omitRecordedRuntime: true });
    await assert.rejects(
        runCliWithDependencies('codingAgent', cliArgs(), harness.dependencies),
        error => error?.code === 'PLOINKY_MANUAL_RUNTIME_MISMATCH'
            && error?.context?.recordedRuntime === '',
    );
    assert.deepEqual(harness.events, []);
});

test('interactive CLI and shell validate every persisted record before ensure', () => {
    const runCliStart = workspaceSource.indexOf('export async function runCliWithDependencies');
    const runCliEnd = workspaceSource.indexOf('\nasync function runCli(', runCliStart);
    const runCliSource = workspaceSource.slice(runCliStart, runCliEnd);
    const runShellStart = workspaceSource.indexOf('async function runShell(agentName)');
    const runShellEnd = workspaceSource.indexOf('\nasync function reinstallAgent(', runShellStart);
    const runShellSource = workspaceSource.slice(runShellStart, runShellEnd);

    for (const interactiveSource of [runCliSource, runShellSource]) {
        assert.match(interactiveSource, /if \(registryRecord\?\.record\) \{\s*assertSelectedManualRuntime\(/);
        assert.ok(
            interactiveSource.indexOf('assertSelectedManualRuntime(')
                < interactiveSource.indexOf('ensureAgentService('),
        );
    }
});

test('interactive CLI rejects a swapped Podman generation before attach', async () => {
    const harness = cliHarness({
        selectedRuntime: 'podman',
        attachedOverrides: { instanceId: 'instance-swapped' },
    });
    await assert.rejects(
        runCliWithDependencies('codingAgent', cliArgs(), harness.dependencies),
        error => error?.code === 'PLOINKY_MANUAL_RUNTIME_IDENTITY_MISMATCH',
    );
    assert.deepEqual(harness.events.map(([event]) => event), [
        'ensure',
        'activate',
    ]);
});

test('interactive CLI keeps false/missing selectors on the container attach path', async () => {
    const harness = cliHarness({ selectedRuntime: 'podman' });
    const exitCode = await runCliWithDependencies('codingAgent', cliArgs(), harness.dependencies);

    assert.equal(exitCode, 31);
    assert.deepEqual(harness.events.map(([event]) => event), [
        'ensure',
        'activate',
        'container-attach',
    ]);
    assert.deepEqual(harness.events.at(-1), [
        'container-attach',
        'coding-agent-runtime-key',
        '/workspace/project',
        "node /code/scripts/interactive-cli.mjs --workdir '/workspace/project' --",
        { runtime: 'podman', registryRecord: runtimeRecord('podman') },
    ]);
});

test('manual container attach and restart logging remain pinned to the selected Podman runtime', () => {
    const attachCalls = workspaceSource.match(
        /attachInteractive\(containerName, (?:selectedWorkdir|projPath), cmd, \{\s*runtime: selectedRuntime,\s*registryRecord: registryEntry,\s*\}\)/g,
    ) || [];
    assert.equal(attachCalls.length, 2);

    const containerRestartStart = cliSource.indexOf('// Recreate through the managed transaction');
    const workspaceRestartStart = cliSource.indexOf("} else {\n                const cfg", containerRestartStart);
    const containerRestart = cliSource.slice(containerRestartStart, workspaceRestartStart);
    assert.match(containerRestart, /Restarting \(\$\{agentRuntime\}\) agent/);
    assert.doesNotMatch(containerRestart, /Restarting \(\$\{getRuntime\(\)\}\) agent/);
});

test('manual restart and reinstall source use the selected-runtime probe without sandbox container checks', () => {
    const sandboxRestartStart = cliSource.indexOf('if (isSandboxRuntime(agentRuntime)) {');
    const containerRestartStart = cliSource.indexOf('// Recreate through the managed transaction', sandboxRestartStart);
    const sandboxRestart = cliSource.slice(sandboxRestartStart, containerRestartStart);
    const restartPrelude = cliSource.slice(
        cliSource.lastIndexOf('const agentRuntime =', sandboxRestartStart),
        sandboxRestartStart,
    );
    assert.ok(sandboxRestartStart >= 0 && containerRestartStart > sandboxRestartStart);
    assert.match(restartPrelude, /probeSelectedManualRuntime\(/);
    assert.doesNotMatch(sandboxRestart, /\b(?:isContainerRunning|containerExists)\(/);
    assert.match(cliSource, /containerExists\(containerName, \{ runtime: agentRuntime \}\)/);
    assert.match(workspaceSource, /isContainerRunning\(exactRecord\.containerId, \{ runtime: selectedRuntime \}\)/);

    const reinstallStart = workspaceSource.indexOf('async function reinstallAgent(agentName');
    const reinstallEnd = workspaceSource.indexOf('\nexport {', reinstallStart);
    const reinstall = workspaceSource.slice(reinstallStart, reinstallEnd);
    assert.match(reinstall, /probeSelectedManualRuntime\(/);
    assert.doesNotMatch(reinstall, /\bisContainerRunning\(/);
});

test('interactive dispatch contains no stale sandbox-to-container fallback contract', () => {
    assert.doesNotMatch(workspaceSource, /sandbox[\s\S]{0,80}fell back to container/i);
    const runCliStart = workspaceSource.indexOf('export async function runCliWithDependencies');
    const runCliEnd = workspaceSource.indexOf('\nasync function runCli(', runCliStart);
    const runCliSource = workspaceSource.slice(runCliStart, runCliEnd);
    assert.match(runCliSource, /if \(selectedRuntime === 'bwrap'\)/);
    assert.match(runCliSource, /else if \(selectedRuntime === 'seatbelt'\)/);
    assert.doesNotMatch(runCliSource, /actualRuntime/);
});
