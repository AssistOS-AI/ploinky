import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveWorkspaceDirectory } from '../../core-services/webtty/cwd.mjs';
import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkIdentity.js';
import {
    inspectExactTerminalContainer,
    projectTerminalContainerInspect,
    TerminalTargetResolver,
    translateWorkspaceDirectoryToMount,
} from '../../cli/server/webtty/terminalTargetResolver.mjs';

const CONTAINER_ID = 'a'.repeat(64);
const WORKSPACE_HASH = 'c1d2e3f40506';
const CONTRACT_HASH = 'b'.repeat(64);
const CONTAINER_NAME = 'ploinky_demo_shared';
const INSTANCE_ID = 'instance-0001';
const ENABLE_GENERATION = 'generation-0001';

function fixture(t) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webtty-targets-'));
    const root = path.join(parent, 'workspace');
    fs.mkdirSync(path.join(root, 'projects', 'demo', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.ploinky', 'code', 'shared'), { recursive: true });
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    return { parent, root, selected: path.join(root, 'projects', 'demo') };
}

function agentRecord(overrides = {}) {
    return {
        type: 'agent',
        runtime: 'podman',
        containerId: CONTAINER_ID,
        instanceId: INSTANCE_ID,
        enableGeneration: ENABLE_GENERATION,
        repoName: 'demo',
        agentName: 'shared',
        ...overrides,
    };
}

function inspected(mounts, overrides = {}) {
    return {
        Id: CONTAINER_ID,
        Name: `/${CONTAINER_NAME}`,
        State: { Running: true, Status: 'running' },
        HostConfig: { Init: true, NetworkMode: 'none' },
        Config: {
            Env: ['SECRET_CANARY=must-not-survive-projection'],
            Cmd: ['must-not-survive'],
            Labels: {
                [NETWORK_LABELS.managed]: '1',
                [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
                [NETWORK_LABELS.workspace]: WORKSPACE_HASH,
                [NETWORK_LABELS.contract]: CONTRACT_HASH,
                [NETWORK_LABELS.instanceId]: INSTANCE_ID,
                [NETWORK_LABELS.enableGeneration]: ENABLE_GENERATION,
                'third.party.secret': 'must-not-survive',
            },
        },
        Mounts: mounts,
        ...overrides,
    };
}

function bind(source, destination, rw = true) {
    return { Type: 'bind', Source: source, Destination: destination, RW: rw, Name: '' };
}

function inspectedAgent(root, containerName, record) {
    const raw = inspected([bind(root, '/workspace', true)], {
        Id: record.containerId,
        Name: `/${containerName}`,
    });
    return {
        ...raw,
        Config: {
            ...raw.Config,
            Labels: {
                ...raw.Config.Labels,
                [NETWORK_LABELS.instanceId]: record.instanceId,
                [NETWORK_LABELS.enableGeneration]: record.enableGeneration,
            },
        },
    };
}

function routePlan(records, current = () => true) {
    const snapshot = { agents: records };
    const lease = { id: 'generation-1', activationId: 'activation-1', snapshot, isCurrent: current };
    return { host: 'router.localhost', snapshot, lease };
}

function resolver(root, inspectContainer, options = {}) {
    return new TerminalTargetResolver({
        directoryResolver: (requested) => resolveWorkspaceDirectory(requested, { workspaceRoot: root }),
        inspectContainer,
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH, canonical: root }),
        ...options,
    });
}

