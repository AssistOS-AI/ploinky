import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { buildEngineProcessEnvironment, createProcessRunner } from '../../../ploinky-box/process.mjs';
import { resolveWorkspaceIdentity } from '../../../ploinky-box/identity.mjs';
import { createMutationLockManager, withWorkspaceMutationLock } from '../../../ploinky-box/locks.mjs';
import { createBoxSupervisor } from '../../../ploinky-box/supervisor.mjs';
import { discoverBoxOwnership } from '../../../ploinky-box/engine/discovery.mjs';
import { writeCandidatePodmanProxy } from './candidatePodmanProxy.mjs';

const ABSENT_RESOURCE = /(?:no such|not found|does not exist)/i;

function cleanupError(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_BOX_TEST_CLEANUP_REFUSED';
    return error;
}

function assertSameWorkspaceIdentity(expected, current) {
    if (!current
        || expected.workspaceRoot !== current.workspaceRoot
        || expected.instance !== current.instance
        || expected.pathHash !== current.pathHash
        || !isDeepStrictEqual(expected.rootFingerprint, current.rootFingerprint)) {
        throw cleanupError('Workspace identity changed during native Box cleanup');
    }
}

function assertSameContainerHandle(expected, current) {
    if (!current
        || expected.id !== current.id
        || expected.engine !== current.engine
        || expected.engineIdentity !== current.engineIdentity
        || expected.name !== current.name
        || expected.pathHash !== current.pathHash
        || !isDeepStrictEqual(expected.labels, current.labels)) {
        throw cleanupError('Native Box container changed during cleanup');
    }
}

function confirmResourceAbsent(runner, engineName, kind, identifier) {
    const inspection = runner.query(engineName, [kind, 'inspect', identifier]);
    if (inspection.ok || !ABSENT_RESOURCE.test(String(inspection.stderr || inspection.stdout || ''))) {
        throw cleanupError(`${kind} ${identifier} absence could not be proven`);
    }
}

// Box persistence is workspace-backed, so the outer container is the only
// engine resource a native harness can own and therefore must clean up.
export async function cleanupNativeHarnessResources({
    resolveIdentity,
    expectedIdentity,
    runner,
    lockManager,
    platform = process.platform,
    env = {},
    discover = (identity) => discoverBoxOwnership(identity, { runner, platform, env }),
    withLock = withWorkspaceMutationLock,
} = {}) {
    if (!expectedIdentity || typeof resolveIdentity !== 'function' || !runner || !lockManager) {
        throw new TypeError('Native Box cleanup requires captured identity, resolver, runner, and lock manager');
    }
    return withLock({
        resolveIdentity,
        lockManager,
        materializeAnchor: () => undefined,
        execute: async (lockedIdentity, lock) => {
            assertSameWorkspaceIdentity(expectedIdentity, lockedIdentity);
            lock.assertHeld(lockedIdentity.instance);
            const captured = discover(lockedIdentity);
            if (captured.state === 'absent') {
                return Object.freeze({ action: 'absent', removedContainerId: null });
            }
            if (!['owned', 'incompatible'].includes(captured.state) || !captured.engine) {
                throw cleanupError(captured.message || `Native Box ownership is ${captured.state}`);
            }
            const engine = captured.engine;
            const container = captured.handles?.container || null;

            if (container) {
                assertSameWorkspaceIdentity(expectedIdentity, resolveIdentity());
                lock.assertHeld(lockedIdentity.instance);
                const current = discover(lockedIdentity);
                if (!['owned', 'incompatible'].includes(current.state)
                    || current.engine?.name !== engine.name
                    || current.engine?.identity !== engine.identity) {
                    throw cleanupError('Native Box engine or ownership changed before container removal');
                }
                assertSameContainerHandle(container, current.handles?.container);
                const removed = runner.query(engine.name, [
                    'container', 'rm', '--force', '--time', '0', container.id,
                ], { timeoutMs: 120_000 });
                if (!removed.ok) {
                    throw cleanupError(`Failed to remove native Box container ${container.id}`);
                }
                confirmResourceAbsent(runner, engine.name, 'container', container.id);
            }

            return Object.freeze({
                action: 'removed',
                removedContainerId: container?.id || null,
            });
        },
    });
}

