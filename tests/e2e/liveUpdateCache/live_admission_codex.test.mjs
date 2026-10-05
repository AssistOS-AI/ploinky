import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestFixture, installPureGuards, OPTIONAL_GRAPH, H } from './test_support_codex.mjs';
import { createFakeHost, byArgs } from './fake_host_support_codex.mjs';
import { validateManifest } from './manifest_codex.mjs';
import { buildCommandEnvironment } from './host_command_codex.mjs';
import { createLiveObserver, expectedLiveFromManifest, parseProbeOutput, parseStatusProof, probeBootstrap, probeInput, httpGetBounded, PROBE_BOOTSTRAP_PATH } from './live_admission_codex.mjs';
import { BOX_INSPECT_FORMAT, ENGINE_INFO_FORMAT, parseBoxInspect, parseEngineInfo, engineIdentityOf, gpuWiringIdentityOf, publicationsId, mountsId, sha256Hex, nestedInspectArgs, boxExecArgs,
    READER_INSPECT_FORMAT, parseReaderInspect, parsePortBindings } from './engine_codex.mjs';
installPureGuards();

const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
const uid = 1000, host = { platform: 'linux', uid };
const info = { rootless: true, version: '5.2.0', graphRoot: '/home/skutner/.local/share/containers/storage', runRoot: '/run/user/1000/containers' };
const lines = rows => rows.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
const infoText = value => lines([['rootless', value.rootless], ['version', value.version], ['graphRoot', value.graphRoot], ['runRoot', value.runRoot]]);

const boxLines = (over = {}) => { const b = { id: H('d'), name: '/n', image: `sha256:${H('i')}`, running: true, status: 'running', startedAt: '2026-10-04T11:59:50Z', privileged: false, init: true, capAdd: null, securityOpt: null,
    devices: null, networkMode: 'pasta', ports: {}, mounts: [], labels: {}, workdir: '/w', user: 'podman', ...over };
    return lines(['id', 'name', 'image', 'running', 'status', 'startedAt', 'privileged', 'init', 'capAdd', 'securityOpt', 'devices', 'networkMode', 'ports', 'mounts', 'labels', 'workdir', 'user'].map(key => [key, b[key]])); };

