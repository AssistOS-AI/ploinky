import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

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

test('every host-sandbox launch boundary revalidates exact generation authority before physical launch', () => {
    const checks = [
        {
            relativePath: 'cli/sandbox/bwrap/bwrapServiceManager.js',
            functions: [
                ['startBwrapProcess', 'spawn(BWRAP_PATH'],
                ['ensureBwrapService', 'startBwrapProcess('],
                ['attachBwrapInteractive', 'spawnBwrapInteractive('],
            ],
        },
        {
            relativePath: 'cli/sandbox/seatbelt/seatbeltServiceManager.js',
            functions: [
                ['startSeatbeltProcess', "spawn('sandbox-exec'"],
                ['ensureSeatbeltService', 'startSeatbeltProcess('],
                ['attachSeatbeltInteractive', "spawnSync('sandbox-exec'"],
            ],
        },
    ];
    for (const { relativePath, functions } of checks) {
        const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
        for (const [functionName, launchCall] of functions) {
            const start = source.indexOf(`function ${functionName}(`);
            assert.notEqual(start, -1, `${relativePath} must define ${functionName}`);
            const next = source.indexOf('\nfunction ', start + 1);
            const body = source.slice(start, next === -1 ? source.length : next);
            const admission = body.indexOf('admit');
            const authority = body.indexOf('assertHostModeGenerationCapability(');
            const launch = body.indexOf(launchCall);
            assert.ok(admission >= 0 && admission < launch, `${functionName} must admit exact manifest bytes before launch`);
            assert.ok(authority >= 0 && authority < launch, `${functionName} must authorize the exact host-mode generation before launch`);
        }
    }
});