test('exact inspect uses only runtime plus immutable id and immediately redacts unrelated data', async () => {
    const calls = [];
    const raw = inspected([]);
    const result = await inspectExactTerminalContainer('podman', CONTAINER_ID, {
        execFileImpl: (command, args, options, callback) => {
            calls.push({ command, args, options });
            callback(null, JSON.stringify([raw]), 'ignored');
        },
    });
    assert.equal(result.id, CONTAINER_ID);
    assert.equal(calls[0].command, '/usr/bin/podman');
    assert.deepEqual(calls[0].args, ['container', 'inspect', CONTAINER_ID]);
    assert.equal(calls[0].options.cwd, '/tmp');
    assert.deepEqual(Object.keys(calls[0].options.env).sort(), [
        'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'USER',
    ]);
    assert.equal(calls[0].options.timeout, 2_000);
    assert.equal(calls[0].options.maxBuffer, 1024 * 1024);

    assert.deepEqual(Object.keys(result), ['id', 'name', 'running', 'state', 'labels', 'init', 'networkMode', 'user', 'mounts']);
    assert.equal(JSON.stringify(result).includes('SECRET_CANARY'), false);
    assert.equal(JSON.stringify(result).includes('third.party.secret'), false);
    assert.equal(Object.hasOwn(result.labels, 'third.party.secret'), false);
    assert.equal(result.networkMode, 'none');
});

test('exact inspect separates target-local parse/timeout failures from systemic provider invocation failure', async () => {
    for (const payload of [inspected([]), [], [inspected([]), inspected([])]]) {
        await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
            execFileImpl: (_command, _args, _options, callback) => {
                callback(null, JSON.stringify(payload), '');
            },
        }), { code: 'WEBTTY_TARGET_INSPECT_INVALID' });
    }
    await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
        execFileImpl: (_command, _args, _options, callback) => callback(null, '{not-json', ''),
    }), { code: 'WEBTTY_TARGET_INSPECT_INVALID' });
    await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
        execFileImpl: (_command, _args, _options, callback) => callback(new Error('timeout'), '', ''),
    }), { code: 'WEBTTY_TARGET_INSPECT_FAILED' });
    await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
        maxOutputBytes: 32,
        execFileImpl: (_command, _args, _options, callback) => callback(null, 'x'.repeat(33), ''),
    }), { code: 'WEBTTY_TARGET_INSPECT_OVERSIZED' });
    for (const stdout of ['', '[]\n']) {
        await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
            execFileImpl: (_command, _args, _options, callback) => callback(
                Object.assign(new Error('absent'), { code: 125 }), stdout,
                `no such container: ${CONTAINER_ID}`,
            ),
        }), { code: 'WEBTTY_TARGET_IDENTITY_STALE' });
    }
    await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
        execFileImpl: (_command, _args, _options, callback) => callback(
            Object.assign(new Error('ambiguous absence'), { code: 125 }), '[]\nuntrusted',
            `no such container: ${CONTAINER_ID}`,
        ),
    }), { code: 'WEBTTY_TARGET_INSPECT_FAILED' });
    for (const code of [1, 126]) {
        await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
            execFileImpl: (_command, _args, _options, callback) => callback(
                Object.assign(new Error('spoofed absence'), { code }), '', `no such container: ${CONTAINER_ID}`,
            ),
        }), { code: 'WEBTTY_TARGET_INSPECT_FAILED' });
    }
    await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
        execFileImpl: (_command, _args, _options, callback) => callback(
            Object.assign(new Error('engine failure'), { code: 125 }), '', 'runtime database not found',
        ),
    }), { code: 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE' });
    await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
        execFileImpl: (_command, _args, _options, callback) => callback(
            Object.assign(new Error('engine failure'), { code: 125 }), '',
            `Error: cannot connect to nested runtime: no such container ${CONTAINER_ID}`,
        ),
    }), { code: 'WEBTTY_TARGET_INSPECT_FAILED' });
    await assert.rejects(inspectExactTerminalContainer('podman', CONTAINER_ID, {
        execFileImpl: (_command, _args, _options, callback) => callback(
            Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), '', '',
        ),
    }), { code: 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE' });
});

test('a bind mounted at container root translates descendants with segment-safe containment', async (t) => {
    const { root, selected } = fixture(t);
    const mounts = projectTerminalContainerInspect(inspected([
        bind(root, '/', true),
    ])).mounts;
    const mapping = await translateWorkspaceDirectoryToMount(fs.realpathSync(selected), mounts);
    assert.equal(mapping.translatedCwd, '/projects/demo');
    assert.equal(mapping.access, 'rw');
});