function build(mutate = () => {}) {
    const { value: manifest } = manifestFixture(), state = {};
    manifest.engine.identity = engineIdentityOf({ info, path: manifest.engine.path, uid }); manifest.endpointEngine = undefined; delete manifest.endpointEngine;
    manifest.fixtureEndpoint.engineIdentity = manifest.engine.identity; manifest.engine.gpuWiringIdentity = gpuWiringIdentityOf({});
    manifest.graph = [{ name: 'AssistOSExplorer/explorer', repository: 'AssistOSExplorer', noWait: false, externalHealthRequired: true, declaredEnableFlags: [], manifestSha256: H('m1') },
        { name: 'AssistOSExplorer/dpuAgent', repository: 'AssistOSExplorer', noWait: true, externalHealthRequired: false, declaredEnableFlags: ['no-wait'], manifestSha256: H('m2') }];
    Object.assign(state, { info: { ...info }, health: 200, status: { state: 'running-initialized', owned: true, initialized: true, routingConfigured: true, trackedAgents: 2, runningAgents: 2,
        pendingActivation: false, recoveryBarrier: false, stateReadErrors: 0 }, workspace: { dev: manifest.workspace.dev, ino: manifest.workspace.ino, uid, directory: true },
        box: { id: manifest.box.id, name: `/${manifest.box.name}`, image: `sha256:${manifest.box.imageId}`, running: true, status: 'running', startedAt: '2026-10-04T11:59:50.123456789Z', privileged: false, init: true,
            capAdd: null, securityOpt: ['label=disable'], devices: [{ PathOnHost: '/dev/fuse' }, { PathOnHost: '/dev/net/tun' }], networkMode: 'pasta',
            ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }], '7882/udp': [{ HostIp: '', HostPort: '7882' }] },
            mounts: [{ Source: manifest.sourceMounts[0].source, Destination: '/opt/ploinky', RW: false }, { Source: manifest.workspace.path, Destination: manifest.workspace.path, RW: true }],
            labels: { 'io.assistos.ploinky-box.agentlib-fingerprint': manifest.agentLib.fingerprint }, workdir: manifest.workspace.path, user: 'podman' },
        probe: null, repos: {} });
    for (const repo of manifest.candidate.repositories) state.repos[repo.path] = { commit: repo.commit, branch: repo.branch, upstream: repo.upstream, pushed: repo.commit, dirty: '' };
    state.probe = { schema: 'live-update-cache-box-probe', version: 1, publicConfig: { staticAgent: 'explorer', staticPort: 8080 }, selector: { state: 'active', generation: manifest.box.activeGeneration, activationId: 'act-1', publicationState: 'ready' },
        graph: manifest.graph.map(entry => ({ name: entry.name, containerName: `ploinky_${entry.name.replace('/', '_')}`, runtimeId: H(`rt-${entry.name}`), instanceId: `inst-${entry.name}`, enableGeneration: 'enable-1',
            graphGeneration: manifest.box.activeGeneration, running: true, ready: true, noWaitState: entry.noWait ? 'running' : null, generationJoin: true, labelsEqual: true, imageId: H('agent-image') })) };
    mutate(manifest, state); validateManifest(manifest);
    const routes = [
        { match: byArgs('info', '--format'), reply: () => ({ stdout: infoText(state.info) }) },
        { match: (_b, args) => args[0] === 'container' && args[1] === 'inspect', reply: () => { const b = state.box;
            return { stdout: lines([['id', b.id], ['name', b.name], ['image', b.image], ['running', b.running], ['status', b.status], ['startedAt', b.startedAt], ['privileged', b.privileged], ['init', b.init], ['capAdd', b.capAdd],
                ['securityOpt', b.securityOpt], ['devices', b.devices], ['networkMode', b.networkMode], ['ports', b.ports], ['mounts', b.mounts], ['labels', b.labels], ['workdir', b.workdir], ['user', b.user]]) }; } },
        { match: (_b, args) => args.includes('--interactive') && args.includes('-'), reply: ({ input }) => ({ stdout: JSON.stringify(state.probeOverride ?? state.probe) + '\n', stderr: undefined, code: state.probeExit ?? 0, input }) },
        { match: (bin, args) => bin === '/usr/bin/git', reply: ({ args }) => { const repo = state.repos[args[1]], git = args.slice(2).join(' ');
            if (git.startsWith('status')) return { stdout: repo.dirty }; if (git.startsWith('symbolic-ref')) return repo.branch ? { stdout: `${repo.branch}\n` } : { code: 1 };
            if (git.includes('@{upstream}')) return repo.upstream ? { stdout: `${repo.upstream}\n` } : { code: 128 }; if (git === 'rev-parse HEAD') return { stdout: `${repo.commit}\n` };
            if (git.startsWith('rev-parse refs/remotes/origin/')) return repo.pushed ? { stdout: `${repo.pushed}\n` } : { code: 128 }; return { code: 99 }; } },
    ];
    const fake = createFakeHost(routes), requests = [];
    const observer = createLiveObserver({ manifest, deps: fake.deps, statusProof: async () => state.status, hostFacts: host, env: buildCommandEnvironment({ PATH: '/usr/bin' }),
        io: { lstatSync: () => ({ isDirectory: () => state.workspace.directory, isSymbolicLink: () => false, dev: state.workspace.dev, ino: state.workspace.ino, uid: state.workspace.uid }), realpathSync: file => file },
        httpGet: async request => { requests.push(request); return { status: state.health, bytes: 2 }; } });
    return { manifest, state, fake, observer, requests };
}

