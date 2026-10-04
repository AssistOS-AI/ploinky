import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestFixture, installPureGuards, H } from './test_support_codex.mjs';
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

function build(mutate = () => {}) {
    const { value: manifest } = manifestFixture(), state = {};
    manifest.engine.identity = engineIdentityOf({ info, path: manifest.engine.path, uid }); manifest.endpointEngine = undefined; delete manifest.endpointEngine;
    manifest.fixtureEndpoint.engineIdentity = manifest.engine.identity; manifest.engine.gpuWiringIdentity = gpuWiringIdentityOf({});
    manifest.graph = [{ name: 'AssistOSExplorer/explorer', repository: 'AssistOSExplorer', noWait: false, externalHealthRequired: true, declaredEnableFlags: [], manifestSha256: H('m1') },
        { name: 'AssistOSExplorer/dpuAgent', repository: 'AssistOSExplorer', noWait: true, externalHealthRequired: false, declaredEnableFlags: ['no-wait'], manifestSha256: H('m2') }];
    Object.assign(state, { info: { ...info }, health: 200, status: { state: 'running-initialized', owned: true, initialized: true, routingConfigured: true, trackedAgents: 2, runningAgents: 2,
        pendingActivation: false, recoveryBarrier: false, stateReadErrors: 0 }, workspace: { dev: manifest.workspace.dev, ino: manifest.workspace.ino, uid, directory: true },
        box: { id: manifest.box.id, image: `sha256:${manifest.box.imageId}`, running: true, status: 'running', startedAt: '2026-10-04T11:59:50.123456789Z', privileged: false, init: true,
            capAdd: null, securityOpt: ['label=disable'], devices: [{ PathOnHost: '/dev/fuse' }, { PathOnHost: '/dev/net/tun' }], networkMode: 'pasta',
            ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }], '7882/udp': [{ HostIp: '', HostPort: '7882' }] },
            mounts: [{ Source: manifest.sourceMounts[0].source, Destination: '/opt/ploinky', RW: false }, { Source: manifest.workspace.path, Destination: manifest.workspace.path, RW: true }],
            labels: { 'io.assistos.ploinky-box.agentlib-fingerprint': manifest.agentLib.fingerprint }, workdir: manifest.workspace.path, user: 'podman' },
        probe: null, repos: {} });
    for (const repo of manifest.candidate.repositories) state.repos[repo.path] = { commit: repo.commit, branch: repo.branch, upstream: repo.upstream, pushed: repo.commit, dirty: '' };
    state.probe = { schema: 'live-update-cache-box-probe', version: 1, selector: { state: 'active', generation: manifest.box.activeGeneration, activationId: 'act-1', publicationState: 'ready' },
        graph: manifest.graph.map(entry => ({ name: entry.name, containerName: `ploinky_${entry.name.replace('/', '_')}`, runtimeId: H(`rt-${entry.name}`), instanceId: `inst-${entry.name}`, enableGeneration: 'enable-1',
            graphGeneration: manifest.box.activeGeneration, running: true, ready: true, noWaitState: entry.noWait ? 'running' : null, generationJoin: true, labelsEqual: true, imageId: H('agent-image') })) };
    mutate(manifest, state); validateManifest(manifest);
    const routes = [
        { match: byArgs('info', '--format'), reply: () => ({ stdout: infoText(state.info) }) },
        { match: (_b, args) => args[0] === 'container' && args[1] === 'inspect', reply: () => { const b = state.box;
            return { stdout: lines([['id', b.id], ['image', b.image], ['running', b.running], ['status', b.status], ['startedAt', b.startedAt], ['privileged', b.privileged], ['init', b.init], ['capAdd', b.capAdd],
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
    const receipt = await h.observer.admit();
    assert.deepEqual(receipt, { phase: 'U0', admitted: true, activeGeneration: h.manifest.box.activeGeneration, runtimes: 2 });
    const operations = h.fake.log.map(row => `${row.options.stdio[0]}:${row.args.slice(0, 3).join(' ')}`);
    assert.equal(h.fake.log.filter(row => row.bin === '/usr/bin/git').length, 4 * 5);
    assert.deepEqual(h.requests, [{ url: 'http://127.0.0.1:8080/health', timeoutMs: 5000 }]);
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
    const row = parseReaderInspect(Buffer.from(lines([['id', H('c')], ['name', '/ploinky_x'], ['running', true], ['image', `sha256:${H('i')}`], ['instanceId', 'i'], ['enableGeneration', 'g'], ['mounts', [{ Source: '/s', Destination: '/d', RW: false }]]])), H('c'));
    assert.deepEqual(row.mounts, [{ source: '/s', destination: '/d', readOnly: true }]); assert.equal(row.name, 'ploinky_x');
    assert.throws(() => parseReaderInspect(Buffer.from(lines([['id', H('d')], ['name', 'n'], ['running', true], ['image', 'x'], ['instanceId', 'i'], ['enableGeneration', 'g'], ['mounts', []]])), H('c')), error => error.code === 'reader-inspect-shape');
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

test('a non-Linux or foreign-uid host refuses before any command is launched', async () => {
    const h = build(); const other = createLiveObserver({ manifest: h.manifest, deps: h.fake.deps, statusProof: async () => h.state.status, hostFacts: { platform: 'darwin', uid } });
    await rejects(other.admit(), 'runtime-host-unqualified'); assert.equal(h.fake.log.length, 0);
    const uidOther = createLiveObserver({ manifest: h.manifest, deps: h.fake.deps, statusProof: async () => h.state.status, hostFacts: { platform: 'linux', uid: 0 } });
    await rejects(uidOther.admit(), 'runtime-host-unqualified'); assert.equal(h.fake.log.length, 0);
});

test('probe, status and health parsers reject extra, missing, oversized and secret-bearing fields', async () => {
    const { value: manifest } = manifestFixture(); const input = probeInput(manifest);
    const good = { schema: 'live-update-cache-box-probe', version: 1, selector: { state: 'active', generation: 'g', activationId: 'a', publicationState: 'ready' },
        graph: [{ name: input.requiredRuntimes[0].name, containerName: 'c', runtimeId: 'r', instanceId: 'i', enableGeneration: 'e', graphGeneration: 'g', running: true, ready: true, noWaitState: null, generationJoin: true, labelsEqual: true, imageId: 'x' }] };
    assert.equal(parseProbeOutput(Buffer.from(JSON.stringify(good)), input).selector.generation, 'g');
    for (const bad of [{ ...good, extra: 'PRIVATE' }, { ...good, graph: [{ ...good.graph[0], env: 'PRIVATE' }] }, { ...good, graph: [] }, { ...good, graph: [{ ...good.graph[0], name: 'Other/agent' }] },
        { ...good, graph: [{ ...good.graph[0], graphGeneration: 'h' }] }, { ...good, selector: { ...good.selector, state: 'inactive' } }]) {
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
