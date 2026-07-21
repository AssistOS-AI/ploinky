import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    hasPreinstallRunInProcess,
    markPreinstallRunInProcess,
    resetPreinstallRunInProcess,
} from '../../cli/utils/runtime/lifecycleHooks.js';
import { buildExecArgs } from '../../cli/sandbox/docker/interactive.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const agentServiceManagerUrl = pathToFileURL(path.join(repoRoot, 'cli/sandbox/docker/agentServiceManager.js')).href;
const dockerCommonUrl = pathToFileURL(path.join(repoRoot, 'cli/sandbox/docker/common.js')).href;

function tempDir(prefix = 'ploinky-runtime-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runModuleSnippet(source, env = {}, options = {}) {
    const childEnv = {
        ...process.env,
        ...env,
        PLOINKY_DEBUG: '',
    };
    if (options.cwd && !Object.hasOwn(env, 'PLOINKY_WORKSPACE_ROOT')) {
        childEnv.PLOINKY_WORKSPACE_ROOT = options.cwd;
    }
    return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd: options.cwd || repoRoot,
        env: childEnv,
        encoding: 'utf8',
    });
}

test('buildRuntimeRouterEnv prefers the startup port over stale routing state', () => {
    const workspaceDir = tempDir();
    try {
        fs.mkdirSync(path.join(workspaceDir, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky/routing.json'), JSON.stringify({ port: 8080 }));

        const result = runModuleSnippet(
            `const { buildRuntimeRouterEnv } = await import(${JSON.stringify(agentServiceManagerUrl)});
process.stdout.write(JSON.stringify(buildRuntimeRouterEnv('podman', { routerPort: 8097 })));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            PLOINKY_ROUTER_PORT: '8097',
            PLOINKY_ROUTER_HOST: 'host.containers.internal',
            PLOINKY_ROUTER_URL: 'http://host.containers.internal:8097',
            PLOINKY_ROUTER_AUTHORITY: '127.0.0.1:8097',
        });
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('buildRuntimeRouterEnv reads the seeded routing file when no port override is supplied', () => {
    const workspaceDir = tempDir();
    try {
        fs.mkdirSync(path.join(workspaceDir, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky/routing.json'), JSON.stringify({ port: 8097 }));

        const result = runModuleSnippet(
            `const { buildRuntimeRouterEnv } = await import(${JSON.stringify(agentServiceManagerUrl)});
process.stdout.write(JSON.stringify(buildRuntimeRouterEnv('docker')));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            PLOINKY_ROUTER_PORT: '8097',
            PLOINKY_ROUTER_HOST: 'host.docker.internal',
            PLOINKY_ROUTER_URL: 'http://host.docker.internal:8097',
            PLOINKY_ROUTER_AUTHORITY: '127.0.0.1:8097',
        });
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('computeEnvHash preserves legacy shape when no network is declared', () => {
    const workspaceDir = tempDir();
    try {
        const result = runModuleSnippet(
            `import crypto from 'node:crypto';
const { computeEnvHash } = await import(${JSON.stringify(dockerCommonUrl)});
const manifest = { env: [{ name: 'DEMO_VALUE', default: 'one' }] };
const expected = crypto.createHash('sha256').update(JSON.stringify({ DEMO_VALUE: 'one' })).digest('hex');
process.stdout.write(JSON.stringify({ actual: computeEnvHash(manifest), expected }));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.actual, output.expected);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('computeEnvHash changes when the effective profile network changes', () => {
    const workspaceDir = tempDir();
    try {
        const result = runModuleSnippet(
            `const { computeEnvHash } = await import(${JSON.stringify(dockerCommonUrl)});
const manifest = {
    env: [{ name: 'DEMO_VALUE', default: 'one' }],
    network: { name: 'root-network', aliases: ['rootAgent'] },
};
const bridgeProfile = { network: { name: 'webmeet', aliases: ['webmeetLivekitServer'] } };
const hostProfile = { network: { mode: 'host' } };
process.stdout.write(JSON.stringify({
    rootHash: computeEnvHash(manifest, null),
    bridgeHash: computeEnvHash(manifest, bridgeProfile),
    hostHash: computeEnvHash(manifest, hostProfile),
}));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.notEqual(output.rootHash, output.bridgeHash);
        assert.notEqual(output.bridgeHash, output.hostHash);
        assert.notEqual(output.rootHash, output.hostHash);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('getConfiguredProjectPath uses .data agent folder for isolated records', () => {
    const workspaceDir = tempDir();
    try {
        fs.mkdirSync(path.join(workspaceDir, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky/agents.json'), JSON.stringify({
            demoContainer: {
                type: 'agent',
                agentName: 'demo',
                repoName: 'repo',
                runMode: 'isolated',
            },
        }));

        const result = runModuleSnippet(
            `const { getConfiguredProjectPath } = await import(${JSON.stringify(dockerCommonUrl)});
process.stdout.write(getConfiguredProjectPath('demo', 'repo'));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, path.join(workspaceDir, '.data', 'demo'));
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('getConfiguredProjectPath uses alias as isolated .data folder name', () => {
    const workspaceDir = tempDir();
    try {
        fs.mkdirSync(path.join(workspaceDir, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky/agents.json'), JSON.stringify({
            demoAliasContainer: {
                type: 'agent',
                agentName: 'demo',
                repoName: 'repo',
                alias: 'demoAlias',
                runMode: 'isolated',
            },
        }));

        const result = runModuleSnippet(
            `const { getConfiguredProjectPath } = await import(${JSON.stringify(dockerCommonUrl)});
process.stdout.write(getConfiguredProjectPath('demo', 'repo', 'demoAlias'));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, path.join(workspaceDir, '.data', 'demoAlias'));
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('global enabled agents keep workspace projectPath and declare persistent /root home', () => {
    const workspaceDir = tempDir();
    const binDir = tempDir('ploinky-fake-runtime-');
    try {
        const stateFile = path.join(binDir, 'container-name.txt');
        const argsFile = path.join(binDir, 'run-args.txt');
        const podmanPath = path.join(binDir, 'podman');
        fs.writeFileSync(
            podmanPath,
            `#!/bin/sh
case "$1" in
  image)
    exit 0
    ;;
  inspect)
    if [ ! -s ${JSON.stringify(stateFile)} ]; then exit 1; fi
    printf '%s\n' '[{"Id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","HostConfig":{"NetworkMode":"bridge"}}]'
    exit 0
    ;;
  run)
    printf '%s\\n' "$*" > ${JSON.stringify(argsFile)}
    name=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--name" ]; then name="$arg"; break; fi
      prev="$arg"
    done
    printf '%s\\n' "$name" > ${JSON.stringify(stateFile)}
    exit 0
    ;;
  ps)
    cat ${JSON.stringify(stateFile)} 2>/dev/null || true
    exit 0
    ;;
  port)
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
        );
        fs.chmodSync(podmanPath, 0o755);

        const agentDir = path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'demo');
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({
            container: 'example/demo:latest',
            start: 'sleep 3600',
            readiness: { protocol: 'none' },
        }));

        const result = runModuleSnippet(
            `const { enableAgent } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/utils/agents.js')).href)});
enableAgent('repo/demo', 'global');
const fs = await import('node:fs');
const path = await import('node:path');
const agents = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.ploinky', 'agents.json'), 'utf8'));
const record = Object.values(agents).find((entry) => entry && entry.agentName === 'demo');
console.log(JSON.stringify(record));`,
            { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const record = JSON.parse(result.stdout.trim().split('\n').at(-1));
        assert.equal(record.runMode, 'global');
        assert.equal(record.projectPath, workspaceDir);
        assert.ok(record.config.binds.some((bind) => (
            bind.source === workspaceDir && bind.target === workspaceDir
        )));
        assert.ok(record.config.binds.some((bind) => (
            bind.source === path.join(workspaceDir, '.data', 'demo') && bind.target === '/root'
        )));
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('buildExecArgs prefers interactive bash for direct shell TTY sessions', () => {
    const args = buildExecArgs('agent-container', '/work', '/bin/sh', true, true, {
        env: {
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LINES: '42',
            COLUMNS: '120',
        },
        historyName: 'repo/agent',
    });

    assert.deepEqual(args, [
        'exec',
        '-it',
        '-e', 'TERM=xterm-256color',
        '-e', 'COLORTERM=truecolor',
        '-e', 'LINES=42',
        '-e', 'COLUMNS=120',
        '-e', 'HISTFILE=/shared/.ploinky-repo_agent-shell-history',
        '-e', 'HISTSIZE=5000',
        '-e', 'HISTFILESIZE=10000',
        'agent-container',
        'sh',
        '-lc',
        "cd '/work' && export PS1='# '; if command -v /bin/bash >/dev/null 2>&1; then exec /bin/bash --noprofile --norc -i; else exec /bin/sh -i; fi",
    ]);
});

test('buildExecArgs preserves non-tty shell sessions for webchat stdin EOF handling', () => {
    assert.deepEqual(
        buildExecArgs('agent-container', '/work', '/bin/sh', true, false, {
            env: { TERM: 'xterm-256color' },
            historyName: 'repo/agent',
        }),
        [
            'exec',
            '-i',
            'agent-container',
            'sh',
            '-lc',
            "cd '/work' && /bin/sh",
        ],
    );
});

test('buildExecArgs forwards only validated WebChat history metadata to non-tty containers', () => {
    assert.deepEqual(
        buildExecArgs('agent-container', '/work', 'node /code/src/index.mjs', true, false, {
            env: {
                PLOINKY_WEBCHAT_HAS_HISTORY: '1',
                UNRELATED_VALUE: 'must-not-be-forwarded',
            },
        }),
        [
            'exec',
            '-i',
            '-e', 'PLOINKY_WEBCHAT_HAS_HISTORY=1',
            'agent-container',
            'sh',
            '-lc',
            "cd '/work' && node /code/src/index.mjs",
        ],
    );

    assert.deepEqual(
        buildExecArgs('agent-container', '/work', 'node /code/src/index.mjs', true, false, {
            env: {
                PLOINKY_WEBCHAT_HAS_HISTORY: 'yes',
            },
        }),
        [
            'exec',
            '-i',
            'agent-container',
            'sh',
            '-lc',
            "cd '/work' && node /code/src/index.mjs",
        ],
    );
});

test('buildExecArgs does not rewrite non-shell commands and quotes workdir', () => {
    assert.deepEqual(
        buildExecArgs('agent-container', "/tmp/it's-here", 'node /code/src/index.mjs', true, true, {
            env: {},
            historyName: '',
        }),
        [
            'exec',
            '-it',
            'agent-container',
            'sh',
            '-lc',
            "cd '/tmp/it'\\''s-here' && node /code/src/index.mjs",
        ],
    );
});

test('collectLiveAgentContainers probes the runtime before listing live containers', () => {
    const binDir = tempDir();
    try {
        const podmanPath = path.join(binDir, 'podman');
        fs.writeFileSync(
            podmanPath,
            `#!/bin/sh
case "$1" in
  ps)
    printf '%s\\n' 'ploinky_repoA_agentA_project_12345678'
    ;;
  inspect)
    printf '%s\\n' '[{"Mounts":[{"Destination":"/code","Source":"/tmp/ws/.ploinky/repos/repoA/agentA"}],"Config":{"Env":["AGENT_NAME=agentA"],"Image":"node:20-alpine"},"NetworkSettings":{"Ports":{"7000/tcp":[{"HostIp":"127.0.0.1","HostPort":"12345"}]}}}]'
    ;;
  *)
    exit 1
    ;;
esac
`,
        );
        fs.chmodSync(podmanPath, 0o755);

        const result = runModuleSnippet(
            `import { collectLiveAgentContainers } from './cli/sandbox/docker/containerRegistry.js';
process.stdout.write(JSON.stringify(collectLiveAgentContainers()));`,
            { PATH: binDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const containers = JSON.parse(result.stdout);
        assert.equal(containers.length, 1);
        assert.equal(containers[0].containerName, 'ploinky_repoA_agentA_project_12345678');
        assert.equal(containers[0].agentName, 'agentA');
        assert.equal(containers[0].repoName, 'repoA');
        assert.equal(containers[0].config.ports[0].hostPort, '12345');
    } finally {
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('collectLiveAgentContainers is non-fatal when no container runtime is installed', () => {
    const emptyBin = tempDir();
    try {
        const result = runModuleSnippet(
            `import { collectLiveAgentContainers } from './cli/sandbox/docker/containerRegistry.js';
process.stdout.write(JSON.stringify(collectLiveAgentContainers()));`,
            { PATH: emptyBin },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), []);
    } finally {
        fs.rmSync(emptyBin, { recursive: true, force: true });
    }
});

test('preinstall deduplication is process-local and repo scoped', () => {
    const agentName = `shared-agent-${Date.now()}`;
    assert.equal(hasPreinstallRunInProcess(agentName, 'repo-one', 'dev'), false);

    markPreinstallRunInProcess(agentName, 'repo-one', 'dev');

    assert.equal(hasPreinstallRunInProcess(agentName, 'repo-one', 'dev'), true);
    assert.equal(hasPreinstallRunInProcess(agentName, 'repo-two', 'dev'), false);
});

test('resetPreinstallRunInProcess clears the in-process dedup set', () => {
    const agentName = `reset-agent-${Date.now()}`;
    markPreinstallRunInProcess(agentName, 'repo-one', 'dev');
    markPreinstallRunInProcess(agentName, 'repo-two', 'dev');
    assert.equal(hasPreinstallRunInProcess(agentName, 'repo-one', 'dev'), true);

    resetPreinstallRunInProcess();

    assert.equal(hasPreinstallRunInProcess(agentName, 'repo-one', 'dev'), false);
    assert.equal(hasPreinstallRunInProcess(agentName, 'repo-two', 'dev'), false);
});
