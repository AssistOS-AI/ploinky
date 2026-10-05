import test from 'node:test';
import assert from 'node:assert/strict';
import { installPureGuards, H } from './test_support_codex.mjs';
import { createMemoryFs } from './fake_fs_support_codex.mjs';
import { runBoxProbe, registryAgentNames, probeMain, inspectNestedContainers, validateProbeInput, readPublicConfig, PROBE_LIMITS, PROBE_SCHEMA } from './box_probe_codex.mjs';
import { READER_INSPECT_FORMAT } from './engine_codex.mjs';
installPureGuards();

const workspaceRoot = '/home/skutner/work/testExplorerFresh';
const generation = H('generation'), rows = [{ name: 'AssistOSExplorer/explorer', noWait: false }, { name: 'AssistOSExplorer/dpuAgent', noWait: true }];
const input = { requiredRuntimes: rows };
const failure = async (promise, code) => assert.rejects(promise, error => error.code === code);

function scenario(mutate = () => {}) {
    const state = { selector: { state: 'active', generation, activationId: 'act-1', publicationState: 'ready' }, registry: {}, running: {}, readiness: {}, calls: [], selectorReads: 0,
        stat: { isFile: () => true, isSymbolicLink: () => false, size: 1000, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4 } };
    for (const [index, row] of rows.entries()) { const [repoName, agentName] = row.name.split('/'), containerName = `ploinky_${agentName}`, containerId = H(`c${index}`);
        state.registry[containerName] = { type: 'agent', repoName, agentName, runtime: 'podman', containerId, instanceId: `inst-${index}`, enableGeneration: `en-${index}` };
        state.running[containerId] = true; state.readiness[containerName] = row.noWait ? { ready: true, noWaitState: 'running' } : {}; }
    mutate(state);
    const apis = {
        readEdgeRoutingSelection: options => { state.calls.push(['selection', options]); state.selectorReads += 1; return { selector: state.selectorAfterFirst && state.selectorReads > 1 ? state.selectorAfterFirst : state.selector, paths: { generationsDir: '/g' } }; },
        loadActiveEdgeRoutingGeneration: options => { state.calls.push(['load', options]); if (state.loadError) { const error = new Error('PRIVATE'); error.code = state.loadError; throw error; }
            return { selector: state.loadSelector ?? state.selector, generation: { agents: Object.fromEntries(Object.entries(state.registry).map(([name, record]) => [name, { type: 'agent', repoName: record.repoName, agentName: record.agentName, instanceId: state.capturedInstance?.[name] ?? record.instanceId, enableGeneration: record.enableGeneration }])) } }; },
        readAgentRegistrySnapshot: options => { state.calls.push(['registry', options]); state.registryReads = (state.registryReads ?? 0) + 1; return state.registryAfter && state.registryReads > 1 ? state.registryAfter : state.registry; },
        collectAgentRuntimeStates: options => { state.calls.push(['collect', options]); return options.liveContainers.map(entry => ({ containerName: entry.containerName, state: { running: entry.state.running, status: entry.state.status } })); },
        applyRuntimeReadinessProjection: (entries, registry) => { state.calls.push(['readiness', registry]); return entries.map(entry => ({ ...entry, state: { ...entry.state, ...(state.readiness[entry.containerName] ?? {}) } })); },
    };
    const memory = createMemoryFs({ [`${workspaceRoot}/.ploinky/routing.json`]: state.routing ?? JSON.stringify({ static: { agent: 'explorer', port: '8080' }, secret: 'PRIVATE' }) });
    const io = { ...memory, lstatSync: file => { if (!file.startsWith('/g/')) return memory.lstatSync(file); state.stats = (state.stats ?? 0) + 1; return state.statSequence ? state.statSequence(state.stats) : state.stat; } };
    const inspect = ids => { state.calls.push(['inspect', ids]); if (state.inspectError) throw Object.assign(new Error('PRIVATE'), { code: 'probe-container-inspect' });
        return new Map(ids.map(id => { const [containerName, record] = Object.entries(state.registry).find(([, item]) => item.containerId === id);
            return [id, { id, name: state.nameOverride?.[containerName] ?? containerName, running: state.running[id], imageId: H('image'), instanceId: state.labelOverride?.[containerName] ?? record.instanceId, enableGeneration: record.enableGeneration, mounts: [] }]; })); };
    return { state, run: () => runBoxProbe(input, { workspaceRoot, apis, io, inspect }), apis, io, inspect };
}

