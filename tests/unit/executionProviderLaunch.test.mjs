import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureAgentService } from '../../cli/sandbox/docker/agentServiceManager.js';
import { buildRouterEndpoint } from '../../cli/sandbox/routerPort.js';
import { previewAgentEnable } from '../../cli/utils/agents.js';
import { EXECUTION_PROVIDER_INVALID } from '../../cli/server/executionProvider/publication.mjs';

const provider = (port = 7300, extra = {}) => ({ version: 1, port, terminals: { path: '/terminal-control' }, ...extra });

function listTree(root) {
    const entries = [];
    if (!fs.existsSync(root)) return entries;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
        entries.push(path.join(entry.parentPath, entry.name));
    }
    return entries.sort();
}

// ---- enable planning refuses before any record or route is staged ----

function preview(manifest, { alias = '', profileConfig = null, mode = 'default' } = {}) {
    const registry = { other: { type: 'agent', repoName: 'demo', agentName: 'other', config: { ports: [{ containerPort: 7000, hostPort: 43100 }] } } };
    const routing = { routes: { other: { container: 'other', hostPort: 43100 } } };
    const before = structuredClone({ registry, routing });
    const resolved = {
        agentPath: '/fixture/demo/a', manifest, manifestBytes: Buffer.from('{}'), manifestPath: '/fixture/demo/a/manifest.json',
        normalized: { mode: 'global' }, profile: '', repoName: 'demo', routerEndpoint: null, runtimeAdmission: {}, shortAgentName: 'a',
        profileResolution: { resolvedProfileName: 'default', profileConfig, network: { mode } },
    };
    try {
        return previewAgentEnable({ agentName: 'demo/a', mode: 'global', aliasParam: alias }, {
            readRegistry: () => registry, readRouting: () => routing, resolveInput: () => resolved,
        });
    } finally {
        assert.deepEqual({ registry, routing }, before, 'planning never changes the detached registry or routing');
    }
}

test('enable planning accepts a valid declaration and a manifest without one', () => {
    assert.equal(preview({ container: 'node:20', network: { mode: 'default' } }).plan.record.agentName, 'a');
    assert.equal(preview({ container: 'node:20', executionProvider: provider() }).plan.record.agentName, 'a');
});

test('enable planning refuses an invalid declaration, a port conflict and the reserved task-refs alias before staging', () => {
    const refused = (manifest, options, pattern) => assert.throws(
        () => preview(manifest, options),
        (error) => error.code === EXECUTION_PROVIDER_INVALID && pattern.test(error.message),
    );
    refused({ container: 'node:20', executionProvider: { version: 1, port: 7300 } }, {}, /at least one/);
    refused({ container: 'node:20', executionProvider: provider(), profiles: { default: {}, qa: { openPorts: ['8800:7300/udp'] } } }, {}, /openPorts/);
    refused({ container: 'node:20', executionProvider: provider(7300), env: { PORT: '7300' } }, {}, /env\.PORT/);
    refused({ container: 'node:20', executionProvider: provider(8080) }, { mode: 'host' }, /reserved by the Router/);
    refused({ container: 'node:20', executionProvider: provider() }, { alias: 'task-refs' }, /reserved/);
    refused({ container: 'node:20' }, { alias: 'task-refs' }, /reserved/);
});

// ---- the service manager refuses before the first runtime command ----