test('admission binds the manifest to independently observed Box, engine, source, graph and Router health', async () => {
    const h = build();
    const observedNow = await h.observer.observe(); assert.deepEqual(observedNow.publicConfig, { staticAgent: 'explorer', staticPort: 8080 }); assert.equal(observedNow.activation.activationId, 'act-1');
    const receipt = await h.observer.admit();
    assert.deepEqual(receipt, { phase: 'U0', admitted: true, activeGeneration: h.manifest.box.activeGeneration, runtimes: 2 });
    const operations = h.fake.log.map(row => `${row.options.stdio[0]}:${row.args.slice(0, 3).join(' ')}`);
    assert.equal(h.fake.log.filter(row => row.bin === '/usr/bin/git').length, 4 * 5 * 2);
    assert.deepEqual(h.requests, Array(2).fill({ url: 'http://127.0.0.1:8080/health', timeoutMs: 5000 }));
    const probe = h.fake.log.find(row => row.args.includes('-')), env = probe.options.env;
    assert.deepEqual(probe.args, ['container', 'exec', '--interactive', '--env', 'PLOINKY_ROUTER_HOST_PORT=8080', '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', '--user', 'podman',
        '--workdir', h.manifest.workspace.path, h.manifest.box.id, '/usr/local/bin/node', '--input-type=module', '-']);
    assert.equal(probe.bin, h.manifest.engine.path); assert.equal(probe.options.shell, false);
    const bootstrap = probe.child.writes[0].toString(); assert.ok(bootstrap.includes(JSON.stringify(PROBE_BOOTSTRAP_PATH))); assert.deepEqual(Object.keys(env).sort(), ['GIT_TERMINAL_PROMPT', 'LC_ALL', 'PATH']);
    assert.deepEqual(JSON.parse(/probeMain\(\{ input: (.*) \}\)/.exec(bootstrap)[1]), probeInput(h.manifest));
    // Every command is a read: no start, update, enable, reinstall or exec of the outer CLI.
    assert.equal(h.fake.log.some(row => /(?:^|\/)ploinky$/.test(row.bin) || ['start', 'update', 'enable', 'reinstall', 'rm', 'stop'].some(word => row.args.includes(word))), false);
    assert.deepEqual(operations.length > 0, true); assert.equal(h.fake.custody.snapshot().every(row => row.settled), true);
});

