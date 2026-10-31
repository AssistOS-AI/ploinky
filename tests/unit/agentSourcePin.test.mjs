// M-68/M-71 agent source pin: enable records the repository folder an agent
// resolved; enabled agents keep launching from that pinned folder whatever new
// folders appear, while a new enable or re-enable refuses a contested
// resolution; a record enabled before pins existed is held to the folder its
// binds or route recorded (F2); link-install checkouts are pinned at the first
// launch. These cases need no Git: a planted folder carries the repository's
// name, which the resolver accepts without reading an origin. Origin cases are
// in agentSourcePinGit.test.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-pin-')));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const previousCwd = process.cwd();
process.chdir(workspace);

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const pin = await import('../../cli/utils/agentSourcePin.mjs');
const { resolveWorkspaceDependencyGraph } = await import('../../cli/utils/workspaceDependencyGraph.js');
const { admitAgentServicePreflight } = await import('../../cli/sandbox/docker/agentServiceManager.js');
const { previewAgentEnable } = await import('../../cli/utils/agents.js');
const { createContainerMonitor, syncManagedContainers } = await import('../../cli/server/containerMonitor.js');
const { findAgent } = await import('../../cli/utils/utils.js');
const { freshAgentRepositoryPath, resolveAgentRepositoryName, resolveAgentRepositoryPath } = await import('../../cli/utils/agentRepositorySource.mjs');
const { updateRegisteredRepository } = await import('../../cli/utils/repos.js');
const { printAgentSourceStatus } = await import('../../cli/utils/status.js');
const { REPOSITORY_AMBIGUOUS } = await import('../../cli/utils/repositorySource.mjs');
const { linkedRepositoryPins, prepareLinkedRepositories } = await import('../../cli/utils/linkInstall.mjs');
const { readUpdateGraph } = await import('../../cli/commands/updateGraph.js');
const { getAgentContainerName } = await import('../../cli/sandbox/docker/common.js');
const KEY = getAgentContainerName('worker', 'demo');

const ploinkyDir = path.join(workspace, '.ploinky');
const managedRepo = path.join(ploinkyDir, 'repos', 'demo');
const MANIFEST = { container: 'node:20-alpine' };

test.after(() => {
    process.chdir(previousCwd);
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function agentDir(root, name = 'worker') {
    const directory = path.join(root, name);
    writeJson(path.join(directory, 'manifest.json'), MANIFEST);
    return directory;
}

// A fresh workspace: repository `demo` installed under .ploinky/repos with
// agent `worker`, enabled and pinned the way enable pins it.
function resetWorkspace({ pinned = true, legacyBinds = null, route = true } = {}) {
    for (const entry of fs.readdirSync(workspace)) fs.rmSync(path.join(workspace, entry), { recursive: true, force: true });
    const worker = agentDir(managedRepo);
    fs.mkdirSync(path.join(managedRepo, '.git'), { recursive: true });
    const record = {
        type: 'agent',
        repoName: 'demo',
        agentName: 'worker',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        runtime: 'container',
        ...(pinned ? { sourceIdentity: pin.agentSourceIdentity({ repoName: 'demo', agentPath: worker, originOf: () => '' }) } : {}),
        ...(legacyBinds ? { config: { binds: legacyBinds } } : {}),
    };
    writeJson(path.join(ploinkyDir, 'agents.json'), { [KEY]: record });
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        routes: route ? { worker: { repo: 'demo', agent: 'worker', container: KEY, hostPath: worker } } : {},
    });
    return { worker, record };
}

function registry() {
    return JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8'));
}

function plantNamedFolder() {
    // A top-level folder named after the repository, with the agent's
    // manifest: the resolver now prefers it (no origin is compared).
    return agentDir(path.join(workspace, 'demo'));
}