test('mount translation chooses the longest source and exposes effective read-only access', async (t) => {
    const { root, selected } = fixture(t);
    const nestedSource = path.join(root, 'projects');
    const mounts = projectTerminalContainerInspect(inspected([
        bind(root, '/workspace', true),
        bind(nestedSource, '/project-data', false),
    ])).mounts;
    const mapping = await translateWorkspaceDirectoryToMount(fs.realpathSync(selected), mounts);
    assert.deepEqual(mapping, {
        translatedCwd: '/project-data/demo',
        access: 'ro',
        sourceRealPath: fs.realpathSync(nestedSource),
    });
});

test('ambiguous equal sources and destination shadows fail closed', async (t) => {
    const { root, selected } = fixture(t);
    const cases = [
        [
            bind(root, '/workspace-a', true),
            bind(root, '/workspace-b', true),
        ],
        [
            bind(root, '/workspace', true),
            { Type: 'volume', Source: 'named', Destination: '/workspace/projects', RW: true, Name: 'named' },
        ],
        [
            bind(root, '/workspace', true),
            bind(path.join(root, '.ploinky'), '/workspace/projects', true),
        ],
        [
            bind(root, '/workspace', true),
            { Type: 'bind', Source: root, Destination: '/bad', Name: '', RW: undefined },
        ],
    ];
    for (const rawMounts of cases) {
        const mounts = projectTerminalContainerInspect(inspected(rawMounts)).mounts;
        assert.equal(await translateWorkspaceDirectoryToMount(fs.realpathSync(selected), mounts), null);
    }
});

test('a staged /code bind cannot authorize the original repository selection', async (t) => {
    const { root, selected } = fixture(t);
    const staged = path.join(root, '.ploinky', 'code', 'shared');
    const mounts = projectTerminalContainerInspect(inspected([
        bind(staged, '/code', true),
    ])).mounts;
    assert.equal(await translateWorkspaceDirectoryToMount(fs.realpathSync(selected), mounts), null);
});

test('discovery returns Box first and only exact current-generation live mount proofs', async (t) => {
    const { root } = fixture(t);
    const calls = [];
    const inspectContainer = async (runtime, id) => {
        calls.push([runtime, id]);
        return inspected([bind(root, '/workspace', true)]);
    };
    const targetResolver = resolver(root, inspectContainer);
    const plan = routePlan({
        [CONTAINER_NAME]: agentRecord(),
        nested_docker: agentRecord({ runtime: 'docker', containerId: 'e'.repeat(64) }),
        host_runtime: agentRecord({ runtime: 'bwrap', containerId: 'c'.repeat(64) }),
        partial_id: agentRecord({ containerId: 'd'.repeat(63) }),
    });
    const result = await targetResolver.discover({
        routePlan: plan,
        requestedDirectory: 'projects/demo',
    });
    assert.equal(result.agentTargetsAvailable, true);
    assert.deepEqual(result.targets.map((target) => target.kind), ['box', 'agent']);
    assert.equal(result.targets[0].cwdDisplay, '/workspace/projects/demo');
    assert.equal(result.targets[1].translatedCwd, '/workspace/projects/demo');
    assert.equal(result.targets[1].access, 'rw');
    assert.deepEqual(calls, [['podman', CONTAINER_ID]]);
});

test('inspect, ownership, and mount failures omit only the failed agent', async (t) => {
    const { root } = fixture(t);
    const otherId = 'c'.repeat(64);
    const records = {
        [CONTAINER_NAME]: agentRecord(),
        ploinky_demo_broken: agentRecord({
            containerId: otherId,
            instanceId: 'instance-broken',
            enableGeneration: 'generation-broken',
            agentName: 'broken',
        }),
    };
    const targetResolver = resolver(root, async (_runtime, id) => {
        if (id === otherId) throw new Error('inspect output may contain a secret but must be omitted');
        return inspected([bind(path.join(root, 'elsewhere'), '/other', true)]);
    });
    const result = await targetResolver.discover({
        routePlan: routePlan(records),
        requestedDirectory: 'projects/demo',
    });
    assert.deepEqual(result.targets.map((target) => target.kind), ['box']);
});