test('probe projects only public nonsecret membership using read-only product readers and supplied exact rows', async () => {
    const s = scenario(); const result = await s.run();
    assert.deepEqual(Object.keys(result).sort(), ['graph', 'publicConfig', 'registryAgents', 'schema', 'selector', 'version']); assert.deepEqual(result.registryAgents, ['AssistOSExplorer/dpuAgent', 'AssistOSExplorer/explorer']); assert.deepEqual(result.publicConfig, { staticAgent: 'explorer', staticPort: 8080 }); assert.equal(result.schema, PROBE_SCHEMA);
    assert.deepEqual(result.selector, { state: 'active', generation, activationId: 'act-1', publicationState: 'ready' });
    assert.deepEqual(result.graph.map(row => [row.name, row.running, row.ready, row.noWaitState, row.generationJoin, row.labelsEqual]),
        [['AssistOSExplorer/explorer', true, true, null, true, true], ['AssistOSExplorer/dpuAgent', true, true, 'running', true, true]]);
    const collect = s.state.calls.find(call => call[0] === 'collect')[1];
    assert.equal(Object.hasOwn(collect, 'liveContainers'), true); assert.equal(Object.hasOwn(collect, 'activeGeneration'), true); assert.equal(Object.hasOwn(collect, 'collectContainers'), false);
    assert.ok(s.state.calls.filter(call => call[0] === 'selection').length === 2 && s.state.calls.filter(call => call[0] === 'registry').length === 2);
    assert.ok(s.state.calls.every(call => call[0] !== 'registry' || call[1].workspaceRoot === workspaceRoot));
    const text = JSON.stringify(result); assert.doesNotMatch(text, /PRIVATE|env|secret|token/i);
});

test('readiness is positive only for running, joined, label-equal runtimes and exact current no-wait markers', async () => {
    for (const [label, mutate, index, expected] of [
        ['no-wait failed', state => { state.readiness.ploinky_dpuAgent = { ready: false, noWaitState: 'failed' }; }, 1, { ready: false, noWaitState: 'failed' }],
        ['no-wait starting', state => { state.readiness.ploinky_dpuAgent = { ready: false, noWaitState: 'starting' }; }, 1, { ready: false, noWaitState: 'starting' }],
        ['no-wait missing', state => { state.readiness.ploinky_dpuAgent = {}; }, 1, { ready: false, noWaitState: null }],
        ['no-wait unreadable', state => { state.readiness.ploinky_dpuAgent = { ready: false, noWaitState: 'unreadable' }; }, 1, { ready: false, noWaitState: 'unreadable' }],
        ['ordinary explicitly not ready', state => { state.readiness.ploinky_explorer = { ready: false }; }, 0, { ready: false, noWaitState: null }],
        ['container stopped', state => { state.running[H('c0')] = false; }, 0, { ready: false, running: false }],
        ['captured instance differs', state => { state.capturedInstance = { ploinky_explorer: 'other' }; }, 0, { ready: false, generationJoin: false }],
        ['container label differs', state => { state.labelOverride = { ploinky_explorer: 'other' }; }, 0, { ready: false, labelsEqual: false }],
        ['container name differs', state => { state.nameOverride = { ploinky_explorer: 'ploinky_other' }; }, 0, { ready: false, labelsEqual: false }]]) {
        const result = await scenario(mutate).run(); const row = result.graph[index];
        for (const [key, value] of Object.entries(expected)) assert.equal(row[key], value, `${label}: ${key}`);
    }
});