test('compareAgentSourcePin: only a missing pin is unpinned; folder, repository and readable origin changes mismatch', () => {
    const current = { repoName: 'demo', origin: 'github.com/example/demo', realpath: '/w/demo' };
    assert.equal(pin.compareAgentSourcePin(undefined, current).status, 'unpinned');
    assert.equal(pin.compareAgentSourcePin(null, current).status, 'unpinned');
    assert.equal(pin.compareAgentSourcePin({ ...current }, current).status, 'match');
    assert.deepEqual(pin.compareAgentSourcePin({ ...current, realpath: '/w/other' }, current).reasons, ['folder']);
    assert.deepEqual(pin.compareAgentSourcePin({ ...current, repoName: 'other' }, current).reasons, ['repository']);
    assert.deepEqual(pin.compareAgentSourcePin({ ...current, origin: 'github.com/evil/demo' }, current).reasons, ['origin']);
    // An origin unreadable now (Git missing, timed out) or at enable proves nothing on its own.
    assert.equal(pin.compareAgentSourcePin({ ...current }, { ...current, origin: '' }).status, 'match');
    assert.equal(pin.compareAgentSourcePin({ ...current, origin: '' }, current).status, 'match');
    // A malformed pin is never treated as absent.
    for (const broken of [{}, 'x', [], { ...current, realpath: 'relative' }, { ...current, origin: 1 }]) {
        assert.equal(pin.compareAgentSourcePin(broken, current).status, 'mismatch', JSON.stringify(broken));
    }
});

test('agentSourceIdentity pins the real repository root, not the agent directory or a symlink spelling', () => {
    const { worker } = resetWorkspace();
    const link = path.join(workspace, 'link-to-demo');
    fs.symlinkSync(managedRepo, link);
    const viaLink = pin.agentSourceIdentity({ repoName: 'demo', agentPath: path.join(link, 'worker'), originOf: () => 'o' });
    assert.deepEqual(viaLink, { repoName: 'demo', origin: 'o', realpath: managedRepo });
    const failingOrigin = pin.agentSourceIdentity({ repoName: 'demo', agentPath: worker, originOf: () => { throw new Error('timeout'); } });
    assert.equal(failingOrigin.origin, '');
});

test('M-71: with a planted folder named after the repository, an enabled agent still launches from its pin; planning refuses naming the plant', () => {
    const { worker } = resetWorkspace();
    const before = fs.readFileSync(path.join(ploinkyDir, 'agents.json'));
    const planted = plantNamedFolder();
    // Launch paths: qualified lookup, the graph (also for the bare name of the
    // enabled agent), the reverse name, the preflight and the watchdog input.
    assert.equal(findAgent('demo/worker').manifestPath, path.join(worker, 'manifest.json'));
    for (const ref of ['demo/worker', 'worker']) {
        const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: ref, registry: registry() });
        assert.equal([...graph.nodes.values()][0].agentPath, worker, ref);
    }
    assert.equal(resolveAgentRepositoryName(worker), 'demo');
    assert.equal(resolveAgentRepositoryPath('demo'), managedRepo);
    let error = null;
    try { admitAgentServicePreflight('worker', MANIFEST, worker, {}); } catch (caught) { error = caught; }
    assert.notEqual(error?.code, pin.AGENT_SOURCE_CHANGED, error?.message);
    // Planning (a re-enable, qualified or bare) refuses and names the plant.
    for (const ref of ['demo/worker', 'worker']) {
        assert.throws(() => findAgent(ref, { planning: true }), (caught) => caught.code === REPOSITORY_AMBIGUOUS
            && /enabled from '\.ploinky\/repos\/demo', but the folder 'demo' now also claims it/.test(caught.message), ref);
    }
    assert.throws(() => previewAgentEnable({ agentName: 'demo/worker' }), /the folder 'demo' now also claims it/);
    assert.deepEqual(fs.readFileSync(path.join(ploinkyDir, 'agents.json')), before, 'the pin is never rewritten');
    assert.equal(planted.length > 0, true);
});

