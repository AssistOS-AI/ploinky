import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    BWRAP_HOME_SOURCE_KINDS,
    buildTrustedServicePolicy,
    encodeBwrapLaunchDescriptor,
} from '../../Agent/lib/providerSandbox.mjs';
import {
    AGENT_HOME_ABI_MARKER,
    ensureAgentHomeAbi,
    initWorkspaceStructure,
} from '../../cli/utils/workspaceStructure.js';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';

const enabled = process.env.PLOINKY_NATIVE_TRUSTED_BWRAP === '1';
const workspaceRoot = '/workspace';

function waitForExit(child, timeoutMs = 5_000) {
    return Promise.race([
        new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
        new Promise((_, reject) => setTimeout(() => reject(new Error('trusted service did not exit')), timeoutMs)),
    ]);
}

function writeDescriptor(child, descriptor, stderr) {
    return new Promise((resolve, reject) => {
        const stream = child.stdio[3];
        stream.once('error', async (error) => {
            let terminal = null;
            try { terminal = await waitForExit(child); } catch (_) { }
            reject(new Error([
                `trusted helper descriptor transport failed: ${error.code || error.message}`,
                terminal ? `terminal=${JSON.stringify(terminal)}` : 'terminal=unobserved',
                `stderr=${stderr.value}`,
            ].join('; '), { cause: error }));
        });
        stream.end(descriptor, resolve);
    });
}