test('selector, generation file, registry and membership changes refuse with fixed codes', async () => {
    await failure(scenario(state => { state.selector = { ...state.selector, state: 'inactive' }; }).run(), 'probe-selector-inactive');
    await failure(scenario(state => { state.selectorAfterFirst = { ...state.selector, activationId: 'act-2' }; }).run(), 'probe-selector-changed');
    await failure(scenario(state => { state.loadSelector = { ...state.selector, generation: H('other') }; }).run(), 'probe-selector-changed');
    await failure(scenario(state => { state.loadError = 'EDGE_GENERATION_RUNTIME_MISMATCH'; }).run(), 'probe-generation-runtime-mismatch');
    await failure(scenario(state => { state.loadError = 'EDGE_GENERATION_CORRUPT'; }).run(), 'probe-generation-load');
    await failure(scenario(state => { state.stat = { ...state.stat, size: PROBE_LIMITS.generationBytes + 1 }; }).run(), 'probe-generation-bound');
    await failure(scenario(state => { state.stat = { ...state.stat, isSymbolicLink: () => true }; }).run(), 'probe-generation-bound');
    await failure(scenario(state => { state.stat = { ...state.stat, isFile: () => false }; }).run(), 'probe-generation-bound');
    await failure(scenario(state => { state.selector = { ...state.selector, generation: 'not-a-digest' }; }).run(), 'probe-generation-id');
    await failure(scenario(state => { state.statSequence = count => ({ ...state.stat, ino: count }); }).run(), 'probe-generation-changed');
    await failure(scenario(state => { state.statSequence = () => { throw new Error('PRIVATE'); }; }).run(), 'probe-generation-unreadable');
    await failure(scenario(state => { delete state.registry.ploinky_dpuAgent; }).run(), 'probe-runtime-missing');
    await failure(scenario(state => { state.registry.ploinky_twin = { ...state.registry.ploinky_explorer }; }).run(), 'probe-runtime-ambiguous');
    await failure(scenario(state => { state.registry.ploinky_explorer.containerId = 'short'; }).run(), 'probe-runtime-identity');
    await failure(scenario(state => { state.registry.ploinky_explorer.runtime = 'docker'; }).run(), 'probe-runtime-identity');
    await failure(scenario(state => { state.registryAfter = { ...state.registry, ploinky_explorer: { ...state.registry.ploinky_explorer, instanceId: 'rotated' } }; }).run(), 'probe-registry-changed');
    await failure(scenario(state => { state.inspectError = true; }).run(), 'probe-container-inspect');
    for (const routing of ['{}', 'not json', JSON.stringify({ static: { agent: 'explorer', port: 'x' } }), JSON.stringify({ static: { agent: '', port: 8080 } }), JSON.stringify({ static: { agent: 'a\nb', port: 8080 } }), JSON.stringify({ static: { agent: 'explorer', port: 70000 } })]) {
        await failure(scenario(state => { state.routing = routing; }).run(), 'probe-config-unreadable');
    }
    await failure(scenario(state => { state.routing = JSON.stringify({ static: { agent: 'x'.repeat(PROBE_LIMITS.configBytes + 1), port: 1 } }); }).run(), 'probe-config-bound');
    assert.throws(() => readPublicConfig('/nowhere', createMemoryFs({})), error => error.code === 'probe-config-unreadable');
});

test('probe input validation refuses unknown fields, duplicates and malformed names', () => {
    for (const bad of [null, {}, { requiredRuntimes: [] }, { requiredRuntimes: rows, extra: 1 }, { requiredRuntimes: [rows[0], rows[0]] }, { requiredRuntimes: [{ name: '../x', noWait: false }] },
        { requiredRuntimes: [{ name: 'a/b', noWait: 'no' }] }, { requiredRuntimes: [{ name: 'a/b', noWait: false, env: 1 }] }]) assert.throws(() => validateProbeInput(bad), error => error.code === 'probe-input');
    assert.equal(validateProbeInput(input), input);
});

