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
} from '../../cli/services/lifecycleHooks.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const agentServiceManagerUrl = pathToFileURL(path.join(repoRoot, 'cli/services/docker/agentServiceManager.js')).href;
const dockerCommonUrl = pathToFileURL(path.join(repoRoot, 'cli/services/docker/common.js')).href;

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

test('parseManifestPorts emits runtime-chosen localhost openPorts for host port 0', () => {
    const workspaceDir = tempDir();
    try {
        const result = runModuleSnippet(
            `const { parseManifestPorts } = await import(${JSON.stringify(dockerCommonUrl)});
const manifest = {};
const profile = { openPorts: ['127.0.0.1:0:9000', '127.0.0.1:18080:8080'] };
process.stdout.write(JSON.stringify(parseManifestPorts(manifest, profile)));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            publishArgs: ['127.0.0.1::9000', '127.0.0.1:18080:8080'],
            portMappings: [
                { hostPort: 0, containerPort: 9000, hostIp: '127.0.0.1', protocol: 'tcp' },
                { hostPort: 18080, containerPort: 8080, hostIp: '127.0.0.1', protocol: 'tcp' },
            ],
        });
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('parseManifestPorts rejects legacy profile ports field', () => {
    const workspaceDir = tempDir();
    try {
        const result = runModuleSnippet(
            `const { parseManifestPorts } = await import(${JSON.stringify(dockerCommonUrl)});
try {
  parseManifestPorts({}, { ports: ['127.0.0.1:0:9000'] });
} catch (err) {
  process.stdout.write(err.message);
}`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /renamed to 'openPorts'/);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('parseManifestPorts rejects legacy manifest ports field', () => {
    const workspaceDir = tempDir();
    try {
        const result = runModuleSnippet(
            `const { parseManifestPorts } = await import(${JSON.stringify(dockerCommonUrl)});
try {
  parseManifestPorts({ ports: ['7000'] }, {});
} catch (err) {
  process.stdout.write(err.message);
}`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /renamed to profile field 'openPorts'/);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('resolvePublishedPortMappings records host ports assigned by the container runtime', () => {
    const binDir = tempDir();
    try {
        const podmanPath = path.join(binDir, 'podman');
        fs.writeFileSync(
            podmanPath,
            `#!/bin/sh
case "$1" in
  port)
    if [ "$3" = "9000/tcp" ]; then
      printf '%s\\n' '127.0.0.1:49152'
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`,
        );
        fs.chmodSync(podmanPath, 0o755);

        const result = runModuleSnippet(
            `const { resolvePublishedPortMappings } = await import(${JSON.stringify(agentServiceManagerUrl)});
const mappings = [
  { hostPort: 0, containerPort: 9000, hostIp: '127.0.0.1', protocol: 'tcp' },
  { hostPort: 18080, containerPort: 8080, hostIp: '127.0.0.1', protocol: 'tcp' },
];
process.stdout.write(JSON.stringify(resolvePublishedPortMappings('demo-container', mappings)));`,
            { PATH: binDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), [
            { hostPort: 49152, containerPort: 9000, hostIp: '127.0.0.1', protocol: 'tcp' },
            { hostPort: 18080, containerPort: 8080, hostIp: '127.0.0.1', protocol: 'tcp' },
        ]);
    } finally {
        fs.rmSync(binDir, { recursive: true, force: true });
    }
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
            `import { collectLiveAgentContainers } from './cli/services/docker/containerRegistry.js';
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
            `import { collectLiveAgentContainers } from './cli/services/docker/containerRegistry.js';
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
