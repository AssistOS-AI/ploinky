import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import '../../helpers/agentlibTestContract.mjs';
import { copyRecord, fixtureWorkspace, rolloutId, routeKey, write, writeCanaryFixture } from './loopbackFixture.mjs';

test('WebChat split and all pin the selected TTY and sign only for its inspected launch', { timeout: 15_000 }, async t => {
    const root = fixtureWorkspace(t, 'canary-webchat-');
    const identities = {
        old: copyRecord('old', 0, 'launch-old', 18001),
        canary: copyRecord('canary', 1, 'launch-canary', 18002),
    };
    const { state, route } = writeCanaryFixture(root, identities);
    const manifest = { cli: 'node /code/chat.mjs', webchat: { forwardEnvelope: true } };
    const manifestPath = path.join(route.hostPath, 'manifest.json');
    write(manifestPath, manifest);
    fs.unlinkSync(path.join(root, route.canary.codePath, 'manifest.json'));
    const { NETWORK_LABELS: labels, workspaceNetworkIdentity } = await import('../../../cli/sandbox/networkIdentity.js');
    const { NETWORK_SCHEMA_VERSION } = await import('../../../cli/sandbox/networkContract.js');
    for (const [copy, r] of Object.entries(identities)) {
        write(path.join(root, r.containerId + '.json'), [{
            Id: r.containerId, Name: copy === 'old' ? route.container : route.canary.container, State: { Running: true },
            HostConfig: { Init: true }, Config: { Labels: {
                [labels.instanceId]: r.instanceId, [labels.enableGeneration]: r.enableGeneration,
                [labels.workspace]: workspaceNetworkIdentity(root).hash, [labels.schema]: NETWORK_SCHEMA_VERSION,
                [labels.managed]: '1', [labels.resource]: 'agent', [labels.contract]: 'a'.repeat(64),
            }, Env: ['PLOINKY_AGENT_ID=agent:fixture/service', 'PLOINKY_LAUNCH_ID=' + r.launchId] },
        }]);
    }
    const bin = path.join(root, 'bin');
    write(path.join(bin, 'package.json'), { type: 'commonjs' });
    const engine = path.join(bin, 'podman');
    write(engine, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.length === 3 && args[0] === 'container' && args[1] === 'inspect') {
    process.stdout.write(fs.readFileSync(args[2] + '.json'));
} else if (args[0] === 'exec') {
    const id = args.find(arg => /^[a-f0-9]{64}$/.test(arg));
    if (!id || !fs.existsSync(id + '.json')) process.exit(3);
    const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}));
    if (!args.at(-1).endsWith('; ' + (manifest.cli || '/Agent/default_cli.sh'))) process.exit(5);
    process.stdin.on('data', () => process.stdout.write('received-' + id + '\\n'));
} else process.exit(4);
`);
    fs.chmodSync(engine, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    t.after(() => { process.env.PATH = previousPath; });

    const edge = await import('../../../cli/sandbox/edgeGeneration.js');
    const publish = () => {
        write(path.join(state, 'routing.json'), { static: { agent: routeKey }, routes: { [routeKey]: route } });
        edge.applyEdgeRoutingGeneration({ workspaceRoot: root, publicationState: 'ready', reason: 'webchat-launch-test' });
        return edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: root }).generation;
    };
    route.canary.share = 10;
    let snapshot = publish();
    const { canarySignals: signals, observeCanarySnapshot } = await import('../../../cli/server/canary/routerSignals.js');
    signals.setProbe(null);
    observeCanarySnapshot(snapshot);
    assert.equal(signals.resume(routeKey, rolloutId), true);
    const { handleWebChat } = await import('../../../cli/server/handlers/webchat/index.js');
    const { disposeTab } = await import('../../../cli/server/handlers/webchat/runtimeState.js');
    const { resolveAuthContextForRoutePlan } = await import('../../../cli/server/authHandlers/authContext.js');
    const { resolveEdgeRoutePlan } = await import('../../../cli/server/edgeRoutePlan.js');
    const { verifyRouterRequestFromHeaders } = await import('../../../Agent/lib/invocationAuth.mjs');
    const { createMemoryReplayCache } = await import('../../../Agent/lib/jwtVerify.mjs');
    const { computeRchTool } = await import('../../../Agent/lib/requestHash.mjs');
    const { deriveAgentRequestSecret } = await import('../../../cli/utils/security/masterKey.js');
    const appState = { sessions: new Map(), runtimes: new Map() };
    const streams = [];
    t.after(() => {
        for (const req of streams) req.emit('close');
        for (const [key, tab] of appState.runtimes) disposeTab(tab, key, { runtimes: appState.runtimes });
    });
    const ordinaryWrites = [];
    const ordinaryFactory = { create() { return {
        onOutput() {}, onClose() {}, isAlive: () => true, write(data) { ordinaryWrites.push(data); return true; }, dispose() {},
    }; } };
    async function request(action, user, beforeBody) {
        const req = new EventEmitter();
        Object.assign(req, { url: '/webchat/' + action + '?agent=service&tabId=tab', method: action === 'stream' ? 'GET' : 'POST',
            headers: { host: 'localhost', cookie: 'webchat_sid=' + user }, authMode: 'sso', user: { id: user, roles: ['user'] } });
        const plan = resolveEdgeRoutePlan({ req });
        req.edgeAuthContext = resolveAuthContextForRoutePlan(new URL(req.url, 'http://localhost'), plan);
        assert.equal(req.edgeAuthContext.webchatBinding?.exactLaunch, route.canary ? true : undefined);
        const res = { writeHead(status) { this.status = status; }, write() { return true; }, end() {} };
        await handleWebChat(req, res, { getFactoryForCommands(commands) {
            assert.equal(route.canary, undefined, 'a split must use the selected physical TTY');
            return { ...commands, ttyFactory: ordinaryFactory };
        } }, appState);
        if (action === 'stream') streams.push(req);
        else if (!res.status) { req.emit('data', 'hello'); beforeBody?.(); req.emit('end'); }
        return res.status;
    }
    async function check(user, copy) {
        assert.equal(await request('stream', user), 200);
        const tab = [...appState.runtimes.values()].find(t => t.tty.verifiedLaunch.containerId === identities[copy].containerId);
        assert.ok(tab);
        const received = new Promise(resolve => {
            const detach = tab.tty.onOutput(text => {
                if (text.includes('received-' + identities[copy].containerId)) { detach(); resolve(); }
            });
        });
        let token;
        const writeInput = tab.tty.write;
        tab.tty.write = data => { token = JSON.parse(data).invocation.token; return writeInput(data); };
        try { assert.equal(await request('input', user), 204); } finally { tab.tty.write = writeInput; }
        await received;
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
        assert.equal(claims.launchId, identities[copy].launchId);
        const agent = 'agent:fixture/service';
        const surface = { method: 'POST', path: '/mcp', tool: '__webchat_message__' };
        const rch = computeRchTool({ ...surface, arguments: { surface: 'webchat', tabId: 'tab', pageInstanceId: '',
            text: 'hello', attachments: [], references: [], presentation: { visible: true } } });
        for (const [name, record] of Object.entries(identities)) {
            const verified = verifyRouterRequestFromHeaders({ authorization: 'Bearer ' + token }, {
                ...surface, rch, replayCache: createMemoryReplayCache(), env: { PLOINKY_AGENT_ID: agent,
                    PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(agent), PLOINKY_LAUNCH_ID: record.launchId } });
            assert.equal(verified.ok, name === copy);
        }
        return tab;
    }
    await check('reader', 'old');
    await check('tester', 'canary');
    const previousWire = process.env.PLOINKY_SECURE_WIRE;
    try {
        process.env.PLOINKY_SECURE_WIRE = 'off';
        assert.equal(await request('input', 'tester'), 503);
    } finally {
        if (previousWire === undefined) delete process.env.PLOINKY_SECURE_WIRE;
        else process.env.PLOINKY_SECURE_WIRE = previousWire;
    }
    write(manifestPath, { webchat: manifest.webchat });
    assert.equal(await request('stream', 'tester'), 503);
    for (const [key, tab] of appState.runtimes) disposeTab(tab, key, { runtimes: appState.runtimes });
    delete manifest.cli;
    snapshot = publish();
    observeCanarySnapshot(snapshot);
    const old = await check('reader', 'old');
    const canary = await check('tester', 'canary');
    assert.equal(await check('tester', 'canary'), canary);
    assert.equal(appState.runtimes.size, 2);

    const file = path.join(root, identities.canary.containerId + '.json');
    const content = fs.readFileSync(file, 'utf8');
    write(file, content.replace('PLOINKY_LAUNCH_ID=launch-canary', 'PLOINKY_LAUNCH_ID=stale'));
    assert.equal(await request('stream', 'tester'), 503);
    write(file, content.replace(identities.canary.instanceId, 'different-instance'));
    assert.equal(await request('stream', 'tester'), 503);
    write(file, content);
    write(manifestPath, { ...manifest, cli: '/Agent/default_cli.sh' });
    assert.equal(await request('stream', 'tester'), 503);
    write(manifestPath, manifest);
    signals.now = () => Date.now() + 86_400_001;
    const version = signals.routingState(routeKey, rolloutId).exposureVersion;
    assert.equal(signals.seal(routeKey, rolloutId, version), true);
    route.canary.mode = 'all';
    route.draining = true;
    delete route.hostPort;
    snapshot = publish();
    observeCanarySnapshot(snapshot);
    assert.equal(await check('reader', 'canary'), canary);
    assert.ok(old.disposed);

    // An upgraded primary lacks both the registry field and the container env.
    // Its exact container and principal are still inspected before exec.
    for (const [key, tab] of appState.runtimes) disposeTab(tab, key, { runtimes: appState.runtimes });
    const oldInspection = path.join(root, identities.old.containerId + '.json');
    const [legacy] = JSON.parse(fs.readFileSync(oldInspection));
    legacy.Config.Env = legacy.Config.Env.filter(entry => !entry.startsWith('PLOINKY_LAUNCH_ID='));
    write(oldInspection, [legacy]);
    delete identities.old.launchId;
    write(path.join(state, 'agents.json'), { primary: identities.old, primary__canary: { ...identities.canary, canaryOf: routeKey } });
    route.hostPort = identities.old.hostPort;
    delete route.draining;
    route.canary.mode = 'split';
    snapshot = publish();
    observeCanarySnapshot(snapshot);
    await check('reader', 'old');
    route.hostPort = route.hostPort + 1;
    snapshot = publish();
    observeCanarySnapshot(snapshot);
    for (const action of ['input', 'control', 'interaction']) {
        assert.equal(await request(action, 'reader'), 503, action);
    }

    const split = route.canary;
    delete route.canary;
    write(path.join(state, 'agents.json'), { primary: identities.old });
    observeCanarySnapshot(publish());
    assert.equal(await request('stream', 'tester'), 200);
    assert.equal(await request('input', 'tester', () => {
        route.canary = split;
        write(path.join(state, 'agents.json'), { primary: identities.old, primary__canary: { ...identities.canary, canaryOf: routeKey } });
        observeCanarySnapshot(publish());
    }), 503);
    assert.deepEqual(ordinaryWrites, []);
});
