// M-68/M-71 source pin cases that depend on Git origins (real `git init`, so
// this file runs outside a runner that blocks child processes). A registered
// repository `suite` is supplied by the workspace folder `products`, found by
// an origin scan, with two enabled agents (`coord` and `aide`, stand-ins for a
// coordinator agent and its worker); a second registered repository `other`
// is installed under .ploinky/repos.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-pin-git-')));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const previousCwd = process.cwd();
process.chdir(workspace);

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const pin = await import('../../cli/utils/agentSourcePin.mjs');
const { REPOSITORY_AMBIGUOUS } = await import('../../cli/utils/repositorySource.mjs');
const source = await import('../../cli/utils/agentRepositorySource.mjs');
const { findAgent } = await import('../../cli/utils/utils.js');
const { resolveWorkspaceDependencyGraph } = await import('../../cli/utils/workspaceDependencyGraph.js');
const { admitAgentServicePreflight } = await import('../../cli/sandbox/docker/agentServiceManager.js');
const { createContainerMonitor, syncManagedContainers } = await import('../../cli/server/containerMonitor.js');
const { getAgentContainerName } = await import('../../cli/sandbox/docker/common.js');
const { previewAgentEnable } = await import('../../cli/utils/agents.js');
const { listRepositorySources } = await import('../../cli/utils/repos.js');
const { prepareDefaultBootRepositories } = await import('../../cli/commands/ploinkyboot.js');

const ploinkyDir = path.join(workspace, '.ploinky');
const SUITE_URL = 'https://example.com/team/suite.git';
const OTHER_URL = 'https://example.com/team/other.git';
const MANIFEST = { container: 'node:20-alpine' };
const SUITE_KEY = getAgentContainerName('coord', 'suite');
const OTHER_KEY = getAgentContainerName('helper', 'other');
const AIDE_KEY = getAgentContainerName('aide', 'suite');

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

function checkout(directory, agent, origin) {
    writeJson(path.join(directory, agent, 'manifest.json'), MANIFEST);
    if (origin) {
        execFileSync('git', ['init', '-q', directory]);
        execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', origin]);
    }
    return path.join(directory, agent);
}

function resetWorkspace({ enabled = true } = {}) {
    for (const entry of fs.readdirSync(workspace)) fs.rmSync(path.join(workspace, entry), { recursive: true, force: true });
    writeJson(path.join(ploinkyDir, 'repo_sources.json'), { suite: { url: SUITE_URL }, other: { url: OTHER_URL } });
    const coord = checkout(path.join(workspace, 'products'), 'coord', SUITE_URL);
    const aide = path.join(workspace, 'products', 'aide');
    writeJson(path.join(aide, 'manifest.json'), MANIFEST);
    const helper = checkout(path.join(ploinkyDir, 'repos', 'other'), 'helper', null);
    const suiteRecord = {
        type: 'agent', repoName: 'suite', agentName: 'coord', instanceId: 'i-suite', enableGeneration: 'g-suite', runtime: 'container',
        sourceIdentity: pin.agentSourceIdentity({ repoName: 'suite', agentPath: coord }),
    };
    const otherRecord = {
        type: 'agent', repoName: 'other', agentName: 'helper', instanceId: 'i-other', enableGeneration: 'g-other', runtime: 'container',
        sourceIdentity: pin.agentSourceIdentity({ repoName: 'other', agentPath: helper }),
    };
    const aideRecord = { ...suiteRecord, agentName: 'aide', instanceId: 'i-aide', enableGeneration: 'g-aide' };
    writeJson(path.join(ploinkyDir, 'agents.json'), enabled
        ? { [SUITE_KEY]: suiteRecord, [AIDE_KEY]: aideRecord, [OTHER_KEY]: otherRecord }
        : { [OTHER_KEY]: otherRecord });
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        routes: {
            ...(enabled ? {
                coord: { repo: 'suite', agent: 'coord', container: SUITE_KEY, hostPath: coord },
                aide: { repo: 'suite', agent: 'aide', container: AIDE_KEY, hostPath: aide },
            } : {}),
            helper: { repo: 'other', agent: 'helper', container: OTHER_KEY, hostPath: helper },
        },
    });
    return { coord, aide, helper, suiteRecord };
}

function registry() {
    return JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8'));
}