test('a real adapter timeout omits only that agent and retains another proven target', async (t) => {
    const { root } = fixture(t);
    const slowId = 'c'.repeat(64);
    const slowName = 'ploinky_demo_slow';
    const records = {
        [CONTAINER_NAME]: agentRecord(),
        [slowName]: agentRecord({
            containerId: slowId,
            instanceId: 'instance-slow',
            enableGeneration: 'generation-slow',
            agentName: 'slow',
        }),
    };
    const targetResolver = resolver(root, (runtime, id, options) => inspectExactTerminalContainer(runtime, id, {
        ...options,
        execFileImpl: (_command, _args, _execOptions, callback) => {
            if (id === slowId) {
                callback(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true }), '', '');
                return;
            }
            callback(null, JSON.stringify([inspected([bind(root, '/workspace', true)])]), '');
        },
    }));
    const result = await targetResolver.discover({
        routePlan: routePlan(records),
        requestedDirectory: 'projects/demo',
    });
    assert.equal(result.agentTargetsAvailable, true);
    assert.deepEqual(result.targets.map((target) => target.kind), ['box', 'agent']);
    assert.equal(result.targets[1].containerId, CONTAINER_ID);
});

test('each exact identity, ownership, liveness, and top-level mount falsifier omits the agent', async (t) => {
    const { root } = fixture(t);
    const validMount = bind(root, '/workspace', true);
    const cases = [
        inspected([validMount], { Id: 'd'.repeat(64) }),
        inspected([validMount], { Name: '/wrong-name' }),
        inspected([validMount], { State: { Running: false, Status: 'exited' } }),
        inspected([validMount], { HostConfig: { Init: false, NetworkMode: 'none' } }),
        inspected([validMount], {
            Config: { ...inspected([]).Config, Labels: { ...inspected([]).Config.Labels, [NETWORK_LABELS.managed]: '0' } },
        }),
        inspected([validMount], {
            Config: { ...inspected([]).Config, Labels: { ...inspected([]).Config.Labels, [NETWORK_LABELS.instanceId]: 'wrong' } },
        }),
        inspected([validMount], {
            Config: { ...inspected([]).Config, Labels: { ...inspected([]).Config.Labels, [NETWORK_LABELS.enableGeneration]: 'wrong' } },
        }),
        inspected([validMount], {
            Config: { ...inspected([]).Config, User: 'a'.repeat(129) },
        }),
        inspected([{ Type: 'volume', Source: 'named', Destination: '/workspace', RW: true, Name: 'named' }]),
        inspected([{ Type: 'tmpfs', Source: '', Destination: '/workspace', RW: true, Name: '' }]),
        inspected([{ Type: 'bind', Source: path.join(root, 'not-a-directory'), Destination: '/workspace', RW: true, Name: '' }]),
    ];
    for (const raw of cases) {
        const targetResolver = resolver(root, async () => raw);
        const result = await targetResolver.discover({
            routePlan: routePlan({ [CONTAINER_NAME]: agentRecord() }),
            requestedDirectory: 'projects/demo',
        });
        assert.deepEqual(result.targets.map((target) => target.kind), ['box']);
        assert.equal(result.agentTargetsAvailable, true);
    }
});

test('create-time revalidation rejects a target whose configured user grows past the protocol bound', async (t) => {
    const { root } = fixture(t);
    const valid = inspected([bind(root, '/workspace', true)], {
        Config: { ...inspected([]).Config, User: '1000:1000' },
    });
    let inspections = 0;
    const targetResolver = resolver(root, async () => {
        inspections += 1;
        if (inspections === 1) return valid;
        return inspected([bind(root, '/workspace', true)], {
            Config: { ...inspected([]).Config, User: 'a'.repeat(129) },
        });
    });
    const plan = routePlan({ [CONTAINER_NAME]: agentRecord() });
    const discovery = await targetResolver.discover({
        routePlan: plan,
        requestedDirectory: 'projects/demo',
    });
    await assert.rejects(
        targetResolver.revalidate({ routePlan: plan, target: discovery.targets[1] }),
        (error) => error.code === 'WEBTTY_TARGET_STALE',
    );
});