test('sandbox log producers commit ownership before unref and grant no pathname log writes', () => {
    for (const [relativePath, startName] of [
        ['cli/sandbox/bwrap/bwrapServiceManager.js', 'startBwrapProcess'],
        ['cli/sandbox/seatbelt/seatbeltServiceManager.js', 'startSeatbeltProcess'],
    ]) {
        const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
        const start = source.indexOf(`function ${startName}(`);
        const next = source.indexOf('\nfunction ', start + 1);
        const body = source.slice(start, next === -1 ? source.length : next);
        const spawnIndex = relativePath.includes('bwrap')
            ? body.indexOf('child = spawn(BWRAP_PATH')
            : body.indexOf("child = spawn('sandbox-exec'");
        const guardIndex = body.indexOf('guardSpawnedChild(child');
        assert.ok(spawnIndex >= 0 && spawnIndex < guardIndex, `${relativePath} must guard its spawned child`);
        assert.ok(guardIndex < body.indexOf('logHandle.finalize(child.pid'), `${relativePath} must guard before pid use`);
        assert.ok(body.indexOf('saveBwrapPid(') < body.indexOf('child.unref()'), relativePath);
        assert.doesNotMatch(body, /readFileSync\(logFile/);
        if (relativePath.includes('seatbelt')) {
            assert.doesNotMatch(source, /extraWritePaths:\s*\[\s*LOGS_DIR/);
            const immediate = body.slice(body.indexOf('if (!processAlive)'), body.indexOf('saveBwrapPid('));
            assert.doesNotMatch(immediate, /clearBwrapPid/);
        }
    }
});

test('host-sandbox service and interactive boundaries deny an inactive generation before hooks or spawn', () => {
    for (const runtime of ['bwrap', 'seatbelt']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `ploinky-${runtime}-authority-`));
        try {
            const repoDir = path.join(root, '.ploinky', 'repos', 'repo');
            const agentDir = path.join(repoDir, 'agent');
            const hookMarker = path.join(root, `${runtime}-hook-ran`);
            fs.mkdirSync(agentDir, { recursive: true });
            fs.writeFileSync(path.join(agentDir, 'preinstall.sh'), `#!/bin/sh\nprintf ran > ${JSON.stringify(hookMarker)}\n`);
            fs.chmodSync(path.join(agentDir, 'preinstall.sh'), 0o755);
            const manifest = {
                network: { mode: 'host' },
                start: 'sleep 3600',
                profiles: { default: { preinstall: 'preinstall.sh' } },
                readiness: { protocol: 'none' },
            };
            fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest));
            fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({
                'test-sandbox': {
                    type: 'agent',
                    runtime,
                    repoName: 'repo',
                    agentName: 'agent',
                    projectPath: root,
                    runMode: 'global',
                    profile: 'default',
                    instanceId: 'instance-current',
                    enableGeneration: 'enable-current',
                },
            }));
            const managerUrl = runtime === 'bwrap' ? bwrapServiceManagerUrl : seatbeltServiceManagerUrl;
            const startName = runtime === 'bwrap' ? 'startBwrapProcess' : 'startSeatbeltProcess';
            const attachName = runtime === 'bwrap' ? 'attachBwrapInteractive' : 'attachSeatbeltInteractive';
            const script = `
                const fs = await import('node:fs');
                const manager = await import(${JSON.stringify(managerUrl)});
                const { buildRouterEndpoint } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'cli/sandbox/routerPort.js')).href)});
                const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(agentDir, 'manifest.json'))}, 'utf8'));
                const options = {
                    containerName: 'test-sandbox',
                    profileName: 'default',
                    routerEndpoint: buildRouterEndpoint('host', 8080),
                    instanceId: 'instance-current',
                    enableGeneration: 'enable-current',
                };
                const failures = {};
                for (const [name, invoke] of [
                    ['start', () => manager[${JSON.stringify(startName)}]('agent', manifest, ${JSON.stringify(agentDir)}, options)],
                    ['attach', () => manager[${JSON.stringify(attachName)}]('agent', manifest, ${JSON.stringify(agentDir)}, ${JSON.stringify(root)}, '/bin/sh', options)],
                ]) {
                    try { invoke(); failures[name] = 'UNEXPECTED_SUCCESS'; }
                    catch (error) { failures[name] = error.code || error.message; }
                }
                console.log(JSON.stringify(failures));
            `;
            const result = runModuleScript({
                cwd: root,
                env: {
                    PLOINKY_WORKSPACE_ROOT: root,
                    PLOINKY_MASTER_KEY: 'ac'.repeat(32),
                },
                script,
            });
            assert.equal(result.status, 0, result.stderr || result.stdout);
            const failures = parseLastJsonLine(result.stdout);
            assert.match(failures.start, /EDGE_GENERATION_INACTIVE|HOST_MODE_CAPABILITY_DENIED/);
            assert.match(failures.attach, /EDGE_GENERATION_INACTIVE|HOST_MODE_CAPABILITY_DENIED/);
            assert.equal(fs.existsSync(hookMarker), false, `${runtime} denial must precede the manifest hook`);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('bwrap and seatbelt validate the host endpoint but emit no uncertified Router env', () => {
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
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            bwrap: {},
            seatbelt: {},
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
                    privateSecretMatches: false,
                },
                seatbelt: {
                    instanceId: 'instance-exact-1',
                    enableGeneration: 'enable-exact-1',
                    privateSecretMatches: false,
                },
            },
            incompleteError: 'sandbox runtime identity requires exact instanceId and enableGeneration',
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('uncertified sandbox env construction never reads identity key material', () => {
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
        assert.equal(evidence.failure, null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('profile environment and secrets cannot re-enable sandbox Router discovery', () => {
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
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            bwrap: {},
            seatbelt: {},
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
        fs.writeFileSync(marker, BOX_MARKER_CONTENT);
        const script = `
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            const boxOptions = { boxMarkerPath: ${JSON.stringify(marker)} };
            console.log(JSON.stringify({
                status: getSandboxStatus(boxOptions.boxMarkerPath),
                lite: getRuntimeForAgent({ 'lite-sandbox': true }, boxOptions),
                legacy: getRuntimeForAgent({ runtime: 'bwrap' }, boxOptions),
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
        fs.writeFileSync(marker, BOX_MARKER_CONTENT);
        const script = `
            const { getRuntime } = await import(${JSON.stringify(dockerCommonUrl)});
            try { getRuntime(${JSON.stringify(marker)}); console.log(JSON.stringify({ ok: true })); }
            catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, message: error.message })); }
        `;
        const result = runModuleScript({
            cwd: root,
            env: { PATH: binDir },
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

test('Ploinky box probe fails closed without podman and caches only a positive result per marker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-box-cache-'));
    try {
        const emptyBin = path.join(root, 'empty');
        fs.mkdirSync(emptyBin);
        const podmanBin = makeFakeRuntimeBin(root, 'podman');
        const markerA = path.join(root, 'box-a');
        const markerB = path.join(root, 'box-b');
        fs.writeFileSync(markerA, BOX_MARKER_CONTENT);
        fs.writeFileSync(markerB, BOX_MARKER_CONTENT);
        const script = `
            const { probeContainerRuntime } = await import(${JSON.stringify(dockerCommonUrl)});
            const out = {};
            process.env.PATH = ${JSON.stringify(emptyBin)};
            out.missing = probeContainerRuntime(${JSON.stringify(markerA)});
            process.env.PATH = ${JSON.stringify(podmanBin)};
            out.found = probeContainerRuntime(${JSON.stringify(markerA)});
            process.env.PATH = ${JSON.stringify(emptyBin)};
            out.cachedSameMarker = probeContainerRuntime(${JSON.stringify(markerA)});
            out.otherMarkerStillFailsClosed = probeContainerRuntime(${JSON.stringify(markerB)});
            console.log(JSON.stringify(out));
        `;
        const result = runModuleScript({ cwd: root, env: { PATH: emptyBin }, script });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            missing: null,
            found: 'podman',
            cachedSameMarker: 'podman',
            otherMarkerStillFailsClosed: null,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ploinky box probe ignores a directory named podman on PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-box-dir-'));
    try {
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(path.join(binDir, 'podman'), { recursive: true });
        const marker = path.join(root, 'ploinky-box');
        fs.writeFileSync(marker, BOX_MARKER_CONTENT);
        const script = `
            const { probeContainerRuntime } = await import(${JSON.stringify(dockerCommonUrl)});
            console.log(JSON.stringify({ runtime: probeContainerRuntime(${JSON.stringify(marker)}) }));
        `;
        const result = runModuleScript({ cwd: root, env: { PATH: binDir }, script });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(parseLastJsonLine(result.stdout), { runtime: null });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------
// The dispatcher in front of both native managers (Seatbelt, with a fake
// sandbox-exec on macOS): it observes the runtime key before it rotates any
// identity, and it replaces only the predecessor the caller names.

const DISPATCH_SKIP = process.platform !== 'darwin' && 'seatbelt runs on macOS only';
const DISPATCH_MANIFEST = { 'lite-sandbox': true, start: 'node index.js', network: { mode: 'host' }, readiness: { protocol: 'none' } };

// The harness is imported lazily: loading the production config module sets
// PLOINKY_WORKSPACE_ROOT for this process, which the earlier tests of this file
// must not inherit.
async function dispatchFixture(t) {
    const {
        CONTAINER: WIRING_CONTAINER,
        driveWiring,
        registration,
        stepValue,
        wiringWorkspace,
    } = await import('./dependencyStoreWiringHarness.mjs');
    const w = wiringWorkspace(t, { manifest: DISPATCH_MANIFEST, prefix: 'sandbox-dispatch-' });
    const pids = new Set();
    t.after(() => {
        for (const pid of pids) {
            try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
            try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        }
    });
    const first = stepValue(driveWiring(w, [
        { action: 'init-edge' },
        { action: 'enable-sandbox' },
        { action: 'register', containerName: WIRING_CONTAINER, record: { ...registration(), runtime: 'seatbelt', projectPath: path.join(w.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'first', action: 'ensure-with-lease', hostRouter: true, containerName: WIRING_CONTAINER, startPath: true, activate: true, routeKey: 'demo' },
    ]), 'first');
    pids.add(first.pid);
    const pidFile = path.join(w.ws, '.ploinky', 'bwrap-pids', `${WIRING_CONTAINER}.pid`);
    const registryRecord = () => JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'))[WIRING_CONTAINER];
    const alive = (pid) => {
        try { process.kill(pid, 0); } catch { return false; }
        const state = String(spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout || '').trim();
        return Boolean(state) && !state.startsWith('Z');
    };
    return { w, pids, first, pidFile, registryRecord, alive, driveWiring, stepValue, CONTAINER: WIRING_CONTAINER };
}

const RESTART = (container, options) => [{
    label: 'restart',
    action: 'ensure-with-lease',
    hostRouter: true,
    containerName: container,
    activate: true,
    allowFailure: true,
    options,
}];

test('the dispatcher refuses an unverifiable PID slot before rotating the registry or signalling anything', { skip: DISPATCH_SKIP }, async (t) => {
    const f = await dispatchFixture(t);
    const registryBefore = f.registryRecord();
    fs.writeFileSync(f.pidFile, '{"pid": 1}\n');

    const result = f.driveWiring(f.w, RESTART(f.CONTAINER, {
        forceRecreate: true,
        expectedPredecessor: { instanceId: registryBefore.instanceId, enableGeneration: registryBefore.enableGeneration },
    }));
    assert.equal(result.restart.ok, false);
    assert.equal(result.restart.causeCode, 'PLOINKY_SANDBOX_PID_RECORD_INVALID');
    assert.equal(f.alive(f.first.pid), true, 'no signal reached the process');
    assert.equal(fs.readFileSync(f.pidFile, 'utf8'), '{"pid": 1}\n', 'the unverifiable record is preserved');
    assert.deepEqual(f.registryRecord(), registryBefore, 'no identity was rotated');
});

for (const handed of ['null', 'nothing']) {
    test(`a restart whose expected predecessor is ${handed} refuses the live registered runtime before rotating the registry`, { skip: DISPATCH_SKIP }, async (t) => {
        const f = await dispatchFixture(t);
        const registryBefore = f.registryRecord();

        const refused = f.driveWiring(f.w, RESTART(f.CONTAINER, handed === 'null'
            ? { forceRecreate: true, expectedPredecessor: null }
            : { forceRecreate: true }));
        assert.equal(refused.restart.ok, false);
        assert.equal(refused.restart.causeCode, 'PLOINKY_SANDBOX_PID_SLOT_BUSY');
        assert.equal(f.alive(f.first.pid), true, 'the occupant was not stopped');
        assert.deepEqual(f.registryRecord(), registryBefore, 'the registry was not rotated');
    });
}

test('a restart that is handed the registered tuple replaces exactly that runtime and rotates the identity', { skip: DISPATCH_SKIP }, async (t) => {
    const f = await dispatchFixture(t);
    const before = f.registryRecord();
    const restarted = f.stepValue(f.driveWiring(f.w, [{
        ...RESTART(f.CONTAINER, {
            forceRecreate: true,
            expectedPredecessor: { instanceId: before.instanceId, enableGeneration: before.enableGeneration },
        })[0],
        allowFailure: false,
    }]), 'restart');
    f.pids.add(restarted.pid);
    assert.notEqual(restarted.pid, f.first.pid);
    assert.equal(f.alive(f.first.pid), false, 'the registered predecessor exited');
    assert.equal(f.alive(restarted.pid), true);
    assert.notEqual(restarted.instanceId, before.instanceId, 'the successor tuple is fresh');
    assert.equal(JSON.parse(fs.readFileSync(f.pidFile, 'utf8')).instanceId, restarted.instanceId);
});

test('a failure after a healthy runtime was reused never stops that runtime', { skip: DISPATCH_SKIP }, async (t) => {
    const f = await dispatchFixture(t);
    const pidBytes = fs.readFileSync(f.pidFile, 'utf8');
    const registryBefore = f.registryRecord();
    // Nothing needs replacing, so the dispatcher reuses the runtime; the host
    // capability check then fails because the generation was revoked.
    const result = f.driveWiring(f.w, [
        { action: 'inactivate-edge' },
        { label: 'reuse', action: 'ensure-with-lease', hostRouter: true, containerName: f.CONTAINER, allowFailure: true },
    ]);
    assert.equal(result.reuse.ok, false, JSON.stringify(result.reuse));
    assert.equal(f.alive(f.first.pid), true, 'the reused runtime was not launched by this call, so a later failure never stops it');
    assert.equal(fs.readFileSync(f.pidFile, 'utf8'), pidBytes, 'its PID record is untouched');
    assert.doesNotMatch(result.reuse.message, /receipt transition/, 'no misleading cleanup-receipt error for a call that launched nothing');
    assert.deepEqual(f.registryRecord(), registryBefore);
});
