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
import { buildExecArgs } from '../../cli/services/docker/interactive.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const agentServiceManagerUrl = pathToFileURL(path.join(repoRoot, 'cli/services/docker/agentServiceManager.js')).href;
const dockerCommonUrl = pathToFileURL(path.join(repoRoot, 'cli/services/docker/common.js')).href;

function tempDir(prefix = 'ploinky-runtime-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeLlmCatalog(catalogRoot) {
    fs.mkdirSync(path.join(catalogRoot, 'architectures'), { recursive: true });
    fs.mkdirSync(path.join(catalogRoot, 'images'), { recursive: true });
    fs.writeFileSync(path.join(catalogRoot, 'catalog.json'), JSON.stringify({
        schemaVersion: 1,
        catalogId: 'test/catalog',
        defaultFallback: 'cpu-amd64',
        architectures: [{ id: 'cpu-amd64', path: 'architectures/cpu-amd64.json' }],
        images: [{ id: 'cpu-amd64', path: 'images/cpu-amd64.json' }],
    }));
    fs.writeFileSync(path.join(catalogRoot, 'architectures/cpu-amd64.json'), JSON.stringify({
        id: 'cpu-amd64',
        status: 'stable',
        platform: 'linux/amd64',
        accelerator: { family: 'cpu' },
        match: { requiredProbes: [] },
        image: 'cpu-amd64',
        runtimePolicy: { platform: 'linux/amd64', resources: { memory: '4g' }, ipc: 'default' },
        engineDefaults: { enginePort: 8080, runtimePort: 9000 },
    }));
    fs.writeFileSync(path.join(catalogRoot, 'images/cpu-amd64.json'), JSON.stringify({
        id: 'cpu-amd64',
        ref: 'reg.example.com/llm-cpu-amd64:dev',
        digest: 'sha256:' + 'c'.repeat(64),
        platform: 'linux/amd64',
        engines: ['llamacpp'],
        build: {
            context: 'container-image-builds',
            dockerfile: 'container-image-builds/images/llm-runtime-cpu/Dockerfile',
            workflow: 'container-image-builds/.github/workflows/publish-llm-runtime-images.yml',
            engineVersionsLock: 'container-image-builds/images/llm-runtime-cpu/engineVersions.lock.json',
        },
    }));
}

function writeFakeDocker(binDir, captureFile, options = {}) {
    const dockerPath = path.join(binDir, 'docker');
    const stateFile = path.join(binDir, 'docker-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
        exists: Boolean(options.existingContainer),
        running: Boolean(options.existingContainer),
        envHash: options.envHash || '',
        reuseHash: options.reuseHash || '',
        rmCount: 0,
    }));
    fs.writeFileSync(dockerPath, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return {}; }
}
function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
function valueAfter(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : '';
}
if (args[0] === 'image' && args[1] === 'inspect') process.exit(0);
if (args[0] === 'inspect') {
  const state = readState();
  if (!state.exists) process.exit(1);
  if (args.includes('{{ json .Config.Labels }}')) {
    process.stdout.write(JSON.stringify({
      'ploinky.envhash': process.env.PLOINKY_FAKE_ENVHASH || state.envHash || '',
      'ploinky.reusehash': process.env.PLOINKY_FAKE_REUSEHASH || state.reuseHash || '',
    }));
    process.exit(0);
  }
  process.stdout.write('/llm-container\\n');
  process.exit(0);
}
if (args[0] === 'ps') {
  const state = readState();
  if (state.exists && state.running) process.stdout.write('llm-container\\n');
  process.exit(0);
}
if (args[0] === 'stop') {
  const state = readState();
  state.running = false;
  writeState(state);
  process.exit(0);
}
if (args[0] === 'rm') {
  const state = readState();
  state.exists = false;
  state.running = false;
  state.rmCount = Number(state.rmCount || 0) + 1;
  writeState(state);
  process.exit(0);
}
if (args[0] === 'network') process.exit(0);
if (args[0] === 'run' && args.includes('--entrypoint') && valueAfter('--entrypoint') === 'node') {
  process.stdout.write(JSON.stringify({ platform: 'linux', arch: 'x64', nodeMajor: 20, libc: 'glibc' }));
  process.exit(0);
}
if (args[0] === 'run' && args.includes('--entrypoint') && valueAfter('--entrypoint') === 'test') process.exit(0);
if (args[0] === 'run' && args.includes('--rm')) {
  const mount = valueAfter('-v');
  const hostPath = String(mount || '').split(':/install')[0];
  if (hostPath) fs.mkdirSync(hostPath + '/node_modules/mcp-sdk', { recursive: true });
  process.exit(0);
}
if (args[0] === 'run' && args.includes('-d')) {
  const state = readState();
  state.exists = true;
  state.running = true;
  writeState(state);
  fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(args));
  process.exit(0);
}
process.exit(0);
`);
    fs.chmodSync(dockerPath, 0o755);
    return { dockerPath, stateFile };
}

function writeFakeHostSandboxBins(binDir, markerFile) {
    for (const commandName of ['sandbox-exec', 'bwrap']) {
        const commandPath = path.join(binDir, commandName);
        fs.writeFileSync(commandPath, `#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(markerFile)}, ${JSON.stringify(commandName)});