test('the engine templates select named nonsecret fields and never Config.Env or a full inspection', () => {
    for (const text of [BOX_INSPECT_FORMAT, ENGINE_INFO_FORMAT, READER_INSPECT_FORMAT]) { assert.doesNotMatch(text, /Config\.Env|\.Env\b|\{\{json \.\}\}|Secret|Auth/); assert.match(text, /\{\{json /); }
    assert.deepEqual(nestedInspectArgs('/usr/bin/podman', H('b'), H('c')).slice(0, 7), ['/usr/bin/podman', 'exec', H('b'), 'podman', 'container', 'inspect', '--format']);
    assert.throws(() => nestedInspectArgs('/usr/bin/podman', H('b'), 'name'), error => error.code === 'engine-argument');
    assert.throws(() => boxExecArgs({ engineBin: 'podman', boxId: H('b'), workspace: '/w', routerHostPort: 1, mediaHostPort: 2, argv: ['x'] }), error => error.code === 'engine-argument');
    const row = parseReaderInspect(Buffer.from(lines([['id', H('c')], ['name', '/ploinky_x'], ['running', true], ['startedAt', '2026-10-04T12:00:00.5Z'], ['image', `sha256:${H('i')}`], ['instanceId', 'i'], ['enableGeneration', 'g'], ['mounts', [{ Source: '/s', Destination: '/d', RW: false }]]])), H('c'));
    assert.deepEqual(row.mounts, [{ source: '/s', destination: '/d', readOnly: true }]); assert.equal(row.name, 'ploinky_x'); assert.equal(row.startedAt, '2026-10-04T12:00:00.5Z');
    for (const startedAt of ['', 'yesterday', 'x'.repeat(65)]) assert.throws(() => parseReaderInspect(Buffer.from(lines([['id', H('c')], ['name', '/n'], ['running', true], ['startedAt', startedAt], ['image', 'x'], ['instanceId', 'i'], ['enableGeneration', 'g'], ['mounts', []]])), H('c')), error => error.code === 'reader-inspect-shape');
    assert.throws(() => parseReaderInspect(Buffer.from(lines([['id', H('d')], ['name', 'n'], ['running', true], ['startedAt', '2026-10-04T12:00:00.5Z'], ['image', 'x'], ['instanceId', 'i'], ['enableGeneration', 'g'], ['mounts', []]])), H('c')), error => error.code === 'reader-inspect-shape');
    assert.deepEqual(parsePortBindings({ '7882/udp': [{ HostIp: '', HostPort: '7882' }], '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] }),
        [{ protocol: 'tcp', hostIP: '127.0.0.1', hostPort: 8080, containerPort: 8080 }, { protocol: 'udp', hostIP: '0.0.0.0', hostPort: 7882, containerPort: 7882 }]);
    assert.throws(() => parseEngineInfo(Buffer.from('rootless=true\n')), error => error.code === 'engine-info-shape');
    assert.throws(() => parseBoxInspect(Buffer.from('')), error => error.code === 'box-inspect-shape');
    assert.equal(engineIdentityOf({ info, path: '/usr/bin/podman', uid }) === engineIdentityOf({ info: { ...info, version: '5.2.1' }, path: '/usr/bin/podman', uid }), false);
    assert.notEqual(publicationsId([{ a: 1 }]), publicationsId([{ a: 2 }])); assert.equal(mountsId([{ b: 1 }, { a: 1 }]), mountsId([{ a: 1 }, { b: 1 }])); assert.equal(sha256Hex('x').length, 64);
});

test('every deviation in the live deployment refuses admission with a fixed code and runs no mutation', async () => {
    const cases = [
        ['box start epoch changed', (m, s) => { s.box.startedAt = '2026-10-04T11:59:49Z'; }, 'live-box-start-epoch'],
        ['box image changed', (m, s) => { s.box.image = `sha256:${H('other-image')}`; }, 'live-binding-mismatch'],
        ['box name differs while the ID matches', (m, s) => { s.box.name = '/ploinky-box-other-0123456789ab'; }, 'live-box-contract'],
        ['box name is the ID', (m, s) => { s.box.name = s.box.id; }, 'live-box-contract'],
        ['box name carries a prefix of the manifest name', (m, s) => { s.box.name = `/${m.box.name}x`; }, 'live-box-contract'],
        ['gpu-grant label present but not hex while the manifest is unlabelled', (m, s) => { s.box.labels['io.assistos.ploinky-box.gpu-grant'] = 'not-a-fingerprint'; }, 'live-box-contract'],
        ['gpu-grant label present but empty while the manifest is unlabelled', (m, s) => { s.box.labels['io.assistos.ploinky-box.gpu-grant'] = ''; }, 'live-box-contract'],
        ['gpu-grant label upper-case hex while the manifest is unlabelled', (m, s) => { s.box.labels['io.assistos.ploinky-box.gpu-grant'] = H('a').toUpperCase(); }, 'live-box-contract'],
        ['gpu-grant label 63 hex while the manifest is unlabelled', (m, s) => { s.box.labels['io.assistos.ploinky-box.gpu-grant'] = H('a').slice(1); }, 'live-box-contract'],
        ['gpu-grant label oversized while the manifest is unlabelled', (m, s) => { s.box.labels['io.assistos.ploinky-box.gpu-grant'] = 'a'.repeat(300); }, 'live-box-contract'],
        ['gpu-grant label a non-string while the manifest is unlabelled', (m, s) => { s.box.labels['io.assistos.ploinky-box.gpu-grant'] = 7; }, 'live-box-contract'],
        ['gpu-grant label valid hex while the manifest is unlabelled', (m, s) => { s.box.labels['io.assistos.ploinky-box.gpu-grant'] = H('a'); }, 'live-box-contract'],
        ['gpu-grant label absent while the manifest is labelled', (m, s) => { m.engine.gpuWiringIdentity = H('grant'); }, 'live-box-contract'],
        ['box stopped', (m, s) => { s.box.running = false; }, 'live-box-contract'],
        ['box privileged', (m, s) => { s.box.privileged = true; }, 'live-box-contract'],
        ['box without init', (m, s) => { s.box.init = false; }, 'live-box-contract'],
        ['box cap-add', (m, s) => { s.box.capAdd = ['SYS_ADMIN']; }, 'live-box-contract'],
        ['unexpected device', (m, s) => { s.box.devices.push({ PathOnHost: '/dev/mem' }); }, 'live-box-contract'],
        ['agentlib fingerprint', (m, s) => { s.box.labels['io.assistos.ploinky-box.agentlib-fingerprint'] = H('other'); }, 'live-box-contract'],
        ['third publication', (m, s) => { s.box.ports['9000/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '9000' }]; }, 'live-box-publications'],
        ['wildcard router', (m, s) => { s.box.ports['8080/tcp'][0].HostIp = '0.0.0.0'; }, 'live-box-publications'],
        ['source mount writable', (m, s) => { s.box.mounts[0].RW = true; }, 'live-binding-mismatch'],
        ['source mount missing', (m, s) => { s.box.mounts.shift(); }, 'live-binding-mismatch'],
        ['engine not rootless', (m, s) => { s.info.rootless = false; }, 'runtime-host-unqualified'],
        ['engine changed', (m, s) => { s.info.version = '5.3.0'; }, 'live-binding-mismatch'],
        ['status not running', (m, s) => { s.status.state = 'running-uninitialized'; }, 'live-status-not-running'],
        ['status not owned', (m, s) => { s.status.owned = false; }, 'live-status-not-running'],
        ['too few running agents', (m, s) => { s.status.runningAgents = 1; }, 'live-status-not-running'],
        ['pending activation', (m, s) => { s.status.pendingActivation = true; }, 'workspace-not-live'],
        ['recovery barrier', (m, s) => { s.status.recoveryBarrier = true; }, 'workspace-not-live'],
        ['state record unreadable', (m, s) => { s.status.stateReadErrors = 1; }, 'workspace-not-live'],
        ['not initialized', (m, s) => { s.status.routingConfigured = false; }, 'workspace-not-live'],
        ['workspace inode changed', (m, s) => { s.workspace.ino += 1; }, 'live-binding-mismatch'],
        ['workspace not a directory', (m, s) => { s.workspace.directory = false; }, 'live-workspace-alias'],
        ['generation changed', (m, s) => { s.probe.selector.generation = 'other-generation'; s.probe.graph.forEach(row => { row.graphGeneration = 'other-generation'; }); }, 'workspace-not-live'],
        ['probe refusal', (m, s) => { s.probeOverride = { schema: 'live-update-cache-box-probe', version: 1, failure: 'probe-generation-changed' }; s.probeExit = 1; }, 'live-probe-generation-changed'],
        ['probe exits 1 while printing a success document', (m, s) => { s.probeExit = 1; }, 'live-probe-output'],
        ['probe malformed', (m, s) => { s.probeOverride = { schema: 'other' }; }, 'live-probe-output'],
        ['runtime not ready', (m, s) => { s.probe.graph[0].ready = false; }, 'graph-not-ready'],
        ['runtime not running', (m, s) => { s.probe.graph[0].running = false; }, 'graph-not-ready'],
        ['generation join broken', (m, s) => { s.probe.graph[0].generationJoin = false; }, 'graph-not-ready'],
        ['labels differ', (m, s) => { s.probe.graph[1].labelsEqual = false; }, 'graph-not-ready'],
        ['no-wait failed', (m, s) => { s.probe.graph[1].noWaitState = 'failed'; }, 'graph-not-ready'],
        ['no-wait absent', (m, s) => { s.probe.graph[1].noWaitState = null; }, 'graph-not-ready'],
        ['router unhealthy', (m, s) => { s.health = 503; }, 'graph-not-ready'],
        ['repository dirty', (m, s) => { s.repos[m.candidate.repositories[1].path].dirty = ' M file\n'; }, 'repository-not-pinned'],
        ['repository detached', (m, s) => { const r = s.repos[m.candidate.repositories[2].path]; r.branch = ''; r.upstream = ''; }, 'repository-not-pinned'],
        ['repository unpushed', (m, s) => { s.repos[m.candidate.repositories[3].path].pushed = ''; }, 'repository-not-pinned'],
        ['repository moved', (m, s) => { const r = s.repos[m.candidate.repositories[1].path]; r.commit = H('moved').slice(0, 40); r.pushed = r.commit; }, 'candidate-epoch-mismatch'],
    ];
    for (const [label, mutate, code] of cases) {
        const h = build(); mutate(h.manifest, h.state);
        await assert.rejects(h.observer.admit(), error => error.code === code, label);
        assert.equal(h.fake.log.some(row => ['start', 'update', 'enable', 'reinstall', 'rm', 'stop'].some(word => row.args.includes(word))), false, label);
    }
});

test('the Box name is read from the same exact-ID inspect, with or without the leading slash, and a labelled Box admits only its exact 64-hex label', async () => {
    const plain = build((m, s) => { s.box.name = m.box.name; }); assert.equal((await plain.observer.admit()).admitted, true);
    const slashed = build(); assert.equal((await slashed.observer.admit()).admitted, true);
    const inspect = slashed.fake.log.find(row => row.args[0] === 'container' && row.args[1] === 'inspect'); assert.deepEqual(inspect.args.slice(-1), [slashed.manifest.box.id]); assert.match(inspect.args.at(-2), /(?:^|\n)name=\{\{json \.Name\}\}\n/);
    const grant = H('grant'), labelled = build((m, s) => { m.engine.gpuWiringIdentity = grant; s.box.labels['io.assistos.ploinky-box.gpu-grant'] = grant; });
    assert.equal((await labelled.observer.admit()).admitted, true);
    for (const bad of [H('other-grant'), 'xyz', '']) await rejects(build((m, s) => { m.engine.gpuWiringIdentity = grant; s.box.labels['io.assistos.ploinky-box.gpu-grant'] = bad; }).observer.admit(), 'live-box-contract');
    for (const bad of ['', '/', '//x', 'a b', 'a\nb']) assert.throws(() => parseBoxInspect(Buffer.from(boxLines({ name: bad }))), error => error.code === 'box-inspect-shape');
    assert.equal(parseBoxInspect(Buffer.from(boxLines({ name: '/n1' }))).name, 'n1'); assert.equal(parseBoxInspect(Buffer.from(boxLines({ name: 'n1' }))).name, 'n1');
    assert.equal(parseBoxInspect(Buffer.from(boxLines({ labels: { 'io.assistos.ploinky-box.gpu-grant': 'zz' } }))).gpuGrantLabelPresent, true); assert.equal(parseBoxInspect(Buffer.from(boxLines({ labels: {} }))).gpuGrantLabelPresent, false);
    assert.throws(() => parseBoxInspect(Buffer.from(boxLines({ name: 7 }))), error => error.code === 'box-inspect-shape');
});

test('R2 after the activation: the declared optional runtimes extend the probe input, the required graph and the readiness count, and nothing else may be added', async () => {
    const withActivation = (m, s) => { m.activation = structuredClone(OPTIONAL_GRAPH); };
    const h = build(withActivation); const names = h.manifest.graph.map(entry => entry.name);
    // Before the activation the observer is exactly as before: the probe names only the default graph.
    assert.deepEqual(probeInput(h.manifest).requiredRuntimes.map(row => row.name), names); assert.equal(expectedLiveFromManifest(h.manifest).requiredGraph.length, names.length);
    const extended = [...names, ...OPTIONAL_GRAPH.map(entry => entry.name)];
    assert.deepEqual(probeInput(h.manifest, h.manifest.activation).requiredRuntimes.map(row => row.name), extended); assert.deepEqual(expectedLiveFromManifest(h.manifest, h.manifest.activation).requiredGraph.map(row => row.name), extended);
    // The in-Box probe answers for the extended list; the observed graph then has the three added rows, running and ready.
    h.state.probe.graph.push(...OPTIONAL_GRAPH.map(entry => ({ name: entry.name, containerName: `ploinky_${entry.name.replace('/', '_')}`, runtimeId: H(`rt-${entry.name}`), instanceId: `inst-${entry.name}`, enableGeneration: 'enable-1', graphGeneration: h.manifest.box.activeGeneration, running: true, ready: true, noWaitState: null, generationJoin: true, labelsEqual: true, imageId: H('agent-image') })));
    h.state.status.runningAgents = extended.length;
    const observed = await h.observer.observe({ addedGraph: h.manifest.activation }); assert.deepEqual(observed.graph.map(row => row.name), extended);
    const probeRun = h.fake.log.filter(row => row.args.includes('-')).at(-1); assert.deepEqual(JSON.parse(/probeMain\(\{ input: (.*) \}\)/.exec(probeRun.child.writes[0].toString())[1]).requiredRuntimes.map(row => row.name), extended);
    assert.equal((await h.observer.admit({ addedGraph: h.manifest.activation })).runtimes, extended.length);
    // Only the manifest's own declaration is accepted; every other binding stays exact.
    for (const bad of [[], OPTIONAL_GRAPH.slice(0, 2), [...OPTIONAL_GRAPH, { ...OPTIONAL_GRAPH[0], name: 'AssistOSExplorer/extra' }], [{ ...OPTIONAL_GRAPH[0], name: 'AssistOSExplorer/other' }, ...OPTIONAL_GRAPH.slice(1)], null, 'x']) {
        await rejects(h.observer.observe({ addedGraph: bad }), 'live-admission-override'); await rejects(h.observer.admit({ addedGraph: bad }), 'live-admission-override');
    }
    const plain = build(); await rejects(plain.observer.observe({ addedGraph: OPTIONAL_GRAPH }), 'live-admission-override'); await rejects(plain.observer.admit({ addedGraph: OPTIONAL_GRAPH }), 'live-admission-override');
    const notReady = build(withActivation); notReady.state.probe.graph.push(...OPTIONAL_GRAPH.map(entry => ({ name: entry.name, containerName: 'c', runtimeId: H(entry.name), instanceId: 'i', enableGeneration: 'e', graphGeneration: notReady.manifest.box.activeGeneration, running: true, ready: entry.name.endsWith('webmeetStt') ? false : true, noWaitState: null, generationJoin: true, labelsEqual: true, imageId: H('i') })));
    notReady.state.status.runningAgents = extended.length; await rejects(notReady.observer.admit({ addedGraph: notReady.manifest.activation }), 'graph-not-ready');
    const drift = build(withActivation); drift.state.probe.graph.push(...OPTIONAL_GRAPH.map(entry => ({ name: entry.name, containerName: 'c', runtimeId: H(entry.name), instanceId: 'i', enableGeneration: 'e', graphGeneration: drift.manifest.box.activeGeneration, running: true, ready: true, noWaitState: null, generationJoin: true, labelsEqual: true, imageId: H('i') })));
    drift.state.status.runningAgents = extended.length; drift.state.box.startedAt = '2026-10-04T11:59:49Z'; await rejects(drift.observer.admit({ addedGraph: drift.manifest.activation }), 'live-box-start-epoch');
});

test('after a legitimate generation change the same predicate admits only the generation the caller itself admitted', async () => {
    const moved = build((m, s) => { s.probe.selector.generation = 'generation-after-update'; s.probe.graph.forEach(row => { row.graphGeneration = 'generation-after-update'; }); });
    await rejects(moved.observer.admit(), 'workspace-not-live');                                           // the manifest's pre-update generation no longer matches
    assert.equal((await moved.observer.admit({ activeGeneration: 'generation-after-update' })).activeGeneration, 'generation-after-update');
    await rejects(moved.observer.admit({ activeGeneration: 'some-other-generation' }), 'workspace-not-live');
    for (const bad of [{ activeGeneration: 'bad value' }, { activeGeneration: 7 }, { activeGeneration: '' }, { box: { id: 'x' } }, { activeGeneration: 'generation-after-update', startedAt: 'x' }, null]) await rejects(moved.observer.admit(bad), 'live-admission-override');
    // Every other binding stays exact under the override: a moved Box start, an unready runtime or a drifted repository still refuse.
    for (const [mutate, code] of [[(m, s) => { s.box.startedAt = '2026-10-04T11:59:49Z'; }, 'live-box-start-epoch'], [(m, s) => { s.probe.graph[0].ready = false; }, 'graph-not-ready'], [(m, s) => { s.status.pendingActivation = true; }, 'workspace-not-live'],
        [(m, s) => { s.repos[m.candidate.repositories[1].path].dirty = ' M x\n'; }, 'repository-not-pinned']]) {
        const h = build((m, s) => { s.probe.selector.generation = 'generation-after-update'; s.probe.graph.forEach(row => { row.graphGeneration = 'generation-after-update'; }); mutate(m, s); });
        await rejects(h.observer.admit({ activeGeneration: 'generation-after-update' }), code);
    }
});

test('a non-Linux or foreign-uid host refuses before any command is launched', async () => {
    const h = build(); const other = createLiveObserver({ manifest: h.manifest, deps: h.fake.deps, statusProof: async () => h.state.status, hostFacts: { platform: 'darwin', uid } });
    await rejects(other.admit(), 'runtime-host-unqualified'); assert.equal(h.fake.log.length, 0);
    const uidOther = createLiveObserver({ manifest: h.manifest, deps: h.fake.deps, statusProof: async () => h.state.status, hostFacts: { platform: 'linux', uid: 0 } });
    await rejects(uidOther.admit(), 'runtime-host-unqualified'); assert.equal(h.fake.log.length, 0);
});

test('probe, status and health parsers reject extra, missing, oversized and secret-bearing fields', async () => {
    const { value: manifest } = manifestFixture(); const input = probeInput(manifest);
    const good = { schema: 'live-update-cache-box-probe', version: 1, publicConfig: { staticAgent: 'explorer', staticPort: 8080 }, selector: { state: 'active', generation: 'g', activationId: 'a', publicationState: 'ready' },
        graph: [{ name: input.requiredRuntimes[0].name, containerName: 'c', runtimeId: 'r', instanceId: 'i', enableGeneration: 'e', graphGeneration: 'g', running: true, ready: true, noWaitState: null, generationJoin: true, labelsEqual: true, imageId: 'x' }] };
    assert.equal(parseProbeOutput(Buffer.from(JSON.stringify(good)), input).selector.generation, 'g');
    for (const bad of [{ ...good, extra: 'PRIVATE' }, { ...good, graph: [{ ...good.graph[0], env: 'PRIVATE' }] }, { ...good, graph: [] }, { ...good, graph: [{ ...good.graph[0], name: 'Other/agent' }] },
        { ...good, graph: [{ ...good.graph[0], graphGeneration: 'h' }] }, { ...good, selector: { ...good.selector, state: 'inactive' } }, { ...good, publicConfig: { staticAgent: 'e', staticPort: 8080, extra: 1 } },
        { ...good, publicConfig: { staticAgent: 'e', staticPort: '8080' } }, { schema: good.schema, version: 1, selector: good.selector, graph: good.graph }]) {
        assert.throws(() => parseProbeOutput(Buffer.from(JSON.stringify(bad)), input), error => error.code === 'live-probe-output');
    }
    assert.throws(() => parseProbeOutput(Buffer.alloc(200000, 97), input), error => error.code === 'live-probe-output');
    assert.throws(() => parseProbeOutput(Buffer.from('\xff\xfe'), input), error => error.code === 'live-probe-output');
    assert.throws(() => parseProbeOutput(Buffer.from(JSON.stringify({ schema: 'live-update-cache-box-probe', version: 1, failure: 'probe-x', extra: 1 })), input), error => error.code === 'live-probe-output');
    assert.throws(() => parseStatusProof({ state: 'running-initialized' }), error => error.code === 'live-status-proof');
});

test('bounded health reader enforces the response cap and refuses an overlong exchange', async () => {
    const { EventEmitter } = await import('node:events');
    const make = body => (url, options, callback) => { const request = new EventEmitter(); request.destroy = () => { request.destroyed = true; };
        queueMicrotask(() => { const response = new EventEmitter(); response.statusCode = 200; response.destroy = () => {}; callback(response); for (const chunk of body) response.emit('data', chunk); response.emit('end'); }); return request; };
    assert.deepEqual(await httpGetBounded({ url: 'http://127.0.0.1:1/health', timeoutMs: 10, request: make([Buffer.alloc(10)]) }), { status: 200, bytes: 10 });
    await assert.rejects(httpGetBounded({ url: 'http://127.0.0.1:1/health', timeoutMs: 10, maxBytes: 8, request: make([Buffer.alloc(9)]) }), error => error.code === 'http-overflow');
    const timeout = () => { const request = new EventEmitter(); request.destroy = () => {}; queueMicrotask(() => request.emit('timeout')); return request; };
    await assert.rejects(httpGetBounded({ url: 'http://127.0.0.1:1/health', timeoutMs: 10, request: timeout }), error => error.code === 'http-timeout');
});

test('expectation derivation is exact and carries no unobserved credit', () => {
    const { value: manifest } = manifestFixture(); const expected = expectedLiveFromManifest(manifest);
    assert.deepEqual(Object.keys(expected).sort(), ['activeGeneration', 'box', 'candidate', 'engineIdentity', 'publications', 'requiredGraph', 'sourceMounts', 'workspace']);
    assert.equal(expected.candidate.imageId, manifest.box.imageId); assert.equal(expected.publications, publicationsId(manifest.publications));
    assert.ok(expected.candidate.repositories.every(repo => repo.clean === true && repo.detached === false && repo.commit === repo.pushedCommit));
});