function withRuntimeShims(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-shim-'));
    const log = path.join(directory, 'invocations.log');
    fs.writeFileSync(log, '');
    for (const name of ['docker', 'podman']) {
        const file = path.join(directory, name);
        fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
    }
    const previous = process.env.PATH;
    process.env.PATH = `${directory}${path.delimiter}${previous}`;
    t.after(() => {
        process.env.PATH = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

function agentFixture(t, manifest) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-agent-'));
    const agentPath = path.join(directory, 'repo', 'agent');
    fs.mkdirSync(agentPath, { recursive: true });
    fs.writeFileSync(path.join(agentPath, 'manifest.json'), JSON.stringify(manifest));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return agentPath;
}

test('the service manager refuses a conflicting provider publication before any container or registry mutation', (t) => {
    const invocations = withRuntimeShims(t);
    const workspace = process.env.PLOINKY_WORKSPACE_ROOT;
    const options = { routerEndpoint: buildRouterEndpoint('default', 8080) };
    const manifest = (openPort) => ({
        container: 'node:20',
        executionProvider: provider(7300),
        profiles: { default: { openPorts: [openPort] } },
    });

    const treeBefore = listTree(workspace);
    for (const conflict of ['7300', '8800:7300', '127.0.0.1:7298-7302', '7300/udp']) {
        const bad = manifest(conflict);
        assert.throws(
            () => ensureAgentService('agent', bad, agentFixture(t, bad), options),
            (error) => error.code === EXECUTION_PROVIDER_INVALID,
            conflict,
        );
    }
    assert.deepEqual(invocations(), [], 'no container runtime command ran for a refused publication');
    // Only the lifecycle lock directory of the preflight may appear; no registry, route or runtime file does.
    const created = listTree(workspace).filter((entry) => !treeBefore.includes(entry)).map((entry) => path.relative(workspace, entry));
    assert.deepEqual(created.filter((entry) => entry !== '.ploinky' && entry !== path.join('.ploinky', 'run')), []);
    assert.equal(created.some((entry) => /agents\.json|routing\.json|edge-routing/.test(entry)), false);

    // Control: the same call with a non-conflicting port gets past the check and reaches the runtime.
    const good = manifest('7301');
    assert.throws(() => ensureAgentService('agent', good, agentFixture(t, good), options), (error) => error.code !== EXECUTION_PROVIDER_INVALID);
    assert.ok(invocations().length > 0, 'the control launch invoked the runtime shim');
});

test('the service manager reads the resolved AgentServer PORT only for a provider and refuses it', (t) => {
    const invocations = withRuntimeShims(t);
    const options = { routerEndpoint: buildRouterEndpoint('default', 8080) };
    const bad = { container: 'node:20', executionProvider: provider(7300), profiles: { default: { env: { PORT: '7300' } } } };
    assert.throws(
        () => ensureAgentService('agent', bad, agentFixture(t, bad), options),
        (error) => error.code === EXECUTION_PROVIDER_INVALID && /env\.PORT|AgentServer port/.test(error.message),
    );
    assert.deepEqual(invocations(), []);
});

test('the publication check lives in the read-only preflight that runs before the GPU/MPS hand-off, the lock and every runtime-kind branch', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    const section = (name) => {
        const start = source.indexOf(name);
        assert.ok(start > 0, name);
        return source.slice(start, source.indexOf('\nfunction ', start + 10));
    };
    const preflight = section('export function admitAgentServicePreflight(');
    const check = preflight.indexOf('assertExecutionProviderPublication({');
    assert.ok(check > 0);
    for (const later of ['assertManifestStorageAdmission(', 'admitManifestRuntimeCapabilities(', 'resolveLlmRuntimeAdmissionContext(']) {
        assert.ok(preflight.indexOf(later) > check, `${later} must come after the publication check`);
    }
    // ensureAgentService runs that preflight first, before the early GPU hand-off and everything that mutates.
    const service = section('function ensureAgentService(');
    const run = service.indexOf('admitAgentServicePreflight(agentName, manifest, agentPath, options)');
    assert.ok(run > 0);
    for (const later of ['ensureMpsAgentService', 'hardwareLimits/mpsLifecycle.mjs', 'withNetworkLifecycleLock(', "agentRuntime === 'bwrap'",
        'ensureBwrapService(', 'ensureSeatbeltService(', 'containerExists(containerName)', 'startAgentContainer(', 'saveAgentsMap(', 'ensureImagePresent(']) {
        const at = service.indexOf(later);
        assert.ok(at < 0 || at > run, `${later} must come after the preflight`);
    }
    assert.equal((service.match(/assertExecutionProviderPublication/g) || []).length, 0, 'no second, later copy of the check');
});

test('a GPU-declaring provider with a conflicting port is refused before the MPS hand-off is imported', (t) => {
    const invocations = withRuntimeShims(t);
    const options = { routerEndpoint: buildRouterEndpoint('default', 8080) };
    const bad = {
        container: 'node:20',
        containerSecurity: { gpu: true },
        executionProvider: provider(7300),
        profiles: { default: { openPorts: ['7300'] } },
    };
    assert.throws(
        () => ensureAgentService('agent', bad, agentFixture(t, bad), options),
        (error) => error.code === EXECUTION_PROVIDER_INVALID,
    );
    assert.deepEqual(invocations(), []);
});