process.exit(1);
`);
        fs.chmodSync(commandPath, 0o755);
    }
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

function createLlmStartFixture(options = {}) {
    const workspaceDir = tempDir();
    const binDir = tempDir('ploinky-fake-docker-');
    const captureFile = path.join(workspaceDir, 'docker-args.json');
    const agentPath = path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent');
    fs.mkdirSync(agentPath, { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'code'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'agents.json'), JSON.stringify({}));
    fs.symlinkSync(agentPath, path.join(workspaceDir, '.ploinky', 'code', 'llmAgent'), 'dir');
    const catalogRoot = path.join(workspaceDir, 'catalog');
    if (options.writeCatalog !== false) {
        writeLlmCatalog(catalogRoot);
    }
    const fakeDocker = writeFakeDocker(binDir, captureFile, options.docker || {});
    return {
        workspaceDir,
        binDir,
        captureFile,
        agentPath,
        catalogRoot,
        fakeDocker,
        cleanup() {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
            fs.rmSync(binDir, { recursive: true, force: true });
        },
    };
}

function enableFakePodmanRuntime(fixture) {
    const podmanPath = path.join(fixture.binDir, 'podman');
    fs.copyFileSync(fixture.fakeDocker.dockerPath, podmanPath);
    fs.chmodSync(podmanPath, 0o755);
    return podmanPath;
}

function volumeMounts(args) {
    return args
        .map((arg, idx) => arg === '-v' ? String(args[idx + 1] || '') : '')
        .filter(Boolean);
}

function mountSource(mount) {
    return String(mount || '').split(':')[0] || '';
}

function mountTarget(mount) {
    return String(mount || '').split(':')[1] || '';
}

function pathContains(parentPath, childPath) {
    const rel = path.relative(parentPath, childPath);
    return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertOnlySecretMountExposesSecretFile(args, secretHostPath) {
    for (const mount of volumeMounts(args)) {
        if (mountTarget(mount) === '/run/secrets/hf_token') continue;
        assert.equal(pathContains(mountSource(mount), secretHostPath), false, `${mount} must not expose model secret file`);
    }
}

function secretFileMount(args) {
    return volumeMounts(args).find((mount) => mountTarget(mount) === '/run/secrets/hf_token') || '';
}

test('startAgentContainer emits clean LLM runtime mounts env ports and image entrypoint startup', () => {
    const workspaceDir = tempDir();
    const binDir = tempDir('ploinky-fake-docker-');
    const captureFile = path.join(workspaceDir, 'docker-args.json');
    try {
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'code'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'shared'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'agents.json'), JSON.stringify({}));
        fs.symlinkSync(
            path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent'),
            path.join(workspaceDir, '.ploinky', 'code', 'llmAgent'),
            'dir',
        );
        const catalogRoot = path.join(workspaceDir, 'catalog');
        writeLlmCatalog(catalogRoot);
        writeFakeDocker(binDir, captureFile);

        const result = runModuleSnippet(
            `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = { llmRuntime: { enabled: true }, container: 'placeholder:unused' };
const agentPath = ${JSON.stringify(path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent'))};
startAgentContainer('llmAgent', manifest, agentPath, { containerName: 'llm-container', publish: ['127.0.0.1:19000:9000', '127.0.0.1:18080:8080'], publishMappings: [{ hostIp: '127.0.0.1', hostPort: 19000, containerPort: 9000, protocol: 'tcp' }, { hostIp: '127.0.0.1', hostPort: 18080, containerPort: 8080, protocol: 'tcp' }] });`,
            {
                PATH: binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const args = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
        const imageRunRef = `reg.example.com/llm-cpu-amd64:dev@sha256:${'c'.repeat(64)}`;
        const imageIndex = args.indexOf(imageRunRef);
        assert.ok(imageIndex > 0, 'catalog-selected runtime image digest must be used');
        assert.equal(args.includes('reg.example.com/llm-cpu-amd64:dev'), false, 'tag-only runtime image must not be passed to docker run');
        assert.deepEqual(args.slice(imageIndex + 1), [], 'LLM runtime without explicit command must run the image ENTRYPOINT');
        assert.ok(args.includes('127.0.0.1:19000:9000'));
        assert.ok(args.includes('127.0.0.1:18080:8080'));
        assert.ok(args.some((arg) => String(arg).endsWith(':/workspace')));
        assert.ok(args.some((arg) => String(arg).endsWith(':/models')));
        assert.ok(args.some((arg) => String(arg).endsWith(':/runtime')));
        assert.equal(args.some((arg) => String(arg).includes('/Agent/llm-runtime')), false);
        const envPairs = args
            .map((arg, idx) => arg === '-e' ? args[idx + 1] : '')
            .filter(Boolean);
        assert.ok(envPairs.includes('HF_HOME=/models/hf-cache'));
        assert.ok(envPairs.includes('PLOINKY_MODELS_DIR=/models/artifacts'));
        assert.ok(envPairs.includes('PLOINKY_DERIVED_DIR=/models/derived'));
        assert.ok(envPairs.includes('PLOINKY_RUNTIME_DIR=/runtime'));
        assert.ok(envPairs.includes('PLOINKY_LAUNCHERS_DIR=/workspace/modelLaunchers'));
        assert.ok(envPairs.includes('PLOINKY_MCP_PORT=9000'));
        assert.ok(envPairs.includes('PLOINKY_INFERENCE_PORT=8080'));
        assert.ok(envPairs.includes('PLOINKY_INVOCATION_AUTH_MODULE=/Agent/lib/invocationAuth.mjs'));
        assert.ok(envPairs.includes('PLOINKY_REQUEST_HASH_MODULE=/Agent/lib/requestHash.mjs'));
        assert.equal(envPairs.some((entry) => entry.startsWith('PLOINKY_LLM_PUBLIC_PORT=')), false);
        assert.equal(envPairs.some((entry) => entry.startsWith('PLOINKY_LLM_MCP_PORT=')), false);
        assert.equal(envPairs.some((entry) => entry.startsWith('PLOINKY_LLM_CONTROL_PORT=')), false);
        assert.equal(args.some((arg) => /AgentServer\\.sh|start-runtime-agent/.test(String(arg))), false);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('startAgentContainer does not allow config to inject LLM auth module env into non-LLM containers', () => {
    const fixture = createLlmStartFixture({ writeCatalog: false });
    try {
        const manifest = {
            container: 'placeholder:unused',
            env: [
                { name: 'PLOINKY_INVOCATION_AUTH_MODULE', value: '/tmp/config-invocation.mjs' },
                { name: 'PLOINKY_REQUEST_HASH_MODULE', value: '/tmp/config-request-hash.mjs' },
            ],
            profiles: {
                default: {
                    env: {
                        PLOINKY_INVOCATION_AUTH_MODULE: '/tmp/profile-invocation.mjs',
                        PLOINKY_REQUEST_HASH_MODULE: '/tmp/profile-request-hash.mjs',
                    },
                },
            },
            runtime: {
                resources: {
                    env: {
                        PLOINKY_INVOCATION_AUTH_MODULE: '/tmp/runtime-invocation.mjs',
                        PLOINKY_REQUEST_HASH_MODULE: '/tmp/runtime-request-hash.mjs',
                    },
                },
            },
        };
        fs.writeFileSync(path.join(fixture.agentPath, 'manifest.json'), JSON.stringify(manifest));
        const result = runModuleSnippet(
            `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'plain-container', profileName: 'default' });`,
            {
                PATH: fixture.binDir,
            },
            { cwd: fixture.workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const args = JSON.parse(fs.readFileSync(fixture.captureFile, 'utf8'));
        const envPairs = args
            .map((arg, idx) => arg === '-e' ? args[idx + 1] : '')
            .filter(Boolean);
        assert.equal(envPairs.some((entry) => entry.startsWith('PLOINKY_INVOCATION_AUTH_MODULE=')), false);
        assert.equal(envPairs.some((entry) => entry.startsWith('PLOINKY_REQUEST_HASH_MODULE=')), false);
    } finally {
        fixture.cleanup();
    }
});

test('ensureAgentService publishes default LLM runtime ports on loopback', () => {
    const workspaceDir = tempDir();
    const binDir = tempDir('ploinky-fake-docker-');
    const captureFile = path.join(workspaceDir, 'docker-args.json');
    try {
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'code'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'shared'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'agents.json'), JSON.stringify({}));
        fs.symlinkSync(
            path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent'),
            path.join(workspaceDir, '.ploinky', 'code', 'llmAgent'),
            'dir',
        );
        const catalogRoot = path.join(workspaceDir, 'catalog');
        writeLlmCatalog(catalogRoot);
        writeFakeDocker(binDir, captureFile);

        const result = runModuleSnippet(
            `const { ensureAgentService } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = { llmRuntime: { enabled: true }, container: 'placeholder:unused' };
