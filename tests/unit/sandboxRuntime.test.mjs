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
const bwrapServiceManagerUrl = pathToFileURL(path.join(repoRoot, 'cli/sandbox/bwrap/bwrapServiceManager.js')).href;
const seatbeltServiceManagerUrl = pathToFileURL(path.join(repoRoot, 'cli/sandbox/seatbelt/seatbeltServiceManager.js')).href;

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

test('sandbox profile resolution honors explicit profiles and requires host networking', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-profile-'));

    try {
        const script = `
            const { resolveBwrapRuntimeProfile } = await import(${JSON.stringify(bwrapServiceManagerUrl)});
            const { resolveSeatbeltRuntimeProfile } = await import(${JSON.stringify(seatbeltServiceManagerUrl)});
            const manifest = {
                network: { mode: 'host' },
                profiles: {
                    default: { env: { TARGET: 'default' } },
                    prod: { env: { TARGET: 'prod' } },
                },
            };
            const bwrap = resolveBwrapRuntimeProfile('agent', manifest, '/tmp/repo/agent', {
                profileName: 'prod',
            }, { profile: 'default' });
            const seatbelt = resolveSeatbeltRuntimeProfile('agent', manifest, '/tmp/repo/agent', {
                profileName: 'prod',
            }, {
                profile: 'default',
            });
            let missingProfileCode = '';
            try {
                resolveBwrapRuntimeProfile('agent', manifest, '/tmp/repo/agent', {
                    profileName: 'missing',
                });
            } catch (error) {
                missingProfileCode = error.code;
            }
            const unsupportedNetworks = [
                { mode: 'none' },
                { mode: 'default' },
                { mode: 'bridge', attachments: [{ name: 'private', primary: true }] },
                { mode: 'default', name: 'legacy' },
            ];
            const rejectedNetworks = {};
            for (const [runtime, resolver] of [
                ['bwrap', resolveBwrapRuntimeProfile],
                ['seatbelt', resolveSeatbeltRuntimeProfile],
            ]) {
                rejectedNetworks[runtime] = unsupportedNetworks.map((network) => {
                    try {
                        resolver('agent', {
                            start: 'sleep infinity',
                            network,
                        }, '/tmp/repo/agent');
                        return 'accepted';
                    } catch (error) {
                        return error.code;
                    }
                });
            }
            console.log(JSON.stringify({
                bwrapProfile: bwrap.resolvedProfileName,
                bwrapTarget: bwrap.profileConfig.env.TARGET,
                seatbeltProfile: seatbelt.resolvedProfileName,
                seatbeltTarget: seatbelt.profileConfig.env.TARGET,
                missingProfileCode,
                rejectedNetworks,
            }));
        `;
        const result = runModuleScript({ cwd: root, script });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            bwrapProfile: 'prod',
            bwrapTarget: 'prod',
            seatbeltProfile: 'prod',
            seatbeltTarget: 'prod',
            missingProfileCode: 'PLOINKY_PROFILE_NOT_FOUND',
            rejectedNetworks: {
                bwrap: Array(4).fill('PLOINKY_NETWORK_CONTRACT_INVALID'),
                seatbelt: Array(4).fill('PLOINKY_NETWORK_CONTRACT_INVALID'),
            },
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('bwrap and seatbelt env builders consume one validated host endpoint without rereading or defaulting', () => {
    for (const relativePath of [
        'cli/sandbox/bwrap/bwrapServiceManager.js',
        'cli/sandbox/seatbelt/seatbeltServiceManager.js',
    ]) {
        const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
        assert.doesNotMatch(source, /\bresolveRouterEndpoint\s*\(/, `${relativePath} must not reread routing.json`);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-router-'));
    try {
        fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080 }));
        const script = `
            const { buildFullEnvMap } = await import(${JSON.stringify(bwrapServiceManagerUrl)});
            const { resolveRouterEndpoint } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/sandbox/routerPort.js')).href)});
            const endpoint = resolveRouterEndpoint('host');
            const work = ${JSON.stringify(path.join(root, 'work'))};
            const bwrap = buildFullEnvMap('agent', {}, {}, work, 'repo', 'default', 'bwrap', null, endpoint);
            const seatbelt = buildFullEnvMap('agent', {}, {}, work, 'repo', 'default', 'seatbelt', null, endpoint);
            let missingCode = '';
            try { buildFullEnvMap('agent', {}, {}, work, 'repo', 'default', 'bwrap'); }
            catch (error) { missingCode = error.code; }
            console.log(JSON.stringify({
                bwrap: {
                    host: bwrap.PLOINKY_ROUTER_HOST,
                    port: bwrap.PLOINKY_ROUTER_PORT,
                    url: bwrap.PLOINKY_ROUTER_URL,
                    authority: bwrap.PLOINKY_ROUTER_AUTHORITY,
                },
                seatbelt: {
                    host: seatbelt.PLOINKY_ROUTER_HOST,
                    port: seatbelt.PLOINKY_ROUTER_PORT,
                    url: seatbelt.PLOINKY_ROUTER_URL,
                    authority: seatbelt.PLOINKY_ROUTER_AUTHORITY,
                },
                missingCode,
            }));
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_MASTER_KEY: 'ab'.repeat(32),
                PLOINKY_ROUTER_HOST_PORT: '19090',
            },
            script,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const expected = {
            host: '127.0.0.1',
            port: '8080',
            url: 'http://127.0.0.1:8080',
            authority: '127.0.0.1:19090',
        };
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            bwrap: expected,
            seatbelt: expected,
            missingCode: 'PLOINKY_ROUTER_ENDPOINT_REQUIRED',
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('managed sandbox env identity is bound to one exact instance and enable generation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-identity-'));
    try {
        const script = `
            const { buildFullEnvMap } = await import(${JSON.stringify(bwrapServiceManagerUrl)});
            const { buildRouterEndpoint } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/sandbox/routerPort.js')).href)});
            const { derivePrivateAgentRequestSecret } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/utils/security/masterKey.js')).href)});
            const endpoint = buildRouterEndpoint('host', 8080);
            const runtimeIdentity = {
                instanceId: 'instance-exact-1',
                enableGeneration: 'enable-exact-1',
            };
            const principal = 'agent:repo/agent';
            const work = ${JSON.stringify(path.join(root, 'work'))};
            const result = {};
            for (const runtime of ['bwrap', 'seatbelt']) {
                const env = buildFullEnvMap(
                    'agent', {}, {}, work, 'repo', 'default', runtime, null,
                    endpoint, runtimeIdentity,
                );
                result[runtime] = {
                    instanceId: env.PLOINKY_AGENT_INSTANCE_ID,
                    enableGeneration: env.PLOINKY_AGENT_ENABLE_GENERATION,
                    privateSecretMatches: env.PLOINKY_AGENT_PRIVATE_SECRET
                        === derivePrivateAgentRequestSecret(
                            principal,
                            runtimeIdentity.instanceId,
                            runtimeIdentity.enableGeneration,
                        ),
                };
            }
            let incompleteError = '';
            try {
                buildFullEnvMap(
                    'agent', {}, {}, work, 'repo', 'default', 'bwrap', null,
                    endpoint, { instanceId: runtimeIdentity.instanceId },
                );
            } catch (error) {
                incompleteError = error.message;
            }
            console.log(JSON.stringify({ result, incompleteError }));
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_MASTER_KEY: 'cd'.repeat(32),
            },
            script,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            result: {
                bwrap: {
                    instanceId: 'instance-exact-1',
                    enableGeneration: 'enable-exact-1',
                    privateSecretMatches: true,
                },
                seatbelt: {
                    instanceId: 'instance-exact-1',
                    enableGeneration: 'enable-exact-1',
                    privateSecretMatches: true,
                },
            },
            incompleteError: 'sandbox runtime identity requires exact instanceId and enableGeneration',
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sandbox env construction fails closed when identity key material cannot be loaded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-identity-failure-'));
    try {
        fs.writeFileSync(path.join(root, '.ploinky'), 'not-a-directory');
        const script = `
            const { buildFullEnvMap } = await import(${JSON.stringify(bwrapServiceManagerUrl)});
            const { buildRouterEndpoint } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/sandbox/routerPort.js')).href)});
            const endpoint = buildRouterEndpoint('host', 8080);
            let failure = null;
            try {
                buildFullEnvMap(
                    'agent', {}, {}, ${JSON.stringify(path.join(root, 'work'))},
                    'repo', 'default', 'bwrap', null, endpoint,
                    { instanceId: 'instance-fail', enableGeneration: 'generation-fail' },
                );
            } catch (error) {
                failure = { code: error.code || '', message: error.message };
            }
            console.log(JSON.stringify({ failure }));
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_MASTER_KEY: 'ef'.repeat(32),
            },
            script,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const evidence = parseLastJsonLine(result.stdout);
        assert.ok(evidence.failure, 'identity key-store failure must escape env construction');
        assert.match(evidence.failure.message, /not a directory|ENOTDIR|EEXIST/i);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('profile environment and secrets cannot override sandbox router discovery', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-router-env-'));
    try {
        const script = `
            const { buildFullEnvMap } = await import(${JSON.stringify(bwrapServiceManagerUrl)});
            const { buildRouterEndpoint } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/sandbox/routerPort.js')).href)});
            const endpoint = buildRouterEndpoint('host', 8080);
            const profile = {
                env: {
                    PLOINKY_ROUTER_HOST: 'profile.invalid',
                    PLOINKY_ROUTER_PORT: '1',
                    PLOINKY_ROUTER_URL: 'http://profile.invalid:1',
                    PLOINKY_ROUTER_AUTHORITY: 'profile.invalid:1',
                },
                secrets: [
                    'PLOINKY_ROUTER_HOST',
                    'PLOINKY_ROUTER_PORT',
                    'PLOINKY_ROUTER_URL',
                    'PLOINKY_ROUTER_AUTHORITY',
                ],
            };
            const work = ${JSON.stringify(path.join(root, 'work'))};
            const result = {};
            for (const runtime of ['bwrap', 'seatbelt']) {
                const env = buildFullEnvMap('agent', {}, profile, work, 'repo', 'default', runtime, null, endpoint);
                result[runtime] = {
                    host: env.PLOINKY_ROUTER_HOST,
                    port: env.PLOINKY_ROUTER_PORT,
                    url: env.PLOINKY_ROUTER_URL,
                    authority: env.PLOINKY_ROUTER_AUTHORITY,
                };
            }
            console.log(JSON.stringify(result));
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_MASTER_KEY: 'ab'.repeat(32),
                PLOINKY_ROUTER_HOST: 'secret.invalid',
                PLOINKY_ROUTER_PORT: '2',
                PLOINKY_ROUTER_URL: 'http://secret.invalid:2',
                PLOINKY_ROUTER_AUTHORITY: 'secret.invalid:2',
                PLOINKY_ROUTER_HOST_PORT: '19090',
            },
            script,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const expected = {
            host: '127.0.0.1',
            port: '8080',
            url: 'http://127.0.0.1:8080',
            authority: '127.0.0.1:19090',
        };
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            bwrap: expected,
            seatbelt: expected,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

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

test('Ploinky box marker forces every manifest through nested Podman', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-box-'));
    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const marker = path.join(root, 'ploinky-box');
        fs.writeFileSync(marker, '1\n');
        const script = `
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            console.log(JSON.stringify({
                status: getSandboxStatus(),
                lite: getRuntimeForAgent({ 'lite-sandbox': true }),
                legacy: getRuntimeForAgent({ runtime: 'bwrap' }),
            }));
        `;
        const result = runModuleScript({
            cwd: root,
            env: {
                PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
                PLOINKY_BOX_MARKER_PATH: marker,
            },
            script,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.status.forced, true);
        assert.equal(output.status.source, 'ploinky-box');
        assert.equal(output.status.effectiveRuntime, 'podman');
        assert.equal(output.lite, 'podman');
        assert.equal(output.legacy, 'podman');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ploinky box never falls back to Docker when nested Podman is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-box-docker-'));
    try {
        const binDir = makeFakeRuntimeBin(root, 'docker');
        const marker = path.join(root, 'ploinky-box');
        fs.writeFileSync(marker, '1\n');
        const script = `
            const { getRuntime } = await import(${JSON.stringify(dockerCommonUrl)});
            try { getRuntime(); console.log(JSON.stringify({ ok: true })); }
            catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, message: error.message })); }
        `;
        const result = runModuleScript({
            cwd: root,
            env: { PATH: binDir, PLOINKY_BOX_MARKER_PATH: marker },
            script,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.ok, false);
        assert.equal(output.code, 'PLOINKY_BOX_PODMAN_REQUIRED');
        assert.match(output.message, /Docker fallback is not permitted/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