test('case (b): an origin-scan source is pinned with its origin, and the first enable says it came from an origin scan', () => {
    const { coord, suiteRecord } = resetWorkspace();
    assert.equal(findAgent('suite/coord').manifestPath, path.join(coord, 'manifest.json'));
    assert.deepEqual(suiteRecord.sourceIdentity, { repoName: 'suite', origin: 'example.com/team/suite', realpath: path.join(workspace, 'products') });
    const report = pin.sourcePinReport({ repoName: 'suite', agentName: 'coord', pin: suiteRecord.sourceIdentity });
    assert.match(report, /source products \(Git origin example\.com\/team\/suite\), chosen as a workspace folder found by an origin scan/);
});

test('M-71: a planted folder named after the repository with the registered origin: enabled agents start from their pins; planning refuses', () => {
    const { coord } = resetWorkspace();
    const before = fs.readFileSync(path.join(ploinkyDir, 'agents.json'));
    checkout(path.join(workspace, 'suite'), 'coord', SUITE_URL);
    assert.equal(findAgent('suite/coord').manifestPath, path.join(coord, 'manifest.json'));
    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'coord', registry: registry() });
    assert.equal([...graph.nodes.values()][0].agentPath, coord);
    assert.throws(() => findAgent('suite/coord', { planning: true }), (error) => error.code === REPOSITORY_AMBIGUOUS
        && /enabled from 'products', but the folder 'suite' now also claims it/.test(error.message));
    assert.deepEqual(fs.readFileSync(path.join(ploinkyDir, 'agents.json')), before);
});

test('M-71: a planted folder with the registered origin: both enabled agents still start from their pins; a bare-name re-enable refuses naming the plant', () => {
    const { coord, aide, helper } = resetWorkspace();
    const before = fs.readFileSync(path.join(ploinkyDir, 'agents.json'));
    checkout(path.join(workspace, 'planted'), 'coord', SUITE_URL);

    // Launch paths keep working from the pins: graph (qualified and bare),
    // reverse name, preflight and the watchdog.
    assert.deepEqual(source.listAgentRepositoryNames(), ['other', 'suite']);
    for (const [ref, expected] of [['suite/coord', coord], ['coord', coord], ['suite/aide', aide], ['aide', aide]]) {
        const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: ref, registry: registry() });
        assert.equal([...graph.nodes.values()][0].agentPath, expected, ref);
    }
    assert.equal(source.resolveAgentRepositoryName(coord), 'suite');
    assert.equal(source.resolveAgentRepositoryName(helper), 'other');
    for (const [agent, agentPath] of [['coord', coord], ['aide', aide]]) {
        let error = null;
        try { admitAgentServicePreflight(agent, MANIFEST, agentPath, {}); } catch (caught) { error = caught; }
        assert.ok(![pin.AGENT_SOURCE_CHANGED, REPOSITORY_AMBIGUOUS].includes(error?.code), `${agent}: ${error?.message}`);
    }
    const monitor = createContainerMonitor({ terminalLedgerFile: path.join(ploinkyDir, 'running', 'pinned-ledger.json') });
    syncManagedContainers(monitor);
    assert.equal(monitor.targets.has(SUITE_KEY) && monitor.targets.has(AIDE_KEY) && monitor.targets.has(OTHER_KEY), true);
    assert.equal(monitor.terminalLedger.size, 0);
    for (const target of monitor.targets.values()) if (target.pendingRestartTimer) clearTimeout(target.pendingRestartTimer);

    // New enables, re-enables and bare-name planning refuse and name the plant.
    for (const attempt of [
        () => findAgent('coord', { planning: true }),
        () => findAgent('suite/aide', { planning: true }),
        () => previewAgentEnable({ agentName: 'coord' }),
    ]) {
        assert.throws(attempt, /Repository 'suite' is unresolved: the workspace folders 'planted' and 'products' both have its Git origin/);
    }
    assert.deepEqual(fs.readFileSync(path.join(ploinkyDir, 'agents.json')), before, 'enabled agents keep their pins');
});