const agentPath = ${JSON.stringify(path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent'))};
ensureAgentService('llmAgent', manifest, agentPath, { containerName: 'llm-container', preferredHostPort: 19000, forceRecreate: true });`,
            {
                PATH: binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const args = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
        assert.ok(args.includes('127.0.0.1:19000:9000'));
        assert.ok(args.some((arg) => /^127\.0\.0\.1:\d+:8080$/.test(String(arg))));
        assert.equal(args.includes('127.0.0.1:19000:7000'), false);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('ensureAgentService keeps LLM runtimes on the container path when lite-sandbox is requested', () => {
    const fixture = createLlmStartFixture();
    try {
        const hostSandboxMarker = path.join(fixture.workspaceDir, 'host-sandbox-called.txt');
        writeFakeHostSandboxBins(fixture.binDir, hostSandboxMarker);
        fs.writeFileSync(path.join(fixture.workspaceDir, '.ploinky', 'agents.json'), JSON.stringify({
            _config: {
                sandbox: {
                    disableHostRuntimes: false,
                },
            },
        }));
        const manifest = {
            llmRuntime: { enabled: true },
            container: 'placeholder:unused',
            'lite-sandbox': true,
        };

        const result = runModuleSnippet(
            `const { ensureAgentService } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
ensureAgentService('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container', preferredHostPort: 19000, forceRecreate: true });`,
            {
                PATH: fixture.binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: fixture.workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.existsSync(hostSandboxMarker), false, 'LLM runtime must not dispatch to host sandbox binaries');
        const args = JSON.parse(fs.readFileSync(fixture.captureFile, 'utf8'));
        const imageRunRef = `reg.example.com/llm-cpu-amd64:dev@sha256:${'c'.repeat(64)}`;
        const imageIndex = args.indexOf(imageRunRef);
        assert.ok(imageIndex > 0, 'catalog-selected runtime image digest must be used');
        assert.equal(args.includes('reg.example.com/llm-cpu-amd64:dev'), false, 'tag-only runtime image must not be passed to docker run');
        assert.deepEqual(args.slice(imageIndex + 1), [], 'LLM runtime must still run the image ENTRYPOINT');
        assert.ok(args.includes('127.0.0.1:19000:9000'));
        assert.ok(args.some((arg) => /^127\.0\.0\.1:\d+:8080$/.test(String(arg))));
        assert.equal(args.some((arg) => /AgentServer\\.sh|start-runtime-agent/.test(String(arg))), false);
    } finally {
        fixture.cleanup();
    }
});

test('startAgentContainer normalizes LLM runtime openPorts to loopback', () => {
    const workspaceDir = tempDir();
    const binDir = tempDir('ploinky-fake-docker-');
    const captureFile = path.join(workspaceDir, 'docker-args.json');
    try {
        const agentPath = path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent');
        fs.mkdirSync(agentPath, { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'code'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'shared'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'agents.json'), JSON.stringify({}));
        fs.symlinkSync(agentPath, path.join(workspaceDir, '.ploinky', 'code', 'llmAgent'), 'dir');
        const catalogRoot = path.join(workspaceDir, 'catalog');
        writeLlmCatalog(catalogRoot);
        writeFakeDocker(binDir, captureFile);
        const manifest = {
            llmRuntime: { enabled: true },
            container: 'placeholder:unused',
            profiles: {
                default: {
                    openPorts: ['0.0.0.0:19000:9000', '0.0.0.0:18080:8080'],
                },
            },
        };
        fs.writeFileSync(path.join(agentPath, 'manifest.json'), JSON.stringify(manifest));

        const result = runModuleSnippet(
            `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(agentPath)}, { containerName: 'llm-container', profileName: 'default' });`,
            {
                PATH: binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const args = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
        assert.ok(args.includes('127.0.0.1:19000:9000'));
        assert.ok(args.includes('127.0.0.1:18080:8080'));
        assert.equal(args.includes('0.0.0.0:19000:9000'), false);
        assert.equal(args.includes('0.0.0.0:18080:8080'), false);
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('startAgentContainer rejects host networking for LLM runtimes', () => {
    const workspaceDir = tempDir();
    const binDir = tempDir('ploinky-fake-docker-');
    const captureFile = path.join(workspaceDir, 'docker-args.json');
    try {
        const agentPath = path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent');
        fs.mkdirSync(agentPath, { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'code'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'shared'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'agents.json'), JSON.stringify({}));
        fs.symlinkSync(agentPath, path.join(workspaceDir, '.ploinky', 'code', 'llmAgent'), 'dir');
        const catalogRoot = path.join(workspaceDir, 'catalog');
        writeLlmCatalog(catalogRoot);
        writeFakeDocker(binDir, captureFile);
        const manifest = {
            llmRuntime: { enabled: true },
            container: 'placeholder:unused',
            network: { mode: 'host' },
        };

        const result = runModuleSnippet(
            `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(agentPath)}, { containerName: 'llm-container' });`,
            {
                PATH: binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: workspaceDir },
        );

        assert.notEqual(result.status, 0, 'LLM runtime host networking must fail closed');
        assert.match(result.stderr, /network\.mode 'host'.*LLM runtime|LLM runtime.*network\.mode 'host'/);
        assert.equal(fs.existsSync(captureFile), false, 'host-networked LLM container must not be started');
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('startAgentContainer rejects host network names for LLM runtimes', () => {
    const fixture = createLlmStartFixture();
    try {
        const manifest = {
            llmRuntime: { enabled: true },
            container: 'placeholder:unused',
            network: { name: 'host' },
        };

        const result = runModuleSnippet(
            `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container' });`,
            {
                PATH: fixture.binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: fixture.workspaceDir },
        );

        assert.notEqual(result.status, 0, 'LLM runtime host network names must fail closed');
        assert.match(result.stderr, /network\.name 'host'.*LLM runtime|LLM runtime.*network\.name 'host'/);
        assert.equal(fs.existsSync(fixture.captureFile), false, 'host-networked LLM container must not be started');
    } finally {
        fixture.cleanup();
    }
});

