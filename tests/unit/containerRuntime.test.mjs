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

function writeExecutable(filePath, contents) {
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
}

test('buildRuntimeRouterEnv uses the validated managed box-host endpoint', () => {
    const workspaceDir = tempDir();
    try {
        fs.mkdirSync(path.join(workspaceDir, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky/routing.json'), JSON.stringify({ port: 8080 }));

        const result = runModuleSnippet(
            `const { buildRuntimeRouterEnv } = await import(${JSON.stringify(agentServiceManagerUrl)});
const { buildRouterEndpoint } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/sandbox/routerPort.js')).href)});
const routerEndpoint = buildRouterEndpoint('default', 8080);
process.stdout.write(JSON.stringify(buildRuntimeRouterEnv('podman', { networkMode: 'default', routerPort: 8080, routerEndpoint })));`,
            { PLOINKY_ROUTER_HOST_PORT: '19090' },
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            PLOINKY_ROUTER_PORT: '8080',
            PLOINKY_ROUTER_HOST: 'host.containers.internal',
            PLOINKY_ROUTER_URL: 'http://host.containers.internal:8080',
            PLOINKY_ROUTER_AUTHORITY: '127.0.0.1:19090',
            PLOINKY_INTERNAL_ROUTER_URL: 'http://host.containers.internal:8081',
            PLOINKY_EDGE_TOPOLOGY_FILE: '/run/ploinky-edge-topology/current.json',
        });
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('buildRuntimeRouterEnv receives the same validated endpoint for Docker builders', () => {
    const workspaceDir = tempDir();
    try {
        fs.mkdirSync(path.join(workspaceDir, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky/routing.json'), JSON.stringify({ port: 8080 }));

        const result = runModuleSnippet(
            `const { buildRuntimeRouterEnv } = await import(${JSON.stringify(agentServiceManagerUrl)});
const { buildRouterEndpoint } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/sandbox/routerPort.js')).href)});
const routerEndpoint = buildRouterEndpoint('bridge', 8080);
process.stdout.write(JSON.stringify(buildRuntimeRouterEnv('docker', { networkMode: 'bridge', routerEndpoint })));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            PLOINKY_ROUTER_PORT: '8080',
            PLOINKY_ROUTER_HOST: 'host.containers.internal',
            PLOINKY_ROUTER_URL: 'http://host.containers.internal:8080',
            PLOINKY_ROUTER_AUTHORITY: '127.0.0.1:8080',
            PLOINKY_INTERNAL_ROUTER_URL: 'http://host.containers.internal:8081',
            PLOINKY_EDGE_TOPOLOGY_FILE: '/run/ploinky-edge-topology/current.json',
        });
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('buildRuntimeNetworkPlan delegates canonical bridge networks to the lifecycle adapter', () => {
    const workspaceDir = tempDir();
    try {
        const markerPath = `${workspaceDir}/ploinky-box-marker`;
        fs.writeFileSync(markerPath, 'assistos/ploinky-box\n');
        const result = runModuleSnippet(
            `const { buildRuntimeNetworkPlan } = await import(${JSON.stringify(agentServiceManagerUrl)});
const plan = buildRuntimeNetworkPlan('podman', {
  mode: 'bridge',
  attachments: [{ name: 'webmeet', primary: true }],
}, { boxMarkerPath: ${JSON.stringify(markerPath)} });
process.stdout.write(JSON.stringify(plan));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            mode: 'bridge',
            args: [],
            useHostNetwork: false,
            boxNetworkCompat: true,
            requiresManagedNetwork: true,
            hashEnv: { PLOINKY_NETWORK_MODE: 'bridge' },
        });
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('buildRuntimeNetworkPlan keeps canonical default mode managed in every workspace', () => {
    const workspaceDir = tempDir();
    const fakeWorkspace = path.join(workspaceDir, 'workspace');
    fs.mkdirSync(fakeWorkspace, { recursive: true });
    try {
        const result = runModuleSnippet(
            `const { buildRuntimeNetworkPlan } = await import(${JSON.stringify(agentServiceManagerUrl)});
const plan = buildRuntimeNetworkPlan('podman', { mode: 'default' }, {
  boxMarkerPath: ${JSON.stringify(path.join(workspaceDir, 'missing-marker'))},
  sourceRoot: '/opt/ploinky',
  workspacePath: ${JSON.stringify(fakeWorkspace)},
});
process.stdout.write(JSON.stringify(plan));`,
            { PLOINKY_WORKSPACE_ROOT: '/workspace' },
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            mode: 'default',
            args: [],
            useHostNetwork: false,
            boxNetworkCompat: true,
            requiresManagedNetwork: true,
            hashEnv: { PLOINKY_NETWORK_MODE: 'default' },
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

test('parseManifestPorts rejects openPorts host port 0 before runtime mutation', () => {
    const workspaceDir = tempDir();
    try {
        const result = runModuleSnippet(
            `const { parseManifestPorts } = await import(${JSON.stringify(dockerCommonUrl)});
const manifest = {};
const profile = { openPorts: ['127.0.0.1:0:9000', '127.0.0.1:18080:8080'] };
try {
  parseManifestPorts(manifest, profile);
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code || '', message: error.message }));
}`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(JSON.parse(result.stdout).message, /host port 0 is not valid for outer box publish/);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('parseManifestPorts rejects reserved Router TCP and LiveKit UDP box-side ranges', () => {
    const workspaceDir = tempDir();
    const markerPath = path.join(workspaceDir, 'etc-ploinky-box');
    try {
        fs.writeFileSync(markerPath, 'assistos/ploinky-box\n');
        const result = runModuleSnippet(
            `const { parseManifestPorts, isPloinkyBoxRuntime } = await import(${JSON.stringify(dockerCommonUrl)});
const manifest = {};
const results = [];
for (const spec of ['127.0.0.1:8080:9000', '127.0.0.1:8079-8081:9000-9002', '127.0.0.1:7882:7882/udp', '127.0.0.1:7880-7884:9000-9004/udp']) {
  try {
    parseManifestPorts(manifest, { openPorts: [spec] }, { boxMarkerPath: ${JSON.stringify(markerPath)} });
    results.push({ spec, accepted: true });
  } catch (error) {
    results.push({ spec, code: error.code, message: error.message });
  }
}
process.stdout.write(JSON.stringify({ marker: isPloinkyBoxRuntime(${JSON.stringify(markerPath)}), results }));`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.marker, true);
        assert.equal(output.results.length, 4);
        for (const record of output.results) {
            assert.equal(record.accepted, undefined, record.spec);
            assert.equal(record.code, 'PLOINKY_RESERVED_BOX_PORT', record.spec);
            assert.match(record.message, /overlaps reserved port (8080|8081|7882)/, record.spec);
        }
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
        assert.match(result.stdout, /profile field 'ports' is unsupported; use 'openPorts'/);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('AgentServer execution modes retain implicit private 7000 unless an explicit mapping targets it', () => {
    const result = runModuleSnippet(
        `const { shouldCreateImplicitAgentServerPublish } = await import(${JSON.stringify(agentServiceManagerUrl)});
process.stdout.write(JSON.stringify({
  implicit: shouldCreateImplicitAgentServerPublish({}, []),
  agentOnly: shouldCreateImplicitAgentServerPublish({ agent: 'node server.mjs' }, []),
  startAndAgent: shouldCreateImplicitAgentServerPublish({ start: 'node app.mjs', agent: 'node server.mjs' }, []),
  declaredPort: shouldCreateImplicitAgentServerPublish({ agent: 'node server.mjs' }, ['127.0.0.1::7000']),
}));`,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        implicit: true,
        agentOnly: true,
        startAndAgent: true,
        declaredPort: true,
    });
});

test('implicit AgentServer publication follows the effective profile PORT', () => {
    const result = runModuleSnippet(
        `const {
  resolveImplicitAgentServerPort,
  shouldCreateImplicitAgentServerPublish,
} = await import(${JSON.stringify(agentServiceManagerUrl)});
const configuredPort = resolveImplicitAgentServerPort({ env: { PORT: '8888' } });
const descriptorPort = resolveImplicitAgentServerPort({ env: { PORT: { default: '7681' } } });
const resolvedOverridePort = resolveImplicitAgentServerPort(
  { env: { PORT: { default: '7681' } } },
  { PORT: '8765' },
);
process.stdout.write(JSON.stringify({
  defaultPort: resolveImplicitAgentServerPort({}),
  configuredPort,
  descriptorPort,
  resolvedOverridePort,
  needsConfiguredPublish: shouldCreateImplicitAgentServerPublish({}, [], 'default', [], configuredPort),
  reusesConfiguredPublish: shouldCreateImplicitAgentServerPublish(
    {},
    [],
    'default',
    [{ containerPort: 8888, hostPort: 18888, hostIp: '127.0.0.1', protocol: 'tcp' }],
    configuredPort,
  ),
}));`,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      defaultPort: 7000,
      configuredPort: 8888,
      descriptorPort: 7681,
      resolvedOverridePort: 8765,
        needsConfiguredPublish: true,
        reusesConfiguredPublish: false,
    });
});

test('implicit AgentServer publication rejects an invalid effective profile PORT', () => {
    const result = runModuleSnippet(
        `const { resolveImplicitAgentServerPort } = await import(${JSON.stringify(agentServiceManagerUrl)});
for (const value of ['abc', '0', '65536']) {
  try {
    resolveImplicitAgentServerPort({ env: { PORT: value } });
  } catch (error) {
    process.stdout.write(value + ':' + error.message + '\\n');
  }
}`,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /abc:implicit AgentServer PORT must be an integer/);
    assert.match(result.stdout, /0:implicit AgentServer PORT must be an integer/);
    assert.match(result.stdout, /65536:implicit AgentServer PORT must be an integer/);
});

test('implicit AgentServer mapping appends without erasing or duplicating declared ports', () => {
    const result = runModuleSnippet(
        `const { appendUniquePortMapping, resolveHostPortFromRecord } = await import(${JSON.stringify(agentServiceManagerUrl)});
const declared = [{ containerPort: 8080, hostPort: 18080, protocol: 'tcp' }];
const implicit = { containerPort: 7000, hostPort: 17000, hostIp: '127.0.0.1', protocol: 'tcp' };
const once = appendUniquePortMapping(declared, implicit);
const twice = appendUniquePortMapping(once, { ...implicit, hostPort: 27000 });
const reuseRecord = { config: { ports: twice } };
process.stdout.write(JSON.stringify({
  once,
  twice,
  declaredReusePort: resolveHostPortFromRecord(reuseRecord, [8080]),
  agentServerReusePort: resolveHostPortFromRecord(reuseRecord, [7000]),
}));`,
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.once, [
        { containerPort: 8080, hostPort: 18080, protocol: 'tcp' },
        { containerPort: 7000, hostPort: 17000, hostIp: '127.0.0.1', protocol: 'tcp' },
    ]);
    assert.deepEqual(output.twice, output.once);
    assert.equal(output.declaredReusePort, 18080);
    assert.equal(output.agentServerReusePort, 17000);
});

test('start-only execution never fabricates an AgentServer 7000 publish', () => {
    const result = runModuleSnippet(
        `const { shouldCreateImplicitAgentServerPublish } = await import(${JSON.stringify(agentServiceManagerUrl)});
process.stdout.write(JSON.stringify({
  script: shouldCreateImplicitAgentServerPublish({ start: 'postgres', health: { readiness: { script: 'healthcheck.sh' } } }, []),
  none: shouldCreateImplicitAgentServerPublish({ start: 'sleep infinity', readiness: { protocol: 'none' } }, []),
  privateServer: shouldCreateImplicitAgentServerPublish({ start: 'node app.mjs' }, []),
}));`,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        script: false,
        none: false,
        privateServer: false,
    });
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

test('getConfiguredProjectPath recognizes a qualified static agent identity', () => {
    const workspaceDir = tempDir();
    try {
        fs.mkdirSync(path.join(workspaceDir, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky/agents.json'), JSON.stringify({
            _config: { static: { agent: 'repo/demo' } },
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
        assert.equal(result.stdout, workspaceDir);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
});

test('global enabled agents keep workspace projectPath and declare persistent /root home', () => {
    const workspaceDir = tempDir();
    const binDir = tempDir('ploinky-fake-runtime-');
    try {
        const stateFile = path.join(binDir, 'container-name.txt');
        const runningFile = path.join(binDir, 'container-running.txt');
        const argsFile = path.join(binDir, 'run-args.txt');
        const inspectHelper = path.join(binDir, 'inspect-helper.mjs');
        const podmanPath = path.join(binDir, 'podman');
        fs.writeFileSync(inspectHelper, `
import fs from 'node:fs';
const [argsPath, statePath, runningPath] = process.argv.slice(2);
const args = fs.readFileSync(argsPath, 'utf8').split(/\\r?\\n/).filter(Boolean);
const labels = {};
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== '--label') continue;
  const [key, ...value] = String(args[index + 1] || '').split('=');
  labels[key] = value.join('=');
}
const running = fs.existsSync(runningPath);
process.stdout.write(JSON.stringify([{
  Id: 'candidate1234567890',
  Name: fs.readFileSync(statePath, 'utf8').trim(),
  Config: { Labels: labels },
  HostConfig: { Init: args.includes('--init'), NetworkMode: 'none' },
  NetworkSettings: { Networks: {} },
  State: { Running: running, Status: running ? 'running' : 'configured' },
}]));
`);
        fs.writeFileSync(
            podmanPath,
            `#!/bin/sh
emit_inspect() {
  [ -f ${JSON.stringify(stateFile)} ] || exit 1
  ${JSON.stringify(process.execPath)} ${JSON.stringify(inspectHelper)} ${JSON.stringify(argsFile)} ${JSON.stringify(stateFile)} ${JSON.stringify(runningFile)}
}
case "$1" in
  image)
    exit 0
    ;;
  inspect)
    emit_inspect
    ;;
  container)
    [ "$2" = "inspect" ] || exit 1
    emit_inspect
    ;;
  create)
    printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
    name=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--name" ]; then name="$arg"; break; fi
      prev="$arg"
    done
    printf '%s\\n' "$name" > ${JSON.stringify(stateFile)}
    exit 0
    ;;
  start)
    : > ${JSON.stringify(runningFile)}
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
            network: { mode: 'none' },
            readiness: { protocol: 'none' },
        }));
        fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080, routes: {} }));
        fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'agents.json'), '{}');
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'data', 'router-security'), { recursive: true });
        fs.writeFileSync(
            path.join(workspaceDir, '.ploinky', 'data', 'router-security', 'policy-state.json'),
            JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }),
        );
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'data', 'edge-routing'), { recursive: true });
        fs.writeFileSync(
            path.join(workspaceDir, '.ploinky', 'data', 'edge-routing', 'desired.json'),
            JSON.stringify({
                hosts: {},
            }),
        );
        fs.writeFileSync(path.join(agentDir, 'mcp-config.json'), JSON.stringify({
            tools: [
                { name: 'demo_internal', tags: ['internal'] },
                { name: 'demo_authenticated' },
            ],
        }));

        const result = runModuleSnippet(
            `const { enableAgent } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/utils/agents.js')).href)});
await enableAgent('repo/demo', 'global');
const fs = await import('node:fs');
const path = await import('node:path');
const agents = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.ploinky', 'agents.json'), 'utf8'));
const record = Object.values(agents).find((entry) => entry && entry.agentName === 'demo');
const policyState = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.ploinky', 'data', 'router-security', 'policy-state.json'), 'utf8'));
console.log(JSON.stringify({ record, mcpTools: policyState.mcpTools }));`,
            { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const { record, mcpTools } = JSON.parse(result.stdout.trim().split('\n').at(-1));
        assert.equal(record.runMode, 'global');
        assert.equal(record.projectPath, workspaceDir);
        assert.deepEqual(record.config.ports, []);
        const createArgs = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
        assert.ok(createArgs.includes('--init'));
        assert.ok(createArgs.includes(`WORKSPACE_PATH=${workspaceDir}`));
        assert.doesNotMatch(createArgs.join('\n'), /(?:^|:)7000(?:$|\s)/);
        assert.ok(record.config.binds.some((bind) => (
            bind.source === workspaceDir && bind.target === workspaceDir
        )));
        assert.ok(record.config.binds.some((bind) => (
            bind.source === path.join(workspaceDir, '.data', 'demo') && bind.target === '/root'
        )));
        assert.deepEqual(
            mcpTools.map(({ agent, tool, access, enabled }) => ({ agent, tool, access, enabled })),
            [
                { agent: 'demo', tool: 'demo_internal', access: 'internal', enabled: true },
                { agent: 'demo', tool: 'demo_authenticated', access: 'authenticated', enabled: true },
            ],
        );
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('enable rejects a missing persisted router port before registry mutation', () => {
    const workspaceDir = tempDir();
    try {
        const agentDir = path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'demo');
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({
            container: 'example/demo:latest',
            start: 'sleep 3600',
            network: { mode: 'default' },
            readiness: { protocol: 'none' },
        }));

        const result = runModuleSnippet(
            `const { enableAgent } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/utils/agents.js')).href)});
await enableAgent('repo/demo', 'global');`,
            {},
            { cwd: workspaceDir },
        );

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /persisted router port is required/i);
        assert.equal(fs.existsSync(path.join(workspaceDir, '.ploinky', 'agents.json')), false);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
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

test('host-mode capability denial occurs before the manifest preinstall hook', () => {
    const workspaceDir = tempDir('ploinky-host-capability-');
    try {
        const agentDir = path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'demo');
        const marker = path.join(workspaceDir, 'host-hook-ran');
        fs.mkdirSync(agentDir, { recursive: true });
        writeExecutable(path.join(agentDir, 'preinstall.sh'), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`);
        const manifest = {
            container: 'example/demo@sha256:' + 'a'.repeat(64),
            start: 'sleep 3600',
            network: { mode: 'host' },
            profiles: { default: { preinstall: 'preinstall.sh' } },
            readiness: { protocol: 'none' },
        };
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest));
        fs.mkdirSync(path.join(workspaceDir, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'agents.json'), JSON.stringify({
            test_host: {
                type: 'agent',
                repoName: 'repo',
                agentName: 'demo',
                projectPath: workspaceDir,
                runMode: 'global',
                instanceId: 'instance-current',
                enableGeneration: 'enable-current',
            },
        }));
        fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'routing.json'), JSON.stringify({ static: { port: 8080 }, routes: {} }));

        const result = runModuleSnippet(
            `const fs = await import('node:fs');
const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const { buildRouterEndpoint } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/sandbox/routerPort.js')).href)});
const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(agentDir, 'manifest.json'))}, 'utf8'));
try {
  startAgentContainer('demo', manifest, ${JSON.stringify(agentDir)}, {
    containerName: 'test_host',
    profileName: 'default',
    routerEndpoint: buildRouterEndpoint('host', 8080),
    runtimeIdentity: { instanceId: 'instance-current', enableGeneration: 'enable-current' },
  });
  console.log('UNEXPECTED_SUCCESS');
} catch (error) {
  console.log(error.code || error.message);
}`,
            { CONTAINER_RUNTIME: 'podman' },
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /EDGE_GENERATION_INACTIVE|HOST_MODE_CAPABILITY_DENIED/);
        assert.equal(fs.existsSync(marker), false, 'denied host mode must not execute preinstall');
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
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