test('case (c) without enabled agents: the contested repository alone is unresolved; every other repository still resolves', () => {
    const { coord, helper } = resetWorkspace({ enabled: false });
    checkout(path.join(workspace, 'planted'), 'coord', SUITE_URL);
    assert.deepEqual(source.listAgentRepositoryNames(), ['other']);
    assert.deepEqual(source.unresolvedAgentRepositories().map(({ name }) => name), ['suite']);
    assert.equal(source.resolveAgentRepositoryName(helper), 'other');
    assert.equal(findAgent('helper').repo, 'other');
    for (const attempt of [
        () => source.resolveAgentRepositoryPath('suite'),
        () => findAgent('suite/coord'),
        () => findAgent('coord'),
        () => source.resolveAgentRepositoryName(coord),
    ]) {
        assert.throws(attempt, (error) => error.code === REPOSITORY_AMBIGUOUS);
    }
    fs.mkdirSync(path.join(ploinkyDir, 'repos', 'suite', 'coord'), { recursive: true });
    assert.throws(() => source.resolveAgentRepositoryPath('suite'), { code: REPOSITORY_AMBIGUOUS }, 'never a fallback copy');
});

test('F1: a bare name never falls through to another folder while an unresolved repository holds that agent', () => {
    // No enabled agent yet: products and planted carry the origin; evil is a
    // robot-made folder with coord/manifest.json and no registered origin.
    resetWorkspace({ enabled: false });
    writeJson(path.join(ploinkyDir, 'enabled_repos.json'), ['suite']);
    checkout(path.join(workspace, 'planted'), 'x', SUITE_URL);
    checkout(path.join(workspace, 'evil'), 'coord', null);
    for (const attempt of [
        () => findAgent('coord'),
        () => findAgent('coord', { planning: true }),
        () => resolveWorkspaceDependencyGraph({ staticAgentRef: 'coord', registry: {} }),
        () => previewAgentEnable({ agentName: 'coord' }),
    ]) {
        assert.throws(attempt, (error) => error.code === REPOSITORY_AMBIGUOUS && !/evil/.test(error.message));
    }
});

test('F1 with a pinned record: a bare re-enable refuses; the launch graph keeps the record and its pin', () => {
    const { coord } = resetWorkspace();
    writeJson(path.join(ploinkyDir, 'enabled_repos.json'), ['suite']);
    checkout(path.join(workspace, 'planted'), 'x', SUITE_URL);
    checkout(path.join(workspace, 'evil'), 'coord', null);
    assert.throws(() => previewAgentEnable({ agentName: 'coord' }), { code: REPOSITORY_AMBIGUOUS });
    assert.throws(() => findAgent('coord', { planning: true }), /'planted' and 'products'/);
    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'coord', registry: registry() });
    assert.equal([...graph.nodes.values()][0].agentPath, coord);
});

test('F4: the repository listing and the boot loop report an unresolved repository and keep the others', () => {
    resetWorkspace({ enabled: false });
    checkout(path.join(workspace, 'planted'), 'coord', SUITE_URL);
    const listed = listRepositorySources();
    const suite = listed.find((entry) => entry.name === 'suite');
    assert.equal(suite.origin, 'unresolved');
    assert.deepEqual(suite.candidates, ['planted', 'products']);
    assert.ok(listed.some((entry) => entry.name === 'other'));
    const errors = [];
    const prepared = prepareDefaultBootRepositories({
        bootRepos: [{ name: 'suite', url: SUITE_URL }, { name: 'other', url: OTHER_URL }],
        log: () => {}, error: (line) => errors.push(line), stdio: 'ignore',
    });
    assert.deepEqual(prepared, [{ name: 'suite', action: 'unresolved', branch: null }]);
    assert.match(errors.join('\n'), /Default 'suite' repository is unresolved/);
});

test('N1: after the pinned checkout is moved, a bare enable picks the moved checkout (or refuses), never a robot folder; launches refuse plainly', () => {
    resetWorkspace();
    writeJson(path.join(ploinkyDir, 'enabled_repos.json'), ['suite']);
    const routing = JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8'));
    writeJson(path.join(ploinkyDir, 'routing.json'), { ...routing, port: 8080 });
    fs.renameSync(path.join(workspace, 'products'), path.join(workspace, 'products2'));
    checkout(path.join(workspace, 'evil'), 'coord', null);
    const moved = path.join(workspace, 'products2', 'coord', 'manifest.json');
    // Planning: the moved checkout, found by its origin.
    assert.equal(findAgent('coord', { planning: true }).manifestPath, moved);
    assert.equal(findAgent('suite/coord', { planning: true }).manifestPath, moved);
    const { plan } = previewAgentEnable({ agentName: 'coord' });
    assert.equal(plan.repoName, 'suite');
    assert.equal(plan.record.sourceIdentity.realpath, path.join(workspace, 'products2'));
    // Launch: the gone pinned folder is a refusal naming the exact command, never skipped.
    for (const attempt of [
        () => findAgent('coord'),
        () => findAgent('suite/coord'),
        () => resolveWorkspaceDependencyGraph({ staticAgentRef: 'coord', registry: registry() }),
    ]) {
        assert.throws(attempt, (error) => error.code === pin.AGENT_SOURCE_CHANGED
            && /was enabled from 'products', which no longer exists/.test(error.message)
            && /'ploinky enable agent suite\/coord'/.test(error.message) && !/evil/.test(error.message));
    }
    // A second checkout with the origin makes the bare enable refuse on ambiguity instead.
    checkout(path.join(workspace, 'products3'), 'coord', SUITE_URL);
    assert.throws(() => findAgent('coord', { planning: true }), (error) => error.code === REPOSITORY_AMBIGUOUS && !/evil/.test(error.message));
    assert.throws(() => previewAgentEnable({ agentName: 'coord' }), { code: REPOSITORY_AMBIGUOUS });
});