test('startAgentContainer rejects explicit commands for LLM runtime manifests', () => {
    const cases = [
        { label: 'start', manifest: { llmRuntime: { enabled: true }, container: 'placeholder:unused', start: 'start-runtime-agent.sh' } },
        { label: 'agent', manifest: { llmRuntime: { enabled: true }, container: 'placeholder:unused', agent: 'sh /Agent/server/AgentServer.sh' } },
        { label: 'commands.run', manifest: { llmRuntime: { enabled: true }, container: 'placeholder:unused', commands: { run: 'sh -lc ./run.sh' } } },
        { label: 'entrypoint', manifest: { llmRuntime: { enabled: true }, container: 'placeholder:unused', entrypoint: '/bin/custom-entrypoint' } },
    ];
    for (const entry of cases) {
        const fixture = createLlmStartFixture();
        try {
            const result = runModuleSnippet(
                `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(entry.manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container' });`,
                {
                    PATH: fixture.binDir,
                    PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                    PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                },
                { cwd: fixture.workspaceDir },
            );

            assert.notEqual(result.status, 0, `${entry.label} must be rejected for LLM runtime manifests`);
            assert.match(result.stderr, /startup command|entrypoint|image ENTRYPOINT|LLM runtime/);
            assert.equal(fs.existsSync(fixture.captureFile), false, `${entry.label} must not start an LLM container`);
        } finally {
            fixture.cleanup();
        }
    }
});