export function requirePodmanCandidate(t, env = process.env) {
    if (env.PLOINKY_BOX_REQUIRE_PODMAN !== '1') {
        t.skip('set PLOINKY_BOX_REQUIRE_PODMAN=1 for the rootless-Podman candidate gate');
        return null;
    }
    assert.match(process.platform, /^(?:darwin|linux)$/,
        'authoritative Box tests require Linux or macOS Podman Machine');
    const digest = String(env.PLOINKY_BOX_CANDIDATE_DIGEST || '');
    assert.match(digest, /^sha256:[a-f0-9]{64}$/,
        'PLOINKY_BOX_CANDIDATE_DIGEST must be one immutable candidate digest');
    return `docker.io/assistos/ploinky-box@${digest}`;
}

export function createPodmanHarness(t, candidateReference, {
    reconcile,
} = {}) {
    const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-podman-'));
    const root = fs.realpathSync(createdRoot);
    let finalCleanup = null;
    t.after(async () => {
        if (finalCleanup) await finalCleanup();
        fs.rmSync(root, { recursive: true, force: false });
        assert.equal(fs.existsSync(root), false, 'native Box fixture root must be removed');
    });
    const workspace = path.join(root, 'workspace');
    const child = path.join(workspace, 'child');
    const lockHome = path.join(root, 'lock-home');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(lockHome);
    const lookupRunner = createProcessRunner({
        env: buildEngineProcessEnvironment(process.env),
    });
    const podmanLookup = lookupRunner.query('which', ['podman']);
    assert.equal(podmanLookup.ok, true, podmanLookup.stderr);
    const realPodmanInput = String(
        process.env.PLOINKY_BOX_REAL_PODMAN || podmanLookup.stdout.trim(),
    );
    assert.equal(path.isAbsolute(realPodmanInput), true);
    const realPodman = fs.realpathSync(realPodmanInput);
    const candidateProxy = writeCandidatePodmanProxy({
        directory: path.join(root, 'candidate-engine-proxy'),
        realPodman,
        candidateReference,
        logicalReference: candidateReference,
        localCandidate: true,
        tracePath: path.join(root, 'candidate-engine-proxy.trace'),
    });
    const environmentInput = {
        ...process.env,
        HOME: lockHome,
        PATH: `${candidateProxy.directory}${path.delimiter}${process.env.PATH}`,
    };
    if (process.platform === 'darwin') {
        environmentInput.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME
            || path.join(os.homedir(), '.config');
    }
    const engineEnvironment = buildEngineProcessEnvironment(environmentInput);
    const runner = createProcessRunner({ env: engineEnvironment });
    const info = runner.query('podman', ['info', '--format', 'json']);
    assert.equal(info.ok, true, `rootless Podman is required: ${info.stderr}`);
    const parsedInfo = JSON.parse(info.stdout);
    assert.equal(parsedInfo.host?.security?.rootless ?? parsedInfo.Host?.Security?.Rootless, true);
    let launchDirectory = workspace;
    const resolveIdentity = () => resolveWorkspaceIdentity({
        env: {},
        cwd: () => launchDirectory,
    });
    const output = { bytes: '', write(chunk) { this.bytes += String(chunk); } };
    const lockManager = createMutationLockManager({ homeDirectory: lockHome });
    const supervisorOptions = {
        runner,
        lockManager,
        resolveIdentity,
        platform: process.platform,
        env: {},
        stdout: output,
        stderr: output,
    };
    if (reconcile) supervisorOptions.reconcile = reconcile;
    const supervisor = createBoxSupervisor(supervisorOptions);
    const identity = resolveIdentity();
    async function cleanup() {
        await cleanupNativeHarnessResources({
            resolveIdentity,
            expectedIdentity: identity,
            runner,
            lockManager,
            platform: process.platform,
            env: {},
        });
    }
    finalCleanup = cleanup;
    return {
        root,
        workspace,
        child,
        lockHome,
        runner,
        supervisor,
        identity,
        output,
        engineEnvironment,
        candidateProxy,
        candidateReference,
        useParent() { launchDirectory = workspace; },
        useChild() { launchDirectory = child; },
        resolveIdentity,
        cleanup,
    };
}

