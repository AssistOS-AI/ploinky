// Run with local rootless Podman on Linux or a local macOS Podman machine.
// PLOINKY_BOX_CANDIDATE_DIGEST selects the cached Box. The normal in-Box
// launch pulls the pinned Router authority helper, also used as the fixture image.
// Each command/state gets its own disposable Box, Router and nested store.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const file = 'tests/integration/canary/workspace-lifecycle.mjs';
const states = ['split', 'tripped', 'paused', 'withdrawn'];
const commands = ['stop', 'restart', 'shutdown', 'destroy', 'clean', 'update', 'start', 'disable'];
const ref = 'fixture/subject';
const json = target => JSON.parse(fs.readFileSync(target, 'utf8'));
const write = (target, value) => fs.writeFileSync(target, JSON.stringify(value));

// S2's launcher is not required. This fixture delivers S4 events to the real
// Router process and reads its resulting state without issuing a lifecycle command.
async function configureRouter() {
    const request = path.join(process.env.PLOINKY_WORKSPACE_ROOT, 'fixture-signal.json');
    const timer = setInterval(async () => {
        if (!fs.existsSync(request)) return;
        clearInterval(timer);
        const { state, config } = json(request);
        fs.unlinkSync(request);
        const { canarySignals, observeCanarySnapshot } = await import('../../../cli/server/canary/routerSignals.js');
        if (observeCanarySnapshot) {
            const { loadActiveEdgeRoutingGeneration } = await import('../../../cli/sandbox/edgeGeneration.js');
            observeCanarySnapshot(loadActiveEdgeRoutingGeneration().generation);
        }
        if (state === 'paused' || state === 'withdrawn') {
            canarySignals.routerStarted({ [config.routeKey]: { canary: config } });
        } else {
            const row = canarySignals.status().rollouts.find(r => r.rolloutId === config.rolloutId);
            if (!row) canarySignals.startRollout(config);
            else if (row.state === 'paused') canarySignals.resume(config.routeKey, config.rolloutId);
            if (state === 'tripped') canarySignals.recordProbe(config.routeKey, config.rolloutId, { running: false });
        }
        write(request + '.done', canarySignals.status().rollouts.find(r => r.rolloutId === config.rolloutId));
    }, 50);
    timer.unref();
}