test('startAgentContainer normalizes LLM runtime UDP openPorts to TCP', () => {
    const fixture = createLlmStartFixture();
    try {
        const manifest = {
            llmRuntime: { enabled: true },
            container: 'placeholder:unused',
            profiles: {
                default: {
                    openPorts: ['127.0.0.1:19000:9000/udp', '127.0.0.1:18080:8080/udp'],
                },
            },
        };
        fs.writeFileSync(path.join(fixture.agentPath, 'manifest.json'), JSON.stringify(manifest));

        const result = runModuleSnippet(
            `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container', profileName: 'default' });`,
            {
                PATH: fixture.binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: fixture.workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const args = JSON.parse(fs.readFileSync(fixture.captureFile, 'utf8'));
        assert.ok(args.includes('127.0.0.1:19000:9000'));
        assert.ok(args.includes('127.0.0.1:18080:8080'));
        assert.equal(args.some((arg) => /9000\/udp|8080\/udp/.test(String(arg))), false);
    } finally {
        fixture.cleanup();
    }
});

test('startAgentContainer removes LLM runtime UDP openPort ranges that include runtime ports', () => {
    const fixture = createLlmStartFixture();
    try {
        const manifest = {
            llmRuntime: { enabled: true },
            container: 'placeholder:unused',
            profiles: {
                default: {
                    openPorts: [
                        '127.0.0.1:18999-19001:8999-9001/udp',
                        '127.0.0.1:18079-18081:8079-8081/udp',
                    ],
                },
            },
        };
        fs.writeFileSync(path.join(fixture.agentPath, 'manifest.json'), JSON.stringify(manifest));

        const result = runModuleSnippet(
            `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container', profileName: 'default' });`,
            {
                PATH: fixture.binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: fixture.workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const args = JSON.parse(fs.readFileSync(fixture.captureFile, 'utf8'));
        assert.ok(args.includes('127.0.0.1:19000:9000'));
        assert.ok(args.includes('127.0.0.1:18080:8080'));
        assert.equal(args.some((arg) => /8999-9001\/udp|8079-8081\/udp|9000\/udp|8080\/udp/.test(String(arg))), false);
    } finally {
        fixture.cleanup();
    }
});

test('startAgentContainer rejects retired LLM runtime env injection names', () => {
    const cases = [
        {
            label: 'manifest env',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                env: [{ name: 'PLOINKY_LLM_PUBLIC_PORT', value: '19000' }],
            },
        },
        {
            label: 'profile env',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                profiles: {
                    default: {
                        env: { PLOINKY_LLM_MCP_PORT: '9001' },
                    },
                },
            },
            profileName: 'default',
        },
        {
            label: 'object expose',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                expose: { PLOINKY_LLM_CONTROL_PORT: '9002' },
            },
        },
        {
            label: 'array expose',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                expose: [{ name: 'PLOINKY_LLM_LAUNCHERS_DIR', value: '/bad' }],
            },
        },
        {
            label: 'array expose source ref',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                expose: [{ name: 'CLEAN_ALIAS', ref: 'PLOINKY_LLM_PUBLIC_PORT' }],
            },
        },
        {
            label: 'object expose source ref',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                expose: { CLEAN_ALIAS: '$PLOINKY_LLM_MCP_PORT' },
            },
        },
        {
            label: 'manifest env source alias',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                env: [{ name: 'CLEAN_ALIAS', varName: 'PLOINKY_LLM_MCP_PORT' }],
            },
        },
        {
            label: 'profile env source alias',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                profiles: {
                    default: {
                        env: {
                            CLEAN_ALIAS: { varName: 'PLOINKY_LLM_CONTROL_PORT' },
                        },
                    },
                },
            },
            profileName: 'default',
        },
        {
            label: 'profile env source name',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                profiles: {
                    default: {
                        env: {
                            CLEAN_ALIAS: { name: 'PLOINKY_LLM_LAUNCHERS_DIR' },
                        },
                    },
                },
            },
            profileName: 'default',
        },
        {
            label: 'runtime resource env template',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                runtime: {
                    resources: {
                        env: {
                            CLEAN_ALIAS: '{{var:PLOINKY_LLM_MCP_PORT}}',
                        },
                    },
                },
            },
        },
    ];

    for (const entry of cases) {
        const fixture = createLlmStartFixture();
        try {
            if (entry.profileName) {
                fs.writeFileSync(path.join(fixture.agentPath, 'manifest.json'), JSON.stringify(entry.manifest));
            }
            const result = runModuleSnippet(
                `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(entry.manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container', profileName: ${JSON.stringify(entry.profileName || '')} });`,
                {
                    PATH: fixture.binDir,
                    PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                    PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                    PLOINKY_LLM_PUBLIC_PORT: '18999',
                    PLOINKY_LLM_MCP_PORT: '19000',
                    PLOINKY_LLM_CONTROL_PORT: '19001',
                    PLOINKY_LLM_LAUNCHERS_DIR: '/bad',
                },
                { cwd: fixture.workspaceDir },
            );

            assert.notEqual(result.status, 0, `${entry.label} must be rejected for LLM runtime manifests`);
            assert.match(result.stderr, /retired LLM runtime env|PLOINKY_LLM_/);
            assert.equal(fs.existsSync(fixture.captureFile), false, `${entry.label} must not start an LLM container`);
        } finally {
            fixture.cleanup();
        }
    }
});