test('systemic discovery inspection failure disables the agent provider surface and retains Box', async (t) => {
    const { root } = fixture(t);
    const targetResolver = resolver(root, async () => {
        const error = new Error('nested Podman unavailable');
        error.code = 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE';
        throw error;
    });
    const result = await targetResolver.discover({
        routePlan: routePlan({ [CONTAINER_NAME]: agentRecord() }),
        requestedDirectory: '',
    });
    assert.equal(result.agentTargetsAvailable, false);
    assert.deepEqual(result.targets.map((target) => target.kind), ['box']);
});

test('agent-provider unavailability never probes a runtime and retains Box', async (t) => {
    const { root } = fixture(t);
    let calls = 0;
    const targetResolver = resolver(root, async () => { calls += 1; return inspected([]); });
    const result = await targetResolver.discover({
        routePlan: routePlan({ [CONTAINER_NAME]: agentRecord() }),
        requestedDirectory: '',
        agentProviderAvailable: false,
    });
    assert.equal(result.agentTargetsAvailable, false);
    assert.deepEqual(result.targets.map((target) => target.kind), ['box']);
    assert.equal(calls, 0);
});

test('Box-only discovery still rejects a route generation replaced during directory resolution', async (t) => {
    const { root } = fixture(t);
    let checks = 0;
    const targetResolver = resolver(root, async () => { throw new Error('must not inspect'); });
    await assert.rejects(
        targetResolver.discover({
            routePlan: routePlan({}, () => {
                checks += 1;
                return checks === 1;
            }),
            requestedDirectory: '',
            agentProviderAvailable: false,
        }),
        (error) => error.code === 'WEBTTY_TARGET_GENERATION_STALE',
    );
});

test('exact inspection concurrency is capped at four', async (t) => {
    const { root } = fixture(t);
    const records = {};
    for (let index = 0; index < 12; index += 1) {
        const name = `ploinky_demo_agent_${index}`;
        records[name] = agentRecord({
            containerId: index.toString(16).padStart(64, '0'),
            instanceId: `instance-${index}`,
            enableGeneration: `generation-${index}`,
            agentName: `agent-${index}`,
        });
    }
    let active = 0;
    let maximum = 0;
    const targetResolver = resolver(root, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        throw new Error('deliberate omission');
    }, { limits: { concurrency: 99 } });
    const result = await targetResolver.discover({ routePlan: routePlan(records), requestedDirectory: '' });
    assert.equal(maximum, 4);
    assert.deepEqual(result.targets.map((target) => target.kind), ['box']);
});

test('concurrent discoveries share one exact-inspection cap and retain independent partial results', async (t) => {
    const { root } = fixture(t);
    const metadata = new Map();
    function record(index, agentName) {
        const containerId = index.toString(16).padStart(64, '0');
        const containerName = `ploinky_demo_${agentName.replaceAll('-', '_')}`;
        const value = agentRecord({
            containerId,
            instanceId: `instance-${index}`,
            enableGeneration: `generation-${index}`,
            agentName,
        });
        metadata.set(containerId, { containerName, record: value });
        return [containerName, value];
    }
    const slowId = (2).toString(16).padStart(64, '0');
    const recordsA = Object.fromEntries([
        record(1, 'a-fast'),
        record(2, 'z-slow'),
    ]);
    const recordsB = Object.fromEntries([
        record(3, 'b-one'),
        record(4, 'b-two'),
    ]);
    let active = 0;
    let maximum = 0;
    const targetResolver = resolver(root, async (_runtime, id, { signal }) => {
        active += 1;
        maximum = Math.max(maximum, active);
        try {
            if (id === slowId) {
                await new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                });
            } else {
                await new Promise((resolve) => setImmediate(resolve));
            }
            const candidate = metadata.get(id);
            return inspectedAgent(root, candidate.containerName, candidate.record);
        } finally {
            active -= 1;
        }
    }, { limits: { concurrency: 2, overallTimeoutMs: 100, inspectTimeoutMs: 100 } });

    const [first, second] = await Promise.all([
        targetResolver.discover({ routePlan: routePlan(recordsA), requestedDirectory: '' }),
        targetResolver.discover({ routePlan: routePlan(recordsB), requestedDirectory: '' }),
    ]);

    assert.equal(maximum, 2);
    assert.equal(first.agentTargetsAvailable, true);
    assert.deepEqual(first.targets.map((target) => target.agentName || target.kind), ['box', 'a-fast']);
    assert.equal(second.agentTargetsAvailable, true);
    assert.deepEqual(second.targets.map((target) => target.agentName || target.kind), ['box', 'b-one', 'b-two']);
});