async function exercise(workspace, command, state, token) {
    assert.equal(fs.readFileSync('/etc/ploinky-box', 'utf8'), 'assistos/ploinky-box\n');
    assert.equal(fs.realpathSync(workspace), process.env.PLOINKY_WORKSPACE_ROOT);
    assert.equal(fs.readFileSync(path.join(workspace, 'fixture-owner'), 'utf8'), token);
    assert.ok(commands.includes(command) && states.includes(state));
    process.chdir(workspace);
    Object.assign(process.env, {
        GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', PLOINKY_ROUTER_HOST_PORT: '19826', PLOINKY_MEDIA_HOST_PORT: '19827',
    });
    const run = (program, args, extra = {}) => execFileSync(program, args, {
        cwd: workspace, encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...extra },
    }).trim();
    const podman = (...args) => run('podman', ['--remote=false', ...args]);
    assert.equal(podman('ps', '-aq'), '', 'fixture must start with an empty nested container store');
    const { ROUTER_AUTHORITY_HELPER_IMAGE } = await import('../../../cli/sandbox/routerAuthorityAttestation.js');
    const git = (dir, ...args) => run('git', [
        '-C', dir, '-c', 'user.name=Canary Fixture', '-c', 'user.email=fixture@example.invalid', ...args,
    ]);
    const cli = (...args) => run('/opt/ploinky/bin/ploinky-local', args, {
        NODE_OPTIONS: '--import=' + import.meta.url,
    });
    const repos = path.join(workspace, '.ploinky', 'repos');
    fs.mkdirSync(repos, { recursive: true });
    const { getDefaultBootRepos } = await import('../../../cli/utils/repos.js');
    for (const { name } of getDefaultBootRepos()) fs.mkdirSync(path.join(repos, name), { recursive: true });
    if (command === 'update') {
        // `update repo` also refreshes the default skills from these sources.
        // Only file-protocol git is allowed here, so give them local stand-ins,
        // as the update unit tests do.
        for (const name of ['AchillesCopilotBasicSkills', 'DocumentationSkills', 'PloinkySkills']) {
            const seed = path.join(workspace, '.fixture', 'skills', name);
            fs.mkdirSync(path.join(seed, 'skills', name + '-skill'), { recursive: true });
            fs.writeFileSync(path.join(seed, 'skills', name + '-skill', 'SKILL.md'), '# ' + name + '\n');
            git(seed, 'init', '-q', '-b', 'main');
            git(seed, 'add', '.');
            git(seed, 'commit', '-qm', 'Default skills stand-in');
            run('git', ['clone', '-q', seed, path.join(repos, name)]);
        }
    }
    // Keep the local origin outside workspace repository discovery.
    const origin = path.join(workspace, '.fixture', 'origin');
    fs.mkdirSync(origin, { recursive: true });
    git(origin, 'init', '-q', '-b', 'main');
    for (const agent of ['gate', 'subject']) {
        const dir = path.join(origin, agent);
        fs.mkdirSync(dir);
        write(path.join(dir, 'manifest.json'), {
            container: ROUTER_AUTHORITY_HELPER_IMAGE, start: 'node /code/serve.cjs', readiness: { protocol: 'tcp' },
            ...(agent === 'gate' ? { enable: ['subject'] } : {}),
            profiles: { default: { openPorts: [`127.0.0.1:${agent === 'gate' ? 19081 : 19082}:7000`] } },
        });
        fs.writeFileSync(path.join(dir, 'serve.cjs'),
            "const marker = require('node:fs').readFileSync('/code/revision', 'utf8');\n" +
            "require('node:http').createServer((q, r) => r.end(marker)).listen(7000, '0.0.0.0');\n");
        fs.writeFileSync(path.join(dir, 'revision'), 'predecessor');
    }
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'Predecessor fixture');
    const oldCommit = git(origin, 'rev-parse', 'HEAD');
    const checkout = path.join(repos, 'fixture');
    cli('install', 'repo', origin, 'fixture');
    git(origin, 'switch', '-qc', 'candidate');
    fs.writeFileSync(path.join(origin, 'subject', 'revision'), 'candidate');
    git(origin, 'commit', '-qam', 'Candidate fixture');
    const canaryCommit = git(origin, 'rev-parse', 'HEAD');
    cli('start', 'fixture/gate', '8080');
    const { normalizeImageId } = await import('../../../cli/sandbox/docker/runtimeImageIdentity.js');
    const imageId = 'sha256:' + normalizeImageId(podman('image', 'inspect', '--format', '{{.Id}}', ROUTER_AUTHORITY_HELPER_IMAGE));
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    const registry = path.join(workspace, '.ploinky/agents.json');
    const routingFile = path.join(workspace, '.ploinky/routing.json');
    const routing = json(routingFile);
    const [routeKey, route] = Object.entries(routing.routes)
        .find(([, r]) => r.agent === 'subject' && r.repo === 'fixture');
    const agents = json(registry);
    const primary = agents[route.container];
    const oldID = primary.containerId;
    const response = id => podman('exec', id, 'node', '--input-type=module', '-e', `
        const deadline = Date.now() + 5_000;
        for (;;) {
            try {
                const response = await fetch('http://127.0.0.1:7000', { signal: AbortSignal.timeout(1000) });
                if (!response.ok) throw new Error('fixture HTTP ' + response.status);
                process.stdout.write(await response.text());
                break;
            } catch (error) {
                if (error.cause?.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }`);
    assert.equal(response(oldID), 'predecessor');
    const rolloutId = randomUUID();
    const canaryName = route.container + '__canary';
    const codePath = `.ploinky/canary/${routeKey}/${canaryCommit}`;
    const exported = path.join(workspace, codePath);
    fs.cpSync(path.join(origin, 'subject'), exported, { recursive: true });
    git(origin, 'switch', '-q', 'main');
    const home = path.join(workspace, '.data/agents', primary.alias || primary.agentName);
    const queue = path.join(home, '.tasksQueue.canary.' + rolloutId);
    write(queue, []);
    const record = {
        type: 'agent', runtime: 'podman', agentName: primary.agentName, repoName: primary.repoName,
        instanceId: randomUUID(), enableGeneration: randomUUID(), launchId: randomUUID(), canaryOf: routeKey,
        config: { binds: [{ source: home, target: '/root', ro: false }] },
    };
    const { deriveAgentPrincipalId } = await import('../../../cli/utils/security/agentIdentity.js');
    const principal = 'PLOINKY_AGENT_PRINCIPAL=' + deriveAgentPrincipalId(primary.repoName, primary.agentName);
    const { NETWORK_LABELS } = await import('../../../cli/sandbox/networkIdentity.js');
    const labels = JSON.parse(podman('inspect', '--format', '{{json .Config.Labels}}', oldID));
    const flags = [];
    for (const label of Object.values(NETWORK_LABELS)) {
        if (label === NETWORK_LABELS.instanceId) labels[label] = record.instanceId;
        if (label === NETWORK_LABELS.enableGeneration) labels[label] = record.enableGeneration;
        if (labels[label] !== undefined) flags.push('--label', label + '=' + labels[label]);
    }
    record.containerId = podman('run', '-d', '--pull=never', '--init', '--name', canaryName,
        ...flags, '-e', 'PLOINKY_CANARY=1', '-e', 'PLOINKY_CANARY_ROLLOUT=' + rolloutId,
        '-e', principal, '-e', 'PLOINKY_LAUNCH_ID=' + record.launchId, '-v', exported + ':/code:ro',
        '-v', home + ':/root', imageId, 'node', '/code/serve.cjs');
    assert.match(record.containerId, /^[a-f0-9]{64}$/);
    assert.equal(response(record.containerId), 'candidate');
    const tree = git(origin, 'rev-parse', canaryCommit + ':subject');
    const field = {
        rolloutId, container: canaryName, commit: canaryCommit, codePath,
        codeDigest: 'sha256:' + createHash('sha256').update(tree).digest('hex'),
        share: 10, testAccounts: [], salt: randomUUID(), splitStartedAt: new Date().toISOString(),
        mode: state === 'withdrawn' ? state : 'split', probe: { port: 7000, path: '/', status: 200 },
        thresholds: {},
    };
    const { openReceipt, readReceipt } = await import('../../../cli/sandbox/canary/receipt.mjs');
    openReceipt({ routeKey, rolloutId, fields: {
        step: 'published', oldCommit, canaryCommit, repoName: route.repo, agentName: route.agent,
        oldContainerName: route.container, oldContainerId: oldID, oldLaunchId: primary.launchId,
        oldInstanceId: primary.instanceId, oldEnableGeneration: primary.enableGeneration, canaryContainerName: canaryName,
        canaryInstanceId: record.instanceId, canaryEnableGeneration: record.enableGeneration,
        canaryContainerId: record.containerId, canaryLaunchId: record.launchId,
    } }, { workspaceRoot: workspace });
    const edge = await import('../../../cli/sandbox/edgeGeneration.js');
    agents[canaryName] = record;
    route.canary = field;
    edge.withEdgeGenerationApplyLock(applyLockCapability => {
        const opts = {
            workspaceRoot: workspace, routing, agents, applyLockCapability, reason: 'canary-lifecycle-fixture',
        };
        const prepared = edge.prepareAdditiveEdgeRoutingGeneration(opts);
        edge.commitAdditiveEdgeRoutingGeneration(prepared.preparationLease, opts);
    }, { workspaceRoot: workspace });
    const signalFile = path.join(workspace, 'fixture-signal.json');
    const config = { routeKey, rolloutId, share: field.share, commit: canaryCommit, mode: field.mode,
        container: canaryName, containerId: record.containerId };
    if (state === 'tripped') podman('stop', '--time', '3', record.containerId);
    write(signalFile + '.tmp', { config, state });
    fs.renameSync(signalFile + '.tmp', signalFile);
    for (let i = 0; i < 100 && !fs.existsSync(signalFile + '.done'); ++i) await delay(100);
    const row = json(signalFile + '.done');
    assert.equal(row.rolloutId, rolloutId);
    assert.equal(row.state, state);

    if (command === 'start') {
        // Model loss of the running processes, keeping all durable rollout
        // evidence and stopped IDs. A graceful "stop" would itself reconcile.
        const { killRouterIfRunning } = await import('../../../cli/commands/sessionControl.js');
        killRouterIfRunning();
        for (const entry of Object.values(agents).filter(a => a?.runtime === 'podman' && a.containerId)) {
            podman('stop', '--time', '3', entry.containerId);
        }
        assert.equal(podman('inspect', '--format', '{{.State.Running}}', record.containerId), 'false',
            'cold start requires the recorded canary to be stopped');
    }
    assert.ok(podman('ps', '-a', '--no-trunc', '--format', '{{.ID}}').split('\n').includes(record.containerId));
    cli(command, ...(command === 'disable' ? ['agent', ref] : command === 'update' ? ['repo', 'fixture'] : []));
    const all = podman('ps', '-a', '--no-trunc', '--format', '{{.ID}}').split('\n');
    assert.ok(!all.includes(record.containerId), 'recorded canary still exists, running or stopped');
    const remaining = json(registry);
    assert.equal(remaining[canaryName], undefined);
    assert.ok(!Object.values(remaining).some(agent => Object.hasOwn(agent, 'canaryOf')));
    assert.ok(!Object.values(json(routingFile).routes).some(r => Object.hasOwn(r, 'canary')));
    if (edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector.state === 'active') {
        const { generation } = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
        assert.equal(generation.agents[canaryName], undefined);
        assert.ok(!Object.values(generation.routing.routes).some(r => Object.hasOwn(r, 'canary')));
    }
    assert.equal(fs.existsSync(exported), false);
    assert.equal(fs.existsSync(queue), false);
    const receipt = readReceipt(routeKey, { workspaceRoot: workspace });
    assert.equal(receipt.rolloutId, rolloutId);
    assert.equal(receipt.terminal.reason, command);
    assert.equal(receipt.terminal.outcome, 'aborted');
    assert.equal(receipt.intent, null);
    const principalMatch = '{{range .Config.Env}}{{if eq . "' + principal + '"}}subject{{end}}{{end}}';
    const live = podman('ps', '--no-trunc', '--format', '{{.ID}}').split('\n').filter(id =>
        id && podman('inspect', '--format', principalMatch, id) === 'subject');
    if (['start', 'restart', 'update'].includes(command)) {
        assert.equal(git(checkout, 'rev-parse', 'HEAD'), oldCommit);
        assert.equal(live.length, 1);
        assert.equal(response(live[0]), 'predecessor');
    } else {
        assert.deepEqual(live, []);
    }
}