test('startAgentContainer rejects plain HF_TOKEN env for LLM runtime manifests', () => {
    const cases = [
        {
            label: 'manifest env',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                env: [{ name: 'HF_TOKEN', value: 'plain-token' }],
            },
        },
        {
            label: 'profile env',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                profiles: {
                    default: {
                        env: { HF_TOKEN: 'plain-token' },
                    },
                },
            },
            profileName: 'default',
        },
        {
            label: 'runtime resource env',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                runtime: {
                    resources: {
                        env: {
                            HF_TOKEN: 'plain-token',
                        },
                    },
                },
            },
        },
        {
            label: 'manifest env source alias',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                env: [{ name: 'MODEL_TOKEN_ALIAS', varName: 'HF_TOKEN' }],
            },
        },
        {
            label: 'profile env source alias',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                profiles: {
                    default: {
                        env: {
                            MODEL_TOKEN_ALIAS: { varName: 'HF_TOKEN' },
                        },
                    },
                },
            },
            profileName: 'default',
        },
        {
            label: 'profile env source name',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                profiles: {
                    default: {
                        env: {
                            MODEL_TOKEN_ALIAS: { name: 'HF_TOKEN' },
                        },
                    },
                },
            },
            profileName: 'default',
        },
        {
            label: 'runtime resource env template',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                runtime: {
                    resources: {
                        env: {
                            MODEL_TOKEN_ALIAS: '{{var:HF_TOKEN}}',
                        },
                    },
                },
            },
        },
        {
            label: 'array expose source ref',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                expose: [{ name: 'MODEL_TOKEN_ALIAS', ref: 'HF_TOKEN' }],
            },
        },
        {
            label: 'object expose source ref',
            manifest: {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                expose: { MODEL_TOKEN_ALIAS: '$HF_TOKEN' },
            },
        },
    ];

    for (const entry of cases) {
        const fixture = createLlmStartFixture();
        try {
            if (entry.profileName) {
                fs.writeFileSync(path.join(fixture.agentPath, 'manifest.json'), JSON.stringify(entry.manifest));
            }
            const result = runModuleSnippet(
                `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(entry.manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container', profileName: ${JSON.stringify(entry.profileName || '')} });`,
                {
                    PATH: fixture.binDir,
                    PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                    PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                    HF_TOKEN: 'plain-token',
                },
                { cwd: fixture.workspaceDir },
            );

            assert.notEqual(result.status, 0, `${entry.label} must reject plain HF_TOKEN`);
            assert.match(result.stderr, /HF_TOKEN|secret env|LLM runtime/);
            assert.doesNotMatch(result.stderr, /plain-token/);
            assert.equal(fs.existsSync(fixture.captureFile), false, `${entry.label} must not start an LLM container`);
        } finally {
            fixture.cleanup();
        }
    }
});

