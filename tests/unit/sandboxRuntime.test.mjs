import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliCommandsUrl = pathToFileURL(path.join(repoRoot, 'cli/commands/cli.js')).href;
const dockerCommonUrl = pathToFileURL(path.join(repoRoot, 'cli/sandbox/docker/common.js')).href;
const sandboxRuntimeUrl = pathToFileURL(path.join(repoRoot, 'cli/utils/runtime/sandboxRuntime.js')).href;
const workspaceUrl = pathToFileURL(path.join(repoRoot, 'cli/utils/workspace.js')).href;

function makeFakeRuntimeBin(root, name = 'podman') {
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const runtimePath = path.join(binDir, name);
    fs.writeFileSync(runtimePath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(runtimePath, 0o755);
    return binDir;
}

function runModuleScript({ cwd, env = {}, script }) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd,
        env: {
            ...process.env,
            ...env,
        },
        encoding: 'utf8',
    });
}

function parseLastJsonLine(stdout) {
    const line = stdout.trim().split('\n').at(-1);
    return JSON.parse(line);
}

test('sandbox disable and enable persist workspace host sandbox setting', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-command-'));

    try {
        const script = `
            const { handleCommand } = await import(${JSON.stringify(cliCommandsUrl)});
            const workspace = await import(${JSON.stringify(workspaceUrl)});
            await handleCommand(['sandbox', 'disable']);
            const disabled = workspace.getConfig().sandbox?.disableHostRuntimes;
            await handleCommand(['enable', 'sandbox']);
            const enabled = workspace.getConfig().sandbox?.disableHostRuntimes;
            console.log(JSON.stringify({ disabled, enabled }));
        `;
        const result = runModuleScript({ cwd: root, script });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            disabled: true,
            enabled: false,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('host sandbox is disabled by default and routes lite-sandbox to containers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-default-'));

    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const script = `
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            console.log(JSON.stringify({
                status: getSandboxStatus(),
                runtime: getRuntimeForAgent({ 'lite-sandbox': true }),
            }));
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
            },
            script,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.status.disabled, true);
        assert.equal(output.status.source, 'default');
        assert.equal(output.runtime, 'podman');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('host sandbox disable forces lite-sandbox manifests to container runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-runtime-'));

    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const script = `
            const { setHostSandboxDisabled } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            setHostSandboxDisabled(true);
            console.log(JSON.stringify({
                lite: getRuntimeForAgent({ 'lite-sandbox': true }),
            }));
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
            },
            script,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            lite: 'podman',
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('legacy manifest runtime string fails instead of silently selecting container runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-legacy-runtime-'));

    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const script = `
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            try {
                getRuntimeForAgent({ runtime: 'bwrap' });
                console.log(JSON.stringify({ ok: true }));
            } catch (error) {
                console.log(JSON.stringify({
                    ok: false,
                    code: error.code,
                    message: error.message,
                }));
            }
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
            },
            script,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.ok, false);
        assert.equal(output.code, 'PLOINKY_LEGACY_RUNTIME_SELECTOR');
        assert.match(output.message, /lite-sandbox: true/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('environment variable disables host sandbox without persisted config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-env-'));

    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const script = `
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            console.log(JSON.stringify({
                status: getSandboxStatus(),
                runtime: getRuntimeForAgent({ 'lite-sandbox': true }),
            }));
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
                PLOINKY_DISABLE_HOST_SANDBOX: '1',
            },
            script,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.status.disabled, true);
        assert.equal(output.status.source, 'environment');
        assert.equal(output.runtime, 'podman');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('lite-sandbox fails with guidance when host sandbox runtime is unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-missing-'));

    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        // Sandbox is disabled by default — opt into the host sandbox before
        // asserting the missing-runtime error path.
        const script = `
            const { setHostSandboxDisabled } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            setHostSandboxDisabled(false);
            try {
                getRuntimeForAgent({ 'lite-sandbox': true });
                console.log(JSON.stringify({ ok: true }));
            } catch (error) {
                console.log(JSON.stringify({
                    ok: false,
                    code: error.code,
                    message: error.message,
                }));
            }
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PATH: binDir,
            },
            script,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.ok, false);
        assert.equal(output.code, 'PLOINKY_HOST_SANDBOX_UNAVAILABLE');
        assert.match(output.message, /lite-sandbox: true requested/);
        assert.match(output.message, /ploinky sandbox disable/);
        assert.match(output.message, /podman\/docker/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sandbox startup failure guidance does not promise implicit container fallback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-start-failed-'));

    try {
        const script = `
            const { createHostSandboxStartupError } = await import(${JSON.stringify(dockerCommonUrl)});
            const error = createHostSandboxStartupError('demoAgent', 'bwrap', new Error('profile denied'));
            console.log(JSON.stringify({
                code: error.code,
                message: error.message,
            }));
        `;
        const result = runModuleScript({ cwd: root, script });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.code, 'PLOINKY_HOST_SANDBOX_START_FAILED');
        assert.match(output.message, /profile denied/);
        assert.match(output.message, /ploinky sandbox disable/);
        assert.doesNotMatch(output.message, /falling back/i);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