test('probe main prints one public document or a fixed failure code and never an error message', async () => {
    const out = [];
    const s = scenario();
    assert.equal(await probeMain({ input, workspaceRoot, write: value => out.push(value), load: async () => s.apis }).then(code => code), 1, 'the unreplaceable real filesystem refuses the fixture generation');
    assert.equal(out[0].failure, 'probe-generation-unreadable'); assert.doesNotMatch(JSON.stringify(out), /PRIVATE|ENOENT/);
    out.length = 0; assert.equal(await probeMain({ input: { bad: true }, workspaceRoot, write: value => out.push(value), load: async () => s.apis }), 1); assert.equal(out[0].failure, 'probe-input');
    out.length = 0; assert.equal(await probeMain({ input, workspaceRoot, write: value => out.push(value), load: async () => { throw new Error('PRIVATE-IMPORT-DETAIL'); } }), 1);
    assert.deepEqual(out, [{ schema: PROBE_SCHEMA, version: 1, failure: 'probe-failed' }]);
});

test('nested inspection uses a fixed template, exact container IDs and a private environment', () => {
    const calls = [];
    const spawnSync = (bin, args, options) => { calls.push({ bin, args, options }); return { status: 0, stdout: Buffer.from(`id=${JSON.stringify(H('c0'))}\nname="/ploinky_x"\nrunning=true\nstartedAt="2026-10-04T12:00:00Z"\nimage="sha256:${H('i')}"\ninstanceId="i"\nenableGeneration="g"\nmounts=[]\n`) }; };
    const result = inspectNestedContainers([H('c0')], { spawnSync, env: { PATH: '/usr/bin', SECRET_TOKEN: 'PRIVATE-SENTINEL', HOME: '/home/podman' } });
    assert.equal(result.get(H('c0')).name, 'ploinky_x');
    assert.deepEqual(calls[0].args, ['container', 'inspect', '--format', READER_INSPECT_FORMAT, H('c0')]); assert.equal(calls[0].options.shell, false);
    assert.deepEqual(Object.keys(calls[0].options.env).sort(), ['HOME', 'LC_ALL', 'PATH']);
    assert.throws(() => inspectNestedContainers(['name'], { spawnSync }), error => error.code === 'probe-container-id');
    assert.throws(() => inspectNestedContainers([H('c0')], { spawnSync: () => ({ status: 1, stdout: Buffer.alloc(0) }) }), error => error.code === 'probe-container-inspect');
    assert.throws(() => inspectNestedContainers([H('c0')], { spawnSync: () => ({ status: 0, stdout: Buffer.from('garbage') }) }), error => error.code === 'probe-container-inspect');
    assert.throws(() => inspectNestedContainers([H('c0')], { spawnSync: () => ({ status: 0, error: new Error('x'), stdout: Buffer.alloc(0) }) }), error => error.code === 'probe-container-inspect');
});

test('the probe reports every agent the registry holds, including agents nobody asked about, and refuses a registry that changes under it', async () => {
    const extra = { type: 'agent', repoName: 'AssistOSExplorer', agentName: 'onlyOffice', runtime: 'podman', containerId: H('cx'), instanceId: 'i-x', enableGeneration: 'e-x' };
    const s = scenario(state => { state.registry.ploinky_onlyOffice = extra; state.registry.not_an_agent = { type: 'volume', repoName: 'R', agentName: 'v' }; });
    const result = await s.run(); assert.deepEqual(result.registryAgents, ['AssistOSExplorer/dpuAgent', 'AssistOSExplorer/explorer', 'AssistOSExplorer/onlyOffice']);
    assert.deepEqual(result.graph.map(row => row.name), rows.map(row => row.name), 'the probed rows are still only the requested ones');
    assert.deepEqual(registryAgentNames({ a: { type: 'agent', repoName: 'R', agentName: 'x' }, b: { type: 'agent', repoName: 'R', agentName: 'x' } }), ['R/x', 'R/x'], 'an aliased enable of one agent appears twice');
    assert.deepEqual(registryAgentNames({}), []); assert.deepEqual(registryAgentNames(null), []);
    const grows = scenario(state => { state.registryAfter = { ...state.registry, ploinky_extra: { ...extra, agentName: 'webmeetStt' } }; });
    await failure(grows.run(), 'probe-registry-changed');
    assert.throws(() => registryAgentNames(Object.fromEntries(Array.from({ length: PROBE_LIMITS.registryAgents + 1 }, (_, index) => [`c${index}`, { type: 'agent', repoName: 'R', agentName: `a${index}` }]))), error => error.code === 'probe-registry-unreadable');
});