test('discoveries and concurrent exact-target revalidations share the same four inspection slots', async (t) => {
    const { root } = fixture(t);
    const records = {};
    const metadata = new Map();
    for (let index = 1; index <= 8; index += 1) {
        const containerId = index.toString(16).padStart(64, '0');
        const containerName = `ploinky_demo_mixed_${index}`;
        const record = agentRecord({
            containerId,
            instanceId: `mixed-instance-${index}`,
            enableGeneration: `mixed-generation-${index}`,
            agentName: `mixed-${index}`,
        });
        records[containerName] = record;
        metadata.set(containerId, { containerName, record });
    }
    let active = 0;
    let maximum = 0;
    const targetResolver = resolver(root, async (_runtime, id) => {
        active += 1;
        maximum = Math.max(maximum, active);
        try {
            await new Promise((resolve) => setImmediate(resolve));
            const candidate = metadata.get(id);
            return inspectedAgent(root, candidate.containerName, candidate.record);
        } finally {
            active -= 1;
        }
    }, { limits: { concurrency: 4 } });
    const plan = routePlan(records);
    const seed = await targetResolver.discover({ routePlan: plan, requestedDirectory: '' });
    const offeredAgents = seed.targets.filter((target) => target.kind === 'agent');
    assert.equal(offeredAgents.length, 8);

    active = 0;
    maximum = 0;
    const [discovered, ...revalidated] = await Promise.all([
        targetResolver.discover({ routePlan: plan, requestedDirectory: '' }),
        ...offeredAgents.map((target) => targetResolver.revalidate({ routePlan: plan, target })),
    ]);

    assert.equal(maximum, 4);
    assert.equal(discovered.targets.filter((target) => target.kind === 'agent').length, 8);
    assert.equal(revalidated.length, 8);
    assert.ok(revalidated.every((target) => target.kind === 'agent'));
});

test('discovery budget retains completed agents while aborting a slow exact inspection', async (t) => {
    const { root } = fixture(t);
    const slowId = 'c'.repeat(64);
    const records = {
        [CONTAINER_NAME]: agentRecord({ agentName: 'fast' }),
        ploinky_demo_slow: agentRecord({
            containerId: slowId,
            instanceId: 'instance-slow',
            enableGeneration: 'generation-slow',
            agentName: 'slow',
        }),
    };
    const targetResolver = resolver(root, (_runtime, id, { signal }) => {
        if (id === CONTAINER_ID) return Promise.resolve(inspected([bind(root, '/workspace', true)]));
        return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
    }, { limits: { overallTimeoutMs: 20, inspectTimeoutMs: 20 } });
    const started = Date.now();
    const result = await targetResolver.discover({
        routePlan: routePlan(records),
        requestedDirectory: '',
    });
    assert.ok(Date.now() - started < 250);
    assert.equal(result.agentTargetsAvailable, true);
    assert.deepEqual(result.targets.map((target) => target.kind), ['box', 'agent']);
    assert.equal(result.targets[1].containerId, CONTAINER_ID);
});

test('generation replacement during discovery rejects the complete result', async (t) => {
    const { root } = fixture(t);
    let checks = 0;
    const plan = routePlan({ [CONTAINER_NAME]: agentRecord() }, () => {
        checks += 1;
        return checks === 1;
    });
    const targetResolver = resolver(root, async () => inspected([bind(root, '/workspace', true)]));
    await assert.rejects(
        targetResolver.discover({ routePlan: plan, requestedDirectory: '' }),
        (error) => error.code === 'WEBTTY_TARGET_GENERATION_STALE',
    );
});