test('M-71: an operator who removes the old pinned folder can re-enable from the new one; until then launches refuse plainly', () => {
    resetWorkspace();
    const planted = plantNamedFolder();
    fs.rmSync(managedRepo, { recursive: true, force: true });
    assert.throws(() => findAgent('demo/worker'), (error) => error.code === pin.AGENT_SOURCE_CHANGED
        && /was enabled from '.*\.ploinky\/repos\/demo', which no longer exists/.test(error.message));
    assert.equal(findAgent('demo/worker', { planning: true }).manifestPath, path.join(planted, 'manifest.json'));
    const prepared = { ...registry()[KEY], sourceIdentity: pin.agentSourceIdentity({ repoName: 'demo', agentPath: planted }) };
    let error = null;
    try {
        admitAgentServicePreflight('worker', MANIFEST, planted, { preservePreparedRegistryRecord: true, preparedRegistryRecord: prepared });
    } catch (caught) { error = caught; }
    assert.notEqual(error?.code, pin.AGENT_SOURCE_CHANGED, error?.message);
    assert.match(pin.sourcePinReport({ repoName: 'demo', agentName: 'worker', pin: prepared.sourceIdentity,
        previousPin: registry()[KEY].sourceIdentity }), /source moved from \.ploinky\/repos\/demo .* to demo /);
});

test('a pin whose own folder no longer matches it (another repository name) is refused by graph build and preflight', () => {
    const { worker } = resetWorkspace();
    const agents = registry();
    agents[KEY].sourceIdentity = { ...agents[KEY].sourceIdentity, repoName: 'other' };
    writeJson(path.join(ploinkyDir, 'agents.json'), agents);
    assert.throws(() => resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/worker', registry: registry() }), { code: pin.AGENT_SOURCE_CHANGED });
    assert.throws(() => admitAgentServicePreflight('worker', MANIFEST, worker, {}), { code: pin.AGENT_SOURCE_CHANGED });
});

test('start --branch, update, reinstall and restart keep the folder, so the pin holds; a re-clone into the same path holds too', () => {
    const { record, worker } = resetWorkspace();
    const check = () => {
        // The resolution calls those flows make: findAgent (start, restart,
        // reinstall), the reverse name (launch), the graph (start, update).
        const resolved = findAgent('demo/worker');
        assert.equal(resolveAgentRepositoryName(path.dirname(resolved.manifestPath)), 'demo');
        resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/worker', registry: registry() });
        pin.assertAgentSourcePin(record, { repoName: 'demo', agentName: 'worker', agentPath: path.dirname(resolved.manifestPath) });
    };
    check();
    // A branch switch or fast-forward changes files and Git metadata in place.
    fs.writeFileSync(path.join(managedRepo, '.git', 'HEAD'), 'ref: refs/heads/featureX\n');
    fs.writeFileSync(path.join(worker, 'manifest.json'), JSON.stringify({ ...MANIFEST, about: 'updated' }));
    check();
    // A managed checkout cloned again and renamed into the same path has a new inode.
    const inodeBefore = fs.statSync(managedRepo).ino;
    const fresh = path.join(ploinkyDir, 'repos', '.demo.clone');
    agentDir(fresh);
    fs.mkdirSync(path.join(fresh, '.git'));
    fs.rmSync(managedRepo, { recursive: true, force: true });
    fs.renameSync(fresh, managedRepo);
    assert.notEqual(fs.statSync(managedRepo).ino, inodeBefore);
    check();
});

test('launchSourceIdentity keeps the launched record pin byte-for-byte and pins an unpinned record once, with one log line', () => {
    const { record, worker } = resetWorkspace();
    const logs = [];
    const kept = pin.launchSourceIdentity([record, { sourceIdentity: { repoName: 'x', origin: '', realpath: '/x' } }],
        { repoName: 'demo', agentName: 'worker', agentPath: path.join(workspace, 'demo', 'worker'), log: (line) => logs.push(line) });
    assert.equal(JSON.stringify(kept), JSON.stringify(record.sourceIdentity));
    assert.deepEqual(logs, []);
    const migrated = pin.launchSourceIdentity([null, {}], { repoName: 'demo', agentName: 'worker', agentPath: worker,
        log: (line) => logs.push(line), originOf: () => '' });
    assert.deepEqual(migrated, { repoName: 'demo', origin: '', realpath: managedRepo });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[source-pin\] demo\/worker: recorded source \.ploinky\/repos\/demo .*enabled before Ploinky recorded agent sources/);
});