export function execInBox(runner, containerId, argv, { timeoutMs = 120_000 } = {}) {
    const result = runner.query('podman', [
        'container', 'exec', '--user', 'podman', '--workdir', '/workspace',
        containerId, ...argv,
    ], { timeoutMs });
    assert.equal(result.ok, true, `${argv.join(' ')} failed: ${result.stderr}`);
    return String(result.stdout || '').trim();
}

const ROUTER_HEALTH_SCRIPT = [
    "const h=require('node:http');",
    "const hostname=process.argv[1]||process.env.PLOINKY_ROUTER_HOST;",
    "const port=process.argv[2]||process.env.PLOINKY_ROUTER_PORT;",
    "const authority=process.argv[3]||process.env.PLOINKY_ROUTER_AUTHORITY;",
    "const deadline=Date.now()+Number(process.argv[4]);",
    "const transient=new Set(['EDGE_GENERATION_INACTIVE','EDGE_GENERATION_RUNTIME_MISMATCH','edge_generation_changed']);",
    "function fail(code,detail){if(detail)process.stderr.write('PLOINKY_ROUTER_HEALTH_FAILED '+JSON.stringify(detail).slice(0,512)+'\\n');process.exit(code)}",
    "function check(){",
    "const q=h.get({hostname,port,path:'/health',headers:{Host:authority}},r=>{",
    "let body='';r.setEncoding('utf8');r.on('data',c=>body+=c);r.on('end',()=>{",
    "if(r.statusCode===200){let value;try{value=JSON.parse(body)}catch{fail(3,{status:r.statusCode,bodyBytes:Buffer.byteLength(body)})};fail(value.status==='healthy'?0:4,value.status==='healthy'?null:{status:r.statusCode,healthStatus:String(value.status||'').slice(0,80)})}",
    "if(r.statusCode===302&&body==='Authentication required'){",
    "let location;try{location=new URL(String(r.headers.location||''),'http://'+authority)}catch{fail(8,{status:r.statusCode,locationBytes:Buffer.byteLength(String(r.headers.location||''))})};",
    "if(location.pathname==='/auth/login'&&location.searchParams.get('returnTo')==='/health')fail(0);",
    "fail(9,{status:r.statusCode,pathname:location.pathname,returnTo:location.searchParams.get('returnTo')});",
    "}",
    "let value;try{value=JSON.parse(body)}catch{fail(5,{status:r.statusCode,bodyBytes:Buffer.byteLength(body)})};",
    "if(r.statusCode!==503||!transient.has(value.error)||Date.now()>=deadline)fail(6,{status:r.statusCode,error:String(value.error||'').slice(0,80),deadlineReached:Date.now()>=deadline});",
    "setTimeout(check,250);",
    "});",
    "});",
    "q.setTimeout(5000,()=>q.destroy(new Error('timeout')));",
    "q.on('error',e=>Date.now()<deadline?setTimeout(check,250):fail(7,{errorCode:String(e.code||'').slice(0,40)}));",
    "}",
    "check();",
].join('');

export function waitForRouterHealth(runner, containerId, {
    nestedContainerId,
    hostname = '',
    port = '',
    authority = '',
    timeoutMs = 900_000,
} = {}) {
    const nodeCommand = [
        '/usr/local/bin/node', '-e', ROUTER_HEALTH_SCRIPT,
        hostname, String(port), authority, String(timeoutMs),
    ];
    execInBox(runner, containerId, nestedContainerId
        ? ['podman', 'container', 'exec', nestedContainerId, ...nodeCommand]
        : nodeCommand, { timeoutMs: timeoutMs + 10_000 });
}