test('create-time revalidation repeats membership, identity, directory, mount, and access checks', async (t) => {
    const { root } = fixture(t);
    let live = inspected([bind(root, '/workspace', true)]);
    const targetResolver = resolver(root, async () => live);
    const plan = routePlan({ [CONTAINER_NAME]: agentRecord() });
    const discovery = await targetResolver.discover({ routePlan: plan, requestedDirectory: 'projects/demo' });
    const offered = discovery.targets[1];
    const accepted = await targetResolver.revalidate({ routePlan: plan, target: offered });
    assert.equal(accepted.containerId, CONTAINER_ID);
    assert.equal(accepted.translatedCwd, '/workspace/projects/demo');

    live = inspected([bind(root, '/workspace', false)]);
    await assert.rejects(
        targetResolver.revalidate({ routePlan: plan, target: offered }),
        (error) => error.code === 'WEBTTY_TARGET_STALE',
    );

    plan.snapshot.agents[CONTAINER_NAME] = agentRecord({ enableGeneration: 'replacement-generation' });
    await assert.rejects(
        targetResolver.revalidate({ routePlan: plan, target: offered }),
        (error) => error.code === 'WEBTTY_TARGET_STALE',
    );
});

test('create-time directory identity rejects same-path replacement', async (t) => {
    const { root } = fixture(t);
    const targetResolver = resolver(root, async () => inspected([bind(root, '/workspace', true)]));
    const plan = routePlan({});
    const discovery = await targetResolver.discover({ routePlan: plan, requestedDirectory: 'projects/demo' });
    const selected = path.join(root, 'projects', 'demo');
    fs.rmSync(selected, { recursive: true });
    fs.mkdirSync(selected, { recursive: true });
    await assert.rejects(
        targetResolver.revalidate({ routePlan: plan, target: discovery.targets[0] }),
        (error) => error.code === 'WEBTTY_TARGET_STALE',
    );
});

test('create-time directory disappearance, file replacement, and symlink escape are target-stale', async (t) => {
    for (const [name, replace] of [
        ['missing', () => {}],
        ['file replacement', ({ selected }) => fs.writeFileSync(selected, 'not a directory')],
        ['symlink escape', ({ parent, selected }) => {
            const outside = path.join(parent, 'outside-workspace');
            fs.mkdirSync(outside);
            fs.symlinkSync(outside, selected, 'dir');
        }],
    ]) {
        await t.test(name, async (subtest) => {
            const context = fixture(subtest);
            const targetResolver = resolver(
                context.root,
                async () => inspected([bind(context.root, '/workspace', true)]),
            );
            const plan = routePlan({});
            const discovery = await targetResolver.discover({
                routePlan: plan,
                requestedDirectory: 'projects/demo',
            });
            fs.rmSync(context.selected, { recursive: true });
            replace(context);
            await assert.rejects(
                targetResolver.revalidate({ routePlan: plan, target: discovery.targets[0] }),
                (error) => error.code === 'WEBTTY_TARGET_STALE',
            );
        });
    }
});

test('create-time directory resolution preserves systemic provider failure classification', async (t) => {
    const { root } = fixture(t);
    let resolutions = 0;
    const targetResolver = resolver(root, async () => inspected([bind(root, '/workspace', true)]), {
        directoryResolver: (requested) => {
            resolutions += 1;
            if (resolutions > 1) {
                const error = new Error('provider unavailable');
                error.code = 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE';
                throw error;
            }
            return resolveWorkspaceDirectory(requested, { workspaceRoot: root });
        },
    });
    const plan = routePlan({});
    const discovery = await targetResolver.discover({ routePlan: plan, requestedDirectory: '' });
    await assert.rejects(
        targetResolver.revalidate({ routePlan: plan, target: discovery.targets[0] }),
        (error) => error.code === 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE',
    );
});