test('F2: a record enabled before pins existed is held to the folder its /code bind recorded; a different resolution refuses', () => {
    resetWorkspace({ pinned: false, legacyBinds: [{ source: path.join(managedRepo, 'worker'), target: '/code' }] });
    // Control: the folder still resolves to its bind, so it is admitted and pinned at launch.
    resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/worker', registry: registry() });
    const planted = plantNamedFolder();
    assert.equal(findAgent('demo/worker').manifestPath, path.join(planted, 'manifest.json'), 'no pin, so the fresh resolution');
    assert.throws(() => resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/worker', registry: registry() }), (error) =>
        error.code === pin.AGENT_SOURCE_CHANGED && /was enabled from \.ploinky\/repos\/demo/.test(error.message));
    assert.throws(() => admitAgentServicePreflight('worker', MANIFEST, planted, {}), { code: pin.AGENT_SOURCE_CHANGED });
    // A launch-written /code bind of an agent with a code/ directory counts too.
    const coded = { ...registry()[KEY], config: { binds: [{ source: path.join(managedRepo, 'worker', 'code'), target: '/code' }] } };
    assert.equal(pin.legacySourceRoot(coded, { routes: {} }), managedRepo);
});

test('F2: without binds the route hostPath is the evidence; only a record with no evidence at all is admitted unchecked', () => {
    resetWorkspace({ pinned: false });
    const planted = plantNamedFolder();
    assert.throws(() => admitAgentServicePreflight('worker', MANIFEST, planted, {}), { code: pin.AGENT_SOURCE_CHANGED });
    resetWorkspace({ pinned: false, route: false });
    const unplanted = plantNamedFolder();
    let error = null;
    try { admitAgentServicePreflight('worker', MANIFEST, unplanted, {}); } catch (caught) { error = caught; }
    assert.notEqual(error?.code, pin.AGENT_SOURCE_CHANGED);
});