test('startAgentContainer allows HF_TOKEN through profile secrets and keeps selected state redacted', () => {
    const fixture = createLlmStartFixture();
    try {
        const secretToken = ['secret', 'token'].join('-');
        const manifest = {
            llmRuntime: { enabled: true },
            container: 'placeholder:unused',
            profiles: {
                default: {
                    secrets: ['HF_TOKEN'],
                },
            },
        };
        fs.writeFileSync(path.join(fixture.agentPath, 'manifest.json'), JSON.stringify(manifest));

        const result = runModuleSnippet(
            `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container', profileName: 'default' });`,
            {
                PATH: fixture.binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                HF_TOKEN: secretToken,
            },
            { cwd: fixture.workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const args = JSON.parse(fs.readFileSync(fixture.captureFile, 'utf8'));
        const argsBytes = JSON.stringify(args);
        const envPairs = args
            .map((arg, idx) => arg === '-e' ? args[idx + 1] : '')
            .filter(Boolean);
        assert.equal(argsBytes.includes(secretToken), false);
        assert.equal(envPairs.some((entry) => entry.startsWith('HF_TOKEN=')), false);
        assert.ok(envPairs.includes('PLOINKY_MODEL_SECRET_FILE=/run/secrets/hf_token'));
        const secretMount = secretFileMount(args);
        assert.ok(secretMount.endsWith(':/run/secrets/hf_token:ro'), 'secret file must be mounted read-only');
        const secretHostPath = mountSource(secretMount);
        assert.equal(pathContains(fixture.workspaceDir, secretHostPath), false, 'secret file must live outside the mounted workspace tree');
        assert.equal(fs.readFileSync(secretHostPath, 'utf8'), secretToken);
        assert.equal(fs.statSync(secretHostPath).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(secretHostPath)).mode & 0o777, 0o700);
        assert.ok(volumeMounts(args).some((mount) => mount.includes(':/runtime')), 'LLM runtime mount must still be present');
        assertOnlySecretMountExposesSecretFile(args, secretHostPath);
        const stateFile = path.join(fixture.workspaceDir, '.data', 'llmAgent', 'runtime', 'selected-architecture.json');
        assert.ok(fs.existsSync(stateFile), 'selected architecture state must be written');
        const stateBytes = fs.readFileSync(stateFile, 'utf8');
        assert.equal(stateBytes.includes('HF_TOKEN'), false);
        assert.equal(stateBytes.includes(secretToken), false);
        const agentsBytes = fs.readFileSync(path.join(fixture.workspaceDir, '.ploinky', 'agents.json'), 'utf8');
        assert.equal(agentsBytes.includes('HF_TOKEN'), false);
        assert.equal(agentsBytes.includes(secretToken), false);
        assert.equal(agentsBytes.includes(secretHostPath), false);
        assert.equal(agentsBytes.includes('/run/secrets/hf_token'), false);
        const agentsState = JSON.parse(agentsBytes);
        const persistedBinds = agentsState['llm-container']?.config?.binds || [];
        assert.equal(
            persistedBinds.some((mount) => mount?.source === secretHostPath || mount?.target === '/run/secrets/hf_token'),
            false,
            'persisted agent state must not record the model secret bind'
        );
    } finally {
        fixture.cleanup();
    }
});

test('startAgentContainer mounts LLM HF_TOKEN profile secret read-only with podman suffix', () => {
    const fixture = createLlmStartFixture();
    try {
        enableFakePodmanRuntime(fixture);
        const secretToken = ['secret', 'token'].join('-');
        const manifest = {
            llmRuntime: { enabled: true },
            container: 'placeholder:unused',
            profiles: {
                default: {
                    secrets: ['HF_TOKEN'],
                },
            },
        };
        fs.writeFileSync(path.join(fixture.agentPath, 'manifest.json'), JSON.stringify(manifest));

        const result = runModuleSnippet(
            `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container', profileName: 'default' });`,
            {
                PATH: fixture.binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                HF_TOKEN: secretToken,
            },
            { cwd: fixture.workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const args = JSON.parse(fs.readFileSync(fixture.captureFile, 'utf8'));
        const envPairs = args
            .map((arg, idx) => arg === '-e' ? args[idx + 1] : '')
            .filter(Boolean);
        const secretMount = secretFileMount(args);
        assert.ok(secretMount.endsWith(':/run/secrets/hf_token:z,ro'), 'secret file must be mounted read-only with podman relabel suffix');
        const secretHostPath = mountSource(secretMount);
        assert.equal(pathContains(fixture.workspaceDir, secretHostPath), false, 'secret file must live outside the mounted workspace tree');
        assertOnlySecretMountExposesSecretFile(args, secretHostPath);
        assert.ok(envPairs.includes('PLOINKY_MODEL_SECRET_FILE=/run/secrets/hf_token'));
        assert.equal(JSON.stringify(args).includes(secretToken), false);
        assert.equal(envPairs.some((entry) => entry.startsWith('HF_TOKEN=')), false);
    } finally {
        fixture.cleanup();
    }
});

test('startAgentContainer rejects retired LLM runtime env names in profile secrets', () => {
    for (const secretName of [
        'PLOINKY_LLM_PUBLIC_PORT',
        'PLOINKY_LLM_MCP_PORT',
        'PLOINKY_LLM_CONTROL_PORT',
        'PLOINKY_LLM_LAUNCHERS_DIR',
    ]) {
        const fixture = createLlmStartFixture();
        try {
            const manifest = {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                profiles: {
                    default: {
                        secrets: [secretName],
                    },
                },
            };
            fs.writeFileSync(path.join(fixture.agentPath, 'manifest.json'), JSON.stringify(manifest));

            const result = runModuleSnippet(
                `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container', profileName: 'default' });`,
                {
                    PATH: fixture.binDir,
                    PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                    PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                    [secretName]: 'bad',
                },
                { cwd: fixture.workspaceDir },
            );

            assert.notEqual(result.status, 0, `${secretName} must be rejected in profile secrets`);
            assert.match(result.stderr, /retired LLM runtime env|PLOINKY_LLM_/);
            assert.equal(fs.existsSync(fixture.captureFile), false, `${secretName} must not start an LLM container`);
        } finally {
            fixture.cleanup();
        }
    }
});

test('startAgentContainer rejects manifest volumes that shadow LLM runtime mounts', () => {
    for (const target of ['/workspace', '/models', '/runtime']) {
        const fixture = createLlmStartFixture();
        try {
            const hostDir = path.join(fixture.workspaceDir, `shadow-${target.slice(1)}`);
            fs.mkdirSync(hostDir, { recursive: true });
            const manifest = {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                volumes: {
                    [hostDir]: target,
                },
            };

            const result = runModuleSnippet(
                `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container' });`,
                {
                    PATH: fixture.binDir,
                    PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                    PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                },
                { cwd: fixture.workspaceDir },
            );

            assert.notEqual(result.status, 0, `${target} shadow volume must be rejected for LLM runtime manifests`);
            assert.match(result.stderr, /reserved LLM runtime mount|volume target/);
            assert.equal(fs.existsSync(fixture.captureFile), false, `${target} shadow volume must not start an LLM container`);
        } finally {
            fixture.cleanup();
        }
    }
});

test('startAgentContainer rejects retired LLM runtime env names in runtime resources env', () => {
    for (const envName of [
        'PLOINKY_LLM_PUBLIC_PORT',
        'PLOINKY_LLM_MCP_PORT',
        'PLOINKY_LLM_CONTROL_PORT',
        'PLOINKY_LLM_LAUNCHERS_DIR',
    ]) {
        const fixture = createLlmStartFixture();
        try {
            const manifest = {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                runtime: {
                    resources: {
                        env: {
                            [envName]: 'bad',
                        },
                    },
                },
            };

            const result = runModuleSnippet(
                `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container' });`,
                {
                    PATH: fixture.binDir,
                    PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                    PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                },
                { cwd: fixture.workspaceDir },
            );

            assert.notEqual(result.status, 0, `${envName} must be rejected in runtime.resources.env`);
            assert.match(result.stderr, /retired LLM runtime env|PLOINKY_LLM_/);
            assert.equal(fs.existsSync(fixture.captureFile), false, `${envName} must not start an LLM container`);
        } finally {
            fixture.cleanup();
        }
    }
});

test('startAgentContainer rejects runtime resource storage that shadows LLM runtime mounts', () => {
    for (const target of ['/workspace', '/models', '/runtime']) {
        const fixture = createLlmStartFixture();
        try {
            const manifest = {
                llmRuntime: { enabled: true },
                container: 'placeholder:unused',
                runtime: {
                    resources: {
                        persistentStorage: {
                            key: `shadow-${target.slice(1)}`,
                            containerPath: target,
                        },
                    },
                },
            };

            const result = runModuleSnippet(
                `const { startAgentContainer } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = ${JSON.stringify(manifest)};
startAgentContainer('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container' });`,
                {
                    PATH: fixture.binDir,
                    PLOINKY_LLM_ARCHITECTURES_PATH: fixture.catalogRoot,
                    PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                },
                { cwd: fixture.workspaceDir },
            );

            assert.notEqual(result.status, 0, `${target} runtime resource mount must be rejected`);
            assert.match(result.stderr, /reserved LLM runtime mount|persistent storage|volume target/);
            assert.equal(fs.existsSync(fixture.captureFile), false, `${target} runtime resource mount must not start an LLM container`);
        } finally {
            fixture.cleanup();
        }
    }
});

test('ensureAgentService removes existing LLM container when startup reuse probe fails', () => {
    const fixture = createLlmStartFixture({ writeCatalog: false, docker: { existingContainer: true } });
    try {
        const result = runModuleSnippet(
            `const { computeEnvHash } = await import(${JSON.stringify(dockerCommonUrl)});
const { buildRuntimeRouterEnv, ensureAgentService } = await import(${JSON.stringify(agentServiceManagerUrl)});
const manifest = { llmRuntime: { enabled: true }, container: 'placeholder:unused' };
const runtimeRouterEnv = buildRuntimeRouterEnv('docker');
process.env.PLOINKY_FAKE_ENVHASH = computeEnvHash(manifest, null, runtimeRouterEnv, { agentName: 'llmAgent', repoName: 'repo' });
ensureAgentService('llmAgent', manifest, ${JSON.stringify(fixture.agentPath)}, { containerName: 'llm-container', preferredHostPort: 19000 });`,
            {
                PATH: fixture.binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: path.join(fixture.workspaceDir, 'missing-catalog'),
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: fixture.workspaceDir },
        );

        assert.notEqual(result.status, 0, 'LLM reuse probe failure must fail closed');
        const dockerState = JSON.parse(fs.readFileSync(fixture.fakeDocker.stateFile, 'utf8'));
        assert.ok(dockerState.rmCount > 0, 'existing LLM container must be removed when startup contract cannot be computed');
        assert.equal(fs.existsSync(fixture.captureFile), false, 'unverified existing LLM container must not be reused or restarted');
    } finally {
        fixture.cleanup();
    }
});

test('ensureAgentService recreates LLM containers whose reuse hash lacks the startup contract', () => {
    const workspaceDir = tempDir();
    const binDir = tempDir('ploinky-fake-docker-');
    const captureFile = path.join(workspaceDir, 'docker-args.json');
    const fakeDocker = writeFakeDocker(binDir, captureFile, { existingContainer: true });
    try {
        const agentPath = path.join(workspaceDir, '.ploinky', 'repos', 'repo', 'llmAgent');
        fs.mkdirSync(agentPath, { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'code'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(workspaceDir, '.ploinky', 'shared'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, '.ploinky', 'agents.json'), JSON.stringify({}));
        fs.symlinkSync(agentPath, path.join(workspaceDir, '.ploinky', 'code', 'llmAgent'), 'dir');
        const catalogRoot = path.join(workspaceDir, 'catalog');
        writeLlmCatalog(catalogRoot);

        const result = runModuleSnippet(
            `import crypto from 'node:crypto';
const { computeEnvHash } = await import(${JSON.stringify(dockerCommonUrl)});
const { buildRuntimeRouterEnv, ensureAgentService } = await import(${JSON.stringify(agentServiceManagerUrl)});
const { prepareLlmStartup } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/services/llmRuntimeIntegration.js')).href)});
const manifest = { llmRuntime: { enabled: true }, container: 'placeholder:unused' };
const agentPath = ${JSON.stringify(agentPath)};
function hashLegacyReuseKey(reuseKey) {
  const { startupContract, startupContractVersion, ...legacyReuseKey } = reuseKey;
  const sorted = Object.keys(legacyReuseKey).sort().reduce((acc, key) => {
    acc[key] = legacyReuseKey[key];
    return acc;
  }, {});
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
const runtimeRouterEnv = buildRuntimeRouterEnv('docker');
const envHash = computeEnvHash(manifest, null, runtimeRouterEnv, { agentName: 'llmAgent', repoName: 'repo' });
const oldProbe = prepareLlmStartup({
  runtime: 'docker',
  manifest,
  profileConfig: null,
  agentName: 'llmAgent',
  env: process.env,
  agentWorkDirRoot: ${JSON.stringify(path.join(workspaceDir, '.ploinky', 'agents'))},
  envHash,
  writeState: false,
});
process.env.PLOINKY_FAKE_ENVHASH = envHash;
process.env.PLOINKY_FAKE_REUSEHASH = hashLegacyReuseKey(oldProbe.reuseKey);
ensureAgentService('llmAgent', manifest, agentPath, { containerName: 'llm-container', preferredHostPort: 19000 });`,
            {
                PATH: binDir,
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        const dockerState = JSON.parse(fs.readFileSync(fakeDocker.stateFile, 'utf8'));
        assert.ok(dockerState.rmCount > 0, 'existing LLM container must be removed when reuse label lacks startup contract fields');
        const args = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
        assert.ok(args.includes('127.0.0.1:19000:9000'));
        assert.ok(args.some((arg) => /^127\.0\.0\.1:\d+:8080$/.test(String(arg))));
    } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

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
    exit 1
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
            `const { enableAgent } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/services/agents.js')).href)});
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

test('parseManifestPorts rejects legacy ports in inactive manifest profiles', () => {
    const workspaceDir = tempDir();
    try {
        const result = runModuleSnippet(
            `const { parseManifestPorts } = await import(${JSON.stringify(dockerCommonUrl)});
try {
  parseManifestPorts({
    profiles: {
      default: { openPorts: ['127.0.0.1:17000:7000'] },
      qa: { ports: ['127.0.0.1:19000:9000'] }
    }
  }, { openPorts: ['127.0.0.1:17000:7000'] });
} catch (err) {
  process.stdout.write(err.message);
}`,
            {},
            { cwd: workspaceDir },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /manifest\.profiles\.qa\.ports has been renamed to 'openPorts'/);
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