async function readReady(port, child, stderr) {
    const deadline = Date.now() + 10_000;
    let lastError = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`trusted service exited before readiness: ${stderr.value}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/ready`);
            if (response.ok) return response.json();
            lastError = new Error(`readiness returned HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`trusted service readiness timed out: ${lastError?.message || 'no response'}; ${stderr.value}`);
}

test('native trusted AgentServer uses only fd launcher policy and direct HOME', {
    skip: enabled ? false : 'set PLOINKY_NATIVE_TRUSTED_BWRAP=1 inside the immutable Box candidate',
    timeout: 30_000,
}, async () => {
    assert.equal(process.platform, 'linux');
    assert.equal(process.env.PLOINKY_WORKSPACE_ROOT, workspaceRoot);
    const workspaceStat = fs.lstatSync(workspaceRoot);
    assert.equal(workspaceStat.isDirectory(), true);
    assert.equal(workspaceStat.uid, process.getuid());

    initWorkspaceStructure(workspaceRoot);
    const runtimeKey = `native-trusted-${process.pid}`;
    const fixtureRoot = path.join(workspaceRoot, '.ploinky', 'native-trusted-service', runtimeKey);
    const agentRuntimePath = path.join(fixtureRoot, 'Agent');
    const codePath = path.join(fixtureRoot, 'code');
    const dependenciesPath = path.join(fixtureRoot, 'dependencies');
    const serverPath = path.join(agentRuntimePath, 'server', 'AgentServer.mjs');
    const workspaceWritePath = path.join(workspaceRoot, `${runtimeKey}.workspace-write`);
    const homeWritePath = '/home/agent/native-service-home-write';
    const port = 20_000 + (process.pid % 30_000);
    const nodeRuntimePath = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
    const stderr = { value: '' };
    let child = null;

    try {
        for (const directory of [
            path.dirname(serverPath),
            path.join(agentRuntimePath, 'node_modules'),
            path.join(codePath, 'node_modules'),
            dependenciesPath,
        ]) {
            fs.mkdirSync(directory, { recursive: true });
        }
        fs.writeFileSync(serverPath, `
            import http from 'node:http';
            import fs from 'node:fs';
            const workspaceWritePath = ${JSON.stringify(workspaceWritePath)};
            const homeWritePath = ${JSON.stringify(homeWritePath)};
            function canWrite(file) {
                try { fs.writeFileSync(file, 'write'); return true; } catch (_) { return false; }
            }
            const report = {
                argv: process.argv,
                cwd: process.cwd(),
                home: process.env.HOME,
                workspace: process.env.PLOINKY_WORKSPACE_ROOT,
                sentinel: process.env.NATIVE_TRUSTED_SENTINEL,
                workspaceWritable: canWrite(workspaceWritePath),
                homeWritable: canWrite(homeWritePath),
                codeWritable: canWrite('/code/native-service-code-write'),
                agentWritable: canWrite('/Agent/native-service-agent-write'),
                runtimeWritable: canWrite('/opt/ploinky-node/native-service-runtime-write'),
                rootExists: fs.existsSync('/root'),
                sharedExists: fs.existsSync('/shared'),
                procPids: fs.readdirSync('/proc').filter((name) => /^[0-9]+$/.test(name)).map(Number).sort((a, b) => a - b),
            };
            const server = http.createServer((request, response) => {
                if (request.url !== '/ready') { response.writeHead(404).end(); return; }
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify(report));
            });
            server.listen(Number(process.env.PORT), '127.0.0.1');
            process.on('SIGTERM', () => server.close(() => process.exit(0)));
        `);
        fs.writeFileSync(path.join(codePath, 'fixture.txt'), 'immutable code\n');

        const home = ensureAgentHomeAbi(runtimeKey, 'native-phase4');
        assert.equal(home.homePath, path.join(workspaceRoot, '.data', home.homeKey));
        const markerStat = fs.lstatSync(path.join(home.homePath, AGENT_HOME_ABI_MARKER));
        assert.equal(markerStat.mode & 0o7777, 0o600);

        const policy = buildTrustedServicePolicy({
            homeSource: {
                sourceKind: BWRAP_HOME_SOURCE_KINDS.SANDBOX_WORKSPACE_V2,
                homeKey: home.homeKey,
            },
            command: ['/opt/ploinky-node/bin/node', '/Agent/server/AgentServer.mjs'],
            nodeRuntimePath,
            agentRuntimePath,
            codePath,
            codeDependenciesPath: dependenciesPath,
            agentDependenciesPath: dependenciesPath,
            environment: {
                NATIVE_TRUSTED_SENTINEL: 'phase4',
            },
            identity: {
                principalId: 'agent:native/trusted-service',
                instanceId: runtimeKey,
                enableGeneration: 'native-phase4',
            },
            agentName: 'trusted-service',
            repoName: 'native',
            listenPort: port,
        });
        const descriptor = encodeBwrapLaunchDescriptor(policy.records);
        const log = fs.openSync(path.join(fixtureRoot, 'trusted-service.log'), 'a');
        try {
            child = spawn(IMAGE_CONTRACT.bwrapHelper, [], {
                detached: true,
                stdio: ['ignore', log, 'pipe', 'pipe'],
            });
        } finally {
            fs.closeSync(log);
        }
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr.value += chunk; });
        await writeDescriptor(child, descriptor, stderr);

        const report = await readReady(port, child, stderr);
        assert.equal(report.cwd, '/code');
        assert.equal(report.home, '/home/agent');
        assert.equal(report.workspace, '/workspace');
        assert.equal(report.sentinel, 'phase4');
        assert.equal(report.workspaceWritable, true);
        assert.equal(report.homeWritable, true);
        assert.equal(report.codeWritable, false);
        assert.equal(report.agentWritable, false);
        assert.equal(report.runtimeWritable, false);
        assert.equal(report.rootExists, false);
        assert.equal(report.sharedExists, false);
        assert.ok(report.procPids.length <= 4, `expected private proc, observed ${report.procPids}`);
    } finally {
        if (child?.pid && child.exitCode === null) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { }
            try { await waitForExit(child); } catch (_) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { }
            }
        }
        fs.rmSync(workspaceWritePath, { force: true });
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        fs.rmSync(path.join(workspaceRoot, '.data', `${runtimeKey}.sandbox-v2`), { recursive: true, force: true });
    }
});