test('every launch record rebuild carries the launched record pin before computing one', () => {
    const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const docker = read('cli/sandbox/docker/agentServiceManager.js');
    assert.match(docker, /sourceIdentity: launchSourceIdentity\(\[launchRecord, persistedRecord\]/);
    assert.match(docker, /sourceIdentity: launchSourceIdentity\(\[startedRecord, launchRecord\]/);
    assert.match(docker, /linkedRepositories: structuredClone\(linkedRepositoryRecord\)/);
    assert.match(docker, /pinned: Array\.isArray\(launchRecord\.linkedRepositories\) \? launchRecord\.linkedRepositories : null/);
    for (const file of ['cli/sandbox/bwrap/bwrapServiceManager.js', 'cli/sandbox/seatbelt/seatbeltServiceManager.js']) {
        assert.match(read(file), /sourceIdentity: launchSourceIdentity\(\[\s*options\.preservePreparedRegistryRecord === true \? options\.preparedRegistryRecord : null,/, file);
    }
    // The pin check precedes the publication refusal in the read-only preflight.
    const preflight = docker.slice(docker.indexOf('export function admitAgentServicePreflight('));
    assert.ok(preflight.indexOf('assertAgentSourcePin(preflightRecord') > 0);
    assert.ok(preflight.indexOf('assertAgentSourcePin(preflightRecord') < preflight.indexOf('assertExecutionProviderPublication({'));
});

test('watchdog: a source mismatch leaves the agent stopped, never restarts it, and logs once per state change', async () => {
    // A pre-pin record whose /code bind no longer matches the resolution.
    resetWorkspace({ pinned: false, legacyBinds: [{ source: path.join(managedRepo, 'worker'), target: '/code' }] });
    plantNamedFolder();
    const ledger = path.join(ploinkyDir, 'running', 'source-pin-ledger.json');
    const events = [];
    let restarts = 0;
    const monitor = createContainerMonitor({ terminalLedgerFile: ledger, log: (level, event, data) => events.push({ level, event, data }) });
    monitor.ensureAgentService = () => { restarts += 1; throw new Error('must not restart'); };
    for (let tick = 0; tick < 3; tick += 1) syncManagedContainers(monitor);
    assert.equal(monitor.targets.size, 0, 'no target, so no probe and no restart timer');
    assert.equal(monitor.terminalLedger.get(KEY)?.code, pin.AGENT_SOURCE_CHANGED);
    const logged = events.filter(({ event }) => event === 'container_source_changed');
    assert.equal(logged.length, 1, 'logged once, not per sync');
    assert.match(logged[0].data.message, /will not start or restart this agent/);
    assert.equal(events.some(({ event }) => event === 'container_runtime_policy_terminal'), false);

    const respawned = createContainerMonitor({ terminalLedgerFile: ledger, log: (level, event, data) => events.push({ level, event, data }) });
    respawned.ensureAgentService = monitor.ensureAgentService;
    syncManagedContainers(respawned);
    assert.equal(events.filter(({ event }) => event === 'container_source_changed').length, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(restarts, 0);

    fs.rmSync(path.join(workspace, 'demo'), { recursive: true, force: true });
    syncManagedContainers(respawned);
    assert.equal(respawned.terminalLedger.has(KEY), false);
    assert.equal(respawned.targets.has(KEY), true);
    for (const target of respawned.targets.values()) if (target.pendingRestartTimer) clearTimeout(target.pendingRestartTimer);
    for (const target of monitor.targets.values()) if (target.pendingRestartTimer) clearTimeout(target.pendingRestartTimer);
});

test('watchdog (M-71): a pinned agent beside a planted folder is watched from its pin, not stopped', () => {
    resetWorkspace();
    plantNamedFolder();
    const monitor = createContainerMonitor({ terminalLedgerFile: path.join(ploinkyDir, 'running', 'pinned-ledger.json') });
    syncManagedContainers(monitor);
    assert.equal(monitor.terminalLedger.has(KEY), false);
    assert.equal(monitor.targets.has(KEY), true);
    assert.equal(monitor.targets.get(KEY).manifestPath, path.join(managedRepo, 'worker', 'manifest.json'));
    for (const target of monitor.targets.values()) if (target.pendingRestartTimer) clearTimeout(target.pendingRestartTimer);
});

test('status prints the plain reason for an agent that will not start, and a contested pinned repository', () => {
    resetWorkspace({ pinned: false, legacyBinds: [{ source: path.join(managedRepo, 'worker'), target: '/code' }] });
    const quiet = [];
    assert.deepEqual(printAgentSourceStatus({ log: (line) => quiet.push(line) }), []);
    assert.deepEqual(quiet, []);
    plantNamedFolder();
    const lines = [];
    const problems = printAgentSourceStatus({ log: (line) => lines.push(line) });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, pin.AGENT_SOURCE_CHANGED);
    assert.match(lines.join('\n'), /demo\/worker.*will not start.*ploinky enable agent demo\/worker/s);

    resetWorkspace();
    plantNamedFolder();
    const contested = [];
    const result = printAgentSourceStatus({ log: (line) => contested.push(line) });
    assert.equal(result.length, 0);
    assert.match(contested.join('\n'), /demo.*contested.*keep starting from their pinned folder.*'demo' now also claims it/s);
});

test('update repo acts on the pinned folder, and refuses when pins disagree', () => {
    resetWorkspace();
    // The pinned folder is a workspace folder that is not a Git checkout;
    // the name now resolves to the managed copy.
    const pinnedRoot = path.join(workspace, 'pinned-demo');
    agentDir(pinnedRoot);
    const agents = registry();
    agents[KEY].sourceIdentity = { repoName: 'demo', origin: '', realpath: pinnedRoot };
    writeJson(path.join(ploinkyDir, 'agents.json'), agents);
    assert.equal(freshAgentRepositoryPath('demo'), managedRepo);
    assert.equal(resolveAgentRepositoryPath('demo'), pinnedRoot, 'launches resolve to the pin');
    const record = updateRegisteredRepository('demo', { stdio: 'ignore' });
    assert.match(JSON.stringify(record), /pinned-demo/);
    assert.doesNotMatch(JSON.stringify(record), /\.ploinky\/repos\/demo/);
    // The update graph names the same folder.
    const graph = readUpdateGraph({ workspaceRoot: workspace, readRegistry: () => registry() });
    assert.equal(graph.repositoryPaths.has(pinnedRoot), true, [...graph.repositoryPaths].join(','));

    agents.demo_other = { ...agents[KEY], agentName: 'other', sourceIdentity: { repoName: 'demo', origin: '', realpath: managedRepo } };
    writeJson(path.join(ploinkyDir, 'agents.json'), agents);
    assert.throws(() => updateRegisteredRepository('demo', { stdio: 'ignore' }), /pinned to different folders/);
});

test('the first-enable report names the source, its origin and how it was chosen', () => {
    resetWorkspace();
    const managed = pin.sourcePinReport({ repoName: 'demo', agentName: 'worker',
        pin: { repoName: 'demo', origin: 'github.com/example/demo', realpath: managedRepo } });
    assert.match(managed, /source \.ploinky\/repos\/demo \(Git origin github\.com\/example\/demo\), chosen as the installed copy/);
    const scanned = pin.sourcePinReport({ repoName: 'demo', agentName: 'worker',
        pin: { repoName: 'demo', origin: 'github.com/example/demo', realpath: path.join(workspace, 'checkout') } });
    assert.match(scanned, /source checkout .*origin scan/);
    assert.match(scanned, /review its contents/);
    assert.equal(pin.sourcePinReport({ repoName: 'demo', agentName: 'worker',
        pin: { repoName: 'demo', origin: '', realpath: managedRepo }, previousPin: { repoName: 'demo', origin: '', realpath: managedRepo } }), '');
});

// ---- M-71: link-install checkouts are pinned at the first launch ----

const LIB_URL = 'https://github.com/example/Library.git';

function linkFixture() {
    resetWorkspace();
    const calls = [];
    const checkout = (name, origin = LIB_URL) => {
        const directory = path.join(workspace, name);
        fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
        fs.writeFileSync(path.join(directory, '.git', 'origin'), origin);
        return directory;
    };
    const execFile = (command, args) => {
        calls.push(args);
        if (args.includes('clone')) throw new Error('clone must not run');
        return fs.readFileSync(path.join(args[1], '.git', 'origin'), 'utf8');
    };
    return { calls, checkout, options: { workspaceRoot: workspace, execFile, create: true } };
}

test('M-71 link pins: the first launch records { name, origin, realpath }; later launches mount exactly that folder without a search', () => {
    const f = linkFixture();
    const real = f.checkout('lib-checkout');
    const manifest = { 'link-install': [LIB_URL] };
    const first = prepareLinkedRepositories(manifest, f.options);
    const pins = linkedRepositoryPins(manifest, first);
    assert.deepEqual(pins, [{ name: 'Library', origin: 'github.com/example/library', realpath: real }]);
    // A planted folder with the registered origin appears: unpinned resolution now fails as ambiguous...
    f.checkout('planted');
    assert.throws(() => prepareLinkedRepositories(manifest, f.options), /'lib-checkout' and 'planted' both have its Git origin/);
    // ...but the pinned launch mounts the recorded folder and never the plant.
    f.calls.length = 0;
    const [mount] = prepareLinkedRepositories(manifest, { ...f.options, pinned: pins });
    assert.equal(mount.source, real);
    assert.equal(mount.link, 'linked/Library');
    assert.equal(f.calls.some((args) => String(args[1] || '').includes('planted')), false, 'the plant is never read');
});

test('M-71 link pins: a missing, replaced, re-pointed or redeclared checkout refuses and never substitutes or clones', () => {
    const f = linkFixture();
    const real = f.checkout('lib-checkout');
    const manifest = { 'link-install': [LIB_URL] };
    const pins = linkedRepositoryPins(manifest, prepareLinkedRepositories(manifest, f.options));
    f.checkout('planted');
    const refused = (options, pattern) => assert.throws(() => prepareLinkedRepositories(options.manifest || manifest, { ...f.options, pinned: options.pins || pins }),
        (error) => error.code === pin.AGENT_SOURCE_CHANGED && pattern.test(error.message) && /does not substitute another checkout/.test(error.message));
    fs.writeFileSync(path.join(real, '.git', 'origin'), 'https://github.com/evil/Library.git');
    refused({}, /Git origin is no longer the declared repository/);
    fs.writeFileSync(path.join(real, '.git', 'origin'), LIB_URL);
    refused({ manifest: { 'link-install': ['https://github.com/other/Library.git'] } }, /declares a different repository/);
    refused({ pins: [{ name: 'Library', origin: 'x' }] }, /malformed/);
    fs.rmSync(real, { recursive: true, force: true });
    refused({}, /was recorded at lib-checkout .* no longer exists/);
    assert.equal(f.calls.some((args) => args.includes('clone')), false);
    fs.symlinkSync(path.join(workspace, 'planted'), real);
    refused({}, /was replaced/);
});

test('watchdog: a pinned folder that is gone is a plain source refusal, logged once, never a restart', () => {
    resetWorkspace();
    fs.rmSync(managedRepo, { recursive: true, force: true });
    const events = [];
    const monitor = createContainerMonitor({ terminalLedgerFile: path.join(ploinkyDir, 'running', 'gone-ledger.json'),
        log: (level, event, data) => events.push({ event, data }) });
    syncManagedContainers(monitor);
    syncManagedContainers(monitor);
    assert.equal(monitor.targets.size, 0);
    assert.equal(monitor.terminalLedger.get(KEY)?.code, pin.AGENT_SOURCE_CHANGED);
    const logged = events.filter(({ event }) => event === 'container_source_changed');
    assert.equal(logged.length, 1);
    assert.match(logged[0].data.message, /was enabled from \.ploinky\/repos\/demo, which no longer exists/);
    assert.equal(events.some(({ event }) => event === 'container_manifest_missing'), false);
});

test('pins of one repository that disagree leave only that repository unresolved', () => {
    resetWorkspace();
    const other = agentDir(path.join(workspace, 'elsewhere'), 'other');
    const agents = registry();
    agents.second = { ...agents[KEY], agentName: 'other', sourceIdentity: pin.agentSourceIdentity({ repoName: 'demo', agentPath: other, originOf: () => '' }) };
    writeJson(path.join(ploinkyDir, 'agents.json'), agents);
    assert.throws(() => resolveAgentRepositoryPath('demo'), (error) => error.code === REPOSITORY_AMBIGUOUS
        && /pinned to different folders/.test(error.message));
    const monitor = createContainerMonitor({ terminalLedgerFile: path.join(ploinkyDir, 'running', 'split-ledger.json') });
    assert.doesNotThrow(() => syncManagedContainers(monitor), 'the watchdog keeps syncing other agents');
    assert.equal(monitor.terminalLedger.get(KEY)?.code, REPOSITORY_AMBIGUOUS);
});

test('N1b: pins of one repository at two folders that both exist make planning refuse, naming both', () => {
    resetWorkspace();
    const planted = plantNamedFolder();
    const agents = registry();
    agents.second = { ...agents[KEY], agentName: 'worker2', sourceIdentity: pin.agentSourceIdentity({ repoName: 'demo', agentPath: planted, originOf: () => '' }) };
    writeJson(path.join(ploinkyDir, 'agents.json'), agents);
    for (const ref of ['demo/worker', 'worker']) {
        assert.throws(() => findAgent(ref, { planning: true }), (error) => error.code === REPOSITORY_AMBIGUOUS
            && /pinned to different existing folders \('\.ploinky\/repos\/demo' and 'demo'\)/.test(error.message), ref);
    }
});
