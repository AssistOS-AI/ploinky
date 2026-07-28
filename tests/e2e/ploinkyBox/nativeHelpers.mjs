import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildEngineProcessEnvironment, createProcessRunner } from '../../../ploinky-box/process.mjs';
import { resolveWorkspaceIdentity } from '../../../ploinky-box/identity.mjs';
import { createMutationLockManager } from '../../../ploinky-box/locks.mjs';
import { createBoxSupervisor } from '../../../ploinky-box/supervisor.mjs';

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
    const workspace = path.join(root, 'workspace');
    const child = path.join(workspace, 'child');
    const lockHome = path.join(root, 'lock-home');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(lockHome);
    const environmentInput = {
        ...process.env,
        HOME: lockHome,
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
    const supervisorOptions = {
        runner,
        lockManager: createMutationLockManager({ homeDirectory: lockHome }),
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
        const inspect = runner.query('podman', ['container', 'inspect', identity.instance]);
        if (inspect.ok) {
            let records;
            try {
                records = JSON.parse(inspect.stdout);
            } catch {
                assert.fail(`native Box inspection returned invalid JSON for ${identity.instance}`);
            }
            const id = String(records[0]?.Id || records[0]?.ID || '');
            assert.match(id, /^[a-f0-9]{12,64}$/,
                `native Box inspection returned an invalid ID for ${identity.instance}`);
            const removed = runner.query('podman', [
                'container', 'rm', '-f', '--time', '0', '--volumes', id,
            ], { timeoutMs: 120_000 });
            assert.equal(removed.ok, true, `failed to clean native Box ${id}: ${removed.stderr}`);
        }
        for (const name of Object.values(identity.volumes)) {
            runner.query('podman', ['volume', 'rm', '-f', name]);
        }
    }
    t.after(cleanup);
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