test('N1b: a moved checkout part-way through re-enabling its agents: the rest re-enable to the new folder, a bare name never falls through', () => {
    resetWorkspace();
    writeJson(path.join(ploinkyDir, 'enabled_repos.json'), ['suite']);
    const routing = JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8'));
    writeJson(path.join(ploinkyDir, 'routing.json'), { ...routing, port: 8080 });
    fs.renameSync(path.join(workspace, 'products'), path.join(workspace, 'products2'));
    checkout(path.join(workspace, 'evil'), 'aide', null);
    const products2 = path.join(workspace, 'products2');
    // coord was enabled again after the move; aide is still pinned to the old folder.
    const agents = registry();
    agents[SUITE_KEY].sourceIdentity = { ...agents[SUITE_KEY].sourceIdentity, realpath: products2 };
    writeJson(path.join(ploinkyDir, 'agents.json'), agents);

    // Launches of the repository refuse until every agent is enabled again.
    assert.throws(() => findAgent('suite/aide'), (error) => error.code === REPOSITORY_AMBIGUOUS
        && /pinned to different folders/.test(error.message) && /ploinky enable agent suite\/<agent>/.test(error.message));
    // Planning: qualified and bare names re-enable to the moved checkout, never to evil.
    const moved = path.join(products2, 'aide', 'manifest.json');
    assert.equal(findAgent('suite/aide', { planning: true }).manifestPath, moved);
    assert.equal(findAgent('aide', { planning: true }).manifestPath, moved);
    const { plan } = previewAgentEnable({ agentName: 'aide' });
    assert.equal(plan.repoName, 'suite');
    assert.equal(plan.record.sourceIdentity.realpath, products2);

    // Re-enabling the last agent completes the move: launches resolve to products2.
    const completed = registry();
    completed[AIDE_KEY].sourceIdentity = plan.record.sourceIdentity;
    writeJson(path.join(ploinkyDir, 'agents.json'), completed);
    assert.equal(findAgent('suite/aide').manifestPath, moved);
    assert.equal(source.resolveAgentRepositoryPath('suite'), products2);

    // Two pinned folders that both still exist (same origin): planning refuses, naming both, never evil.
    writeJson(path.join(ploinkyDir, 'agents.json'), agents);
    checkout(path.join(workspace, 'products'), 'aide', SUITE_URL);
    for (const attempt of [() => findAgent('aide', { planning: true }), () => findAgent('suite/aide', { planning: true })]) {
        assert.throws(attempt, (error) => error.code === REPOSITORY_AMBIGUOUS
            && /'products' and 'products2'/.test(error.message) && !/evil/.test(error.message));
    }
});

test('the same folder with a different readable origin is a mismatch; an unreadable origin is not', () => {
    const { coord, suiteRecord } = resetWorkspace();
    pin.assertAgentSourcePin(suiteRecord, { repoName: 'suite', agentName: 'coord', agentPath: coord });
    execFileSync('git', ['-C', path.join(workspace, 'products'), 'remote', 'set-url', 'origin', 'https://example.com/elsewhere/suite.git']);
    assert.throws(() => pin.assertAgentSourcePin(suiteRecord, { repoName: 'suite', agentName: 'coord', agentPath: coord }),
        (error) => error.code === pin.AGENT_SOURCE_CHANGED && error.currentSource.origin === 'example.com/elsewhere/suite');
    assert.doesNotThrow(() => pin.assertAgentSourcePin(suiteRecord, { repoName: 'suite', agentName: 'coord', agentPath: coord, originOf: () => '' }));
});