async function main() {
    const test = (await import('node:test')).default;
    assert.ok(['linux', 'darwin'].includes(process.platform), 'requires local rootless Podman or a macOS Podman machine');
    assert.ok(!process.env.CONTAINER_HOST && !process.env.CONTAINER_CONNECTION, 'requires local Podman');
    const digest = process.env.PLOINKY_BOX_CANDIDATE_DIGEST || '';
    assert.match(digest, /^sha256:[a-f0-9]{64}$/, 'set PLOINKY_BOX_CANDIDATE_DIGEST to the cached Box digest');
    const { createPodmanHarness } = await import('../../e2e/ploinkyBox/nativeHelpers.mjs');
    const imageRef = 'docker.io/assistos/ploinky-box@' + digest;
    // On macOS the native runner uses the selected local Podman machine.
    // Verify the configured endpoint before contacting that engine.
    if (process.platform === 'darwin') {
        const connections = JSON.parse(execFileSync('podman', ['system', 'connection', 'list', '--format', 'json'], { encoding: 'utf8' }));
        const selected = connections.filter(connection => connection.Default);
        assert.equal(selected.length, 1, 'expected one default Podman machine connection');
        const endpoint = new URL(selected[0].URI);
        assert.ok(endpoint.protocol === 'unix:' || (endpoint.protocol === 'ssh:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)), 'requires a local Podman machine');
    }
    for (const command of commands) for (const state of states) {
        await test(command + ' from ' + state, async t => {
            const h = createPodmanHarness(t, imageRef);
            const token = randomUUID();
            fs.writeFileSync(path.join(h.workspace, 'fixture-owner'), token, { flag: 'wx' });
            const box = await h.supervisor.prepareBoxForCommand({
                imageRef, explicitPort: 19826, explicitMediaPort: 19827,
            });
            const result = h.runner.query('podman', [
                'exec', '--user', 'podman', '--workdir', h.workspace, box.containerId, 'node',
                '/opt/ploinky/' + file, '--case', h.workspace, command, state, token,
            ], { timeoutMs: 12 * 60_000 });
            assert.equal(result.ok, true, result.stderr);
        });
    }
}

if (process.argv[1]?.endsWith('/RoutingServer.js')) {
    await configureRouter();
} else if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    if (process.argv[2] === '--case') await exercise(...process.argv.slice(3));
    else await main();
}
