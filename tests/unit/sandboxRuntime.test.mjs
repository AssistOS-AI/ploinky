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
const sandboxCommandsUrl = pathToFileURL(path.join(repoRoot, 'cli/commands/sandboxCommands.js')).href;
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

test('sandbox profile resolution honors explicit profiles and derives immutable host networking', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-profile-'));

    try {
        const script = `
            const { resolveBwrapRuntimeProfile } = await import(${JSON.stringify(bwrapServiceManagerUrl)});
            const { resolveSeatbeltRuntimeProfile } = await import(${JSON.stringify(seatbeltServiceManagerUrl)});
            const manifest = {
                'lite-sandbox': true,
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
                            'lite-sandbox': true,
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
                bwrapNetwork: bwrap.network,
                seatbeltProfile: seatbelt.resolvedProfileName,
                seatbeltTarget: seatbelt.profileConfig.env.TARGET,
                seatbeltNetwork: seatbelt.network,
                missingProfileCode,
                rejectedNetworks,
            }));
        `;
        const result = runModuleScript({ cwd: root, script });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            bwrapProfile: 'prod',
            bwrapTarget: 'prod',
            bwrapNetwork: { mode: 'host', source: 'platform-lite-sandbox' },
            seatbeltProfile: 'prod',
            seatbeltTarget: 'prod',
            seatbeltNetwork: { mode: 'host', source: 'platform-lite-sandbox' },
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
                ['startBwrapProcess', 'spawnTrustedServiceLaunch(trustedLaunch'],
                ['ensureBwrapService', 'startBwrapProcess('],
                ['attachBwrapInteractive', 'spawnTrustedInteractiveLaunch(trustedLaunch'],
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
                'lite-sandbox': true,
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
                    ['attach', () => manager[${JSON.stringify(attachName)}]('agent', manifest, ${JSON.stringify(agentDir)}, ${JSON.stringify(agentDir)}, '/bin/sh', options)],
                ]) {
                    try { await invoke(); failures[name] = 'UNEXPECTED_SUCCESS'; }
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
            try {
                buildFullEnvMap('agent', {}, profile, work, 'repo', 'default', 'bwrap', null, endpoint);
            } catch (error) {
                result.bwrapError = error.code;
            }
            const env = buildFullEnvMap('agent', {}, profile, work, 'repo', 'default', 'seatbelt', null, endpoint);
            result.seatbelt = {
                host: env.PLOINKY_ROUTER_HOST,
                port: env.PLOINKY_ROUTER_PORT,
                url: env.PLOINKY_ROUTER_URL,
                authority: env.PLOINKY_ROUTER_AUTHORITY,
            };
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
            bwrapError: 'PLOINKY_BWRAP_SERVICE_ENV_RESERVED',
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
            await handleCommand(['sandbox', 'enable']);
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

test('sandbox command grammar rejects every legacy alias without mutating workspace policy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-grammar-'));

    try {
        const script = `
            const { handleCommand } = await import(${JSON.stringify(cliCommandsUrl)});
            const workspace = await import(${JSON.stringify(workspaceUrl)});
            const commands = [
                ['sandbox'],
                ['sandbox', 'show'],
                ['sandbox', 'off'],
                ['sandbox', 'container'],
                ['sandbox', 'containers'],
                ['sandbox', 'on'],
                ['sandbox', 'auto'],
                ['sandbox', 'manifest'],
                ['sandbox', 'status', 'extra'],
                ['enable', 'sandbox'],
                ['disable', 'sandbox'],
                ['enable', 'host-sandbox'],
                ['disable', 'lite-sandbox'],
            ];
            const results = [];
            for (const command of commands) {
                try {
                    await handleCommand(command);
                    results.push({ command: command.join(' '), code: 'accepted' });
                } catch (error) {
                    results.push({ command: command.join(' '), code: error.code, message: error.message });
                }
            }
            console.log(JSON.stringify({
                results,
                sandboxConfig: workspace.getConfig().sandbox,
            }));
        `;
        const result = runModuleScript({ cwd: root, script });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.sandboxConfig, undefined);
        assert.equal(output.results.length, 13);
        for (const rejected of output.results) {
            assert.equal(rejected.code, 'PLOINKY_SANDBOX_COMMAND_INVALID', rejected.command);
            assert.match(rejected.message, /Usage: sandbox status \| sandbox disable \| sandbox enable/);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('strict selector is manifest-driven by default while missing selector remains container-backed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-default-'));

    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const script = `
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            console.log(JSON.stringify({
                status: getSandboxStatus(),
                strictRuntime: getRuntimeForAgent(
                    { 'lite-sandbox': true },
                    { platform: 'linux', runtimeInstalled: (name) => name === 'bwrap' },
                ),
                containerRuntime: getRuntimeForAgent({ container: 'test/runtime:approved' }),
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
        assert.equal(output.status.disabled, false);
        assert.equal(output.status.source, 'default');
        assert.equal(output.status.selection, 'manifest');
        assert.equal(output.strictRuntime, 'bwrap');
        assert.equal(output.containerRuntime, 'podman');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('strict selector has an exact platform and dual-mode manifest matrix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-matrix-'));
    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const script = `
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            const installed = () => true;
            const errors = {};
            for (const [name, manifest, options] of [
                ['missingContainer', {}, {}],
                ['falseWithoutContainer', { 'lite-sandbox': false }, {}],
                ['blankContainer', { container: '' }, {}],
                ['paddedContainer', { container: ' image:tag ' }, {}],
                ['nonStringContainer', { container: { image: 'tag' } }, {}],
                ['stringSelector', { 'lite-sandbox': 'true', container: 'coding-image:approved' }, {}],
                ['numericSelector', { 'lite-sandbox': 1, container: 'coding-image:approved' }, {}],
                ['nullSelector', { 'lite-sandbox': null, container: 'coding-image:approved' }, {}],
                ['objectSelector', { 'lite-sandbox': {}, container: 'coding-image:approved' }, {}],
                ['unsupported', { 'lite-sandbox': true }, { platform: 'freebsd', runtimeInstalled: installed }],
            ]) {
                try { getRuntimeForAgent(manifest, options); errors[name] = 'accepted'; }
                catch (error) { errors[name] = error.code; }
            }
            console.log(JSON.stringify({
                linux: getRuntimeForAgent({
                    'lite-sandbox': true,
                    container: { deliberately: 'invalid-but-dormant' },
                }, { platform: 'linux', runtimeInstalled: installed }),
                darwin: getRuntimeForAgent({
                    'lite-sandbox': true,
                    container: '',
                }, { platform: 'darwin', runtimeInstalled: installed }),
                explicitFalse: getRuntimeForAgent({
                    'lite-sandbox': false,
                    container: 'coding-image:approved',
                }),
                missing: getRuntimeForAgent({ container: 'coding-image:approved' }),
                errors,
            }));
        `;
        const result = runModuleScript({ cwd: root, env: { PATH: binDir }, script });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            linux: 'bwrap',
            darwin: 'seatbelt',
            explicitFalse: 'podman',
            missing: 'podman',
            errors: {
                missingContainer: 'PLOINKY_CONTAINER_DECLARATION_REQUIRED',
                falseWithoutContainer: 'PLOINKY_CONTAINER_DECLARATION_REQUIRED',
                blankContainer: 'PLOINKY_CONTAINER_DECLARATION_REQUIRED',
                paddedContainer: 'PLOINKY_CONTAINER_DECLARATION_REQUIRED',
                nonStringContainer: 'PLOINKY_CONTAINER_DECLARATION_REQUIRED',
                stringSelector: 'PLOINKY_LITE_SANDBOX_SELECTOR_INVALID',
                numericSelector: 'PLOINKY_LITE_SANDBOX_SELECTOR_INVALID',
                nullSelector: 'PLOINKY_LITE_SANDBOX_SELECTOR_INVALID',
                objectSelector: 'PLOINKY_LITE_SANDBOX_SELECTOR_INVALID',
                unsupported: 'PLOINKY_HOST_SANDBOX_UNAVAILABLE',
            },
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('true selector treats every container declaration shape as dormant and performs no engine probe', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-dormant-container-'));
    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const engineMarker = path.join(root, 'podman-called');
        fs.writeFileSync(
            path.join(binDir, 'podman'),
            `#!/bin/sh\nprintf called > ${JSON.stringify(engineMarker)}\nexit 0\n`,
        );
        fs.chmodSync(path.join(binDir, 'podman'), 0o755);
        const script = `
            const fs = await import('node:fs');
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            const runtimes = [
                {},
                { container: 'coding-image:approved' },
                { container: '' },
                { container: { invalid: 'dormant metadata must not be inspected' } },
            ].map((metadata) => getRuntimeForAgent({
                'lite-sandbox': true,
                ...metadata,
            }, {
                platform: 'linux',
                runtimeInstalled: (name) => name === 'bwrap',
            }));
            console.log(JSON.stringify({
                runtimes,
                engineCalled: fs.existsSync(${JSON.stringify(engineMarker)}),
            }));
        `;
        const result = runModuleScript({ cwd: root, env: { PATH: binDir }, script });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(parseLastJsonLine(result.stdout), {
            runtimes: ['bwrap', 'bwrap', 'bwrap', 'bwrap'],
            engineCalled: false,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('false or missing selector requires Podman and never falls back to Docker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-selector-podman-only-'));
    try {
        const binDir = makeFakeRuntimeBin(root, 'docker');
        const script = `
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            try {
                getRuntimeForAgent({ container: 'coding-image:approved' });
                console.log(JSON.stringify({ code: 'accepted' }));
            } catch (error) {
                console.log(JSON.stringify({ code: error.code, message: error.message }));
            }
        `;
        const result = runModuleScript({ cwd: root, env: { PATH: binDir }, script });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.code, 'PLOINKY_CONTAINER_RUNTIME_UNAVAILABLE');
        assert.match(output.message, /Podman/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('status applies the selector by capability, independent of agent identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-selector-identity-independent-'));
    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const reposRoot = path.join(root, 'repos');
        for (const [repoName, agentName, manifest] of [
            ['arbitrary-a', 'First', { container: 'shared/runtime:approved' }],
            ['arbitrary-b', 'Second', { 'lite-sandbox': false, container: 'shared/runtime:approved' }],
            ['arbitrary-c', 'MissingDeclaration', {}],
            ['arbitrary-d', 'MalformedSelector', { 'lite-sandbox': 'true', container: 'shared/runtime:approved' }],
        ]) {
            const agentDir = path.join(reposRoot, repoName, agentName);
            fs.mkdirSync(agentDir, { recursive: true });
            fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest));
        }
        const script = `
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const status = getSandboxStatus({
                reposRoot: ${JSON.stringify(reposRoot)},
                agents: {
                    alpha: { type: 'agent', repoName: 'arbitrary-a', agentName: 'First' },
                    beta: { type: 'agent', repoName: 'arbitrary-b', agentName: 'Second' },
                    invalid: { type: 'agent', repoName: 'arbitrary-c', agentName: 'MissingDeclaration' },
                    malformed: { type: 'agent', repoName: 'arbitrary-d', agentName: 'MalformedSelector' },
                },
            });
            console.log(JSON.stringify(status.agents));
        `;
        const result = runModuleScript({ cwd: root, env: { PATH: binDir }, script });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const agents = parseLastJsonLine(result.stdout);
        assert.deepEqual(agents.map(({ runtimeKey, selectedRuntime, available, errorCode }) => ({
            runtimeKey,
            selectedRuntime,
            available,
            errorCode,
        })), [
            { runtimeKey: 'alpha', selectedRuntime: 'podman', available: true, errorCode: '' },
            { runtimeKey: 'beta', selectedRuntime: 'podman', available: true, errorCode: '' },
            { runtimeKey: 'invalid', selectedRuntime: 'invalid', available: false, errorCode: 'PLOINKY_CONTAINER_DECLARATION_REQUIRED' },
            { runtimeKey: 'malformed', selectedRuntime: 'invalid', available: false, errorCode: 'PLOINKY_LITE_SANDBOX_SELECTOR_INVALID' },
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('explicit host sandbox disable conflicts with strict selector and never falls back', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-runtime-'));

    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const script = `
            const { setHostSandboxDisabled } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            setHostSandboxDisabled(true);
            try { getRuntimeForAgent({ 'lite-sandbox': true }); }
            catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
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
        assert.equal(output.code, 'PLOINKY_SANDBOX_POLICY_CONFLICT');
        assert.match(output.message, /fallback is forbidden/);
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

test('environment disable conflicts with strict selector without persisted config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-env-'));

    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const script = `
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            console.log(JSON.stringify({
                status: getSandboxStatus(),
                code: (() => {
                    try { getRuntimeForAgent({ 'lite-sandbox': true }); return 'accepted'; }
                    catch (error) { return error.code; }
                })(),
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
        assert.equal(output.code, 'PLOINKY_SANDBOX_POLICY_CONFLICT');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('lite-sandbox fails with guidance when host sandbox runtime is unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-missing-'));

    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        const script = `
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            try {
                getRuntimeForAgent(
                    { 'lite-sandbox': true },
                    { platform: 'linux', runtimeInstalled: () => false },
                );
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
        assert.match(output.message, /Remove that selector/);
        assert.match(output.message, /Podman/);
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
        assert.match(output.message, /Remove that selector/);
        assert.doesNotMatch(output.message, /falling back/i);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ploinky box marker reports hybrid capability and strictly selects bwrap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-box-'));
    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        makeFakeRuntimeBin(root, 'bwrap');
        const marker = path.join(root, 'ploinky-box');
        const helper = path.join(root, 'ploinky-bwrap-launch');
        const codingAgent = path.join(root, '.ploinky', 'repos', 'coding', 'OpenCode');
        const containerAgent = path.join(root, '.ploinky', 'repos', 'apps', 'Explorer');
        fs.mkdirSync(codingAgent, { recursive: true });
        fs.mkdirSync(containerAgent, { recursive: true });
        fs.writeFileSync(path.join(codingAgent, 'manifest.json'), JSON.stringify({ 'lite-sandbox': true }));
        fs.writeFileSync(path.join(containerAgent, 'manifest.json'), JSON.stringify({ container: 'explorer:test' }));
        fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({
            'coding-opencode': { type: 'agent', repoName: 'coding', agentName: 'OpenCode', alias: 'reviewer' },
            'apps-explorer': { type: 'agent', repoName: 'apps', agentName: 'Explorer' },
        }));
        fs.writeFileSync(marker, BOX_MARKER_CONTENT);
        fs.writeFileSync(helper, `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' 'ploinky-bwrap-launch-v1 source-sha=0123456789012345678901234567890123456789' ;;
  --capabilities) printf '%s\\n' 'ploinky-bwrap-launch-v1 protocol=1 descriptor-fd=3 path-resolution=openat2-beneath-no-magiclinks-no-symlinks bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms typed-fs=dir,tmpfs,proc,dev,system-symlink,ro-data-path-file ro-data-path-hardening=sealed-memfd-ro-bind-data' ;;
  *) exit 64 ;;
esac
`);
        fs.chmodSync(helper, 0o755);
        const script = `
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const { printSandboxStatus } = await import(${JSON.stringify(sandboxCommandsUrl)});
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            const boxOptions = {
                boxMarkerPath: ${JSON.stringify(marker)},
                bwrapHelperPath: ${JSON.stringify(helper)},
            };
            let legacyCode = '';
            try { getRuntimeForAgent({ runtime: 'bwrap' }, boxOptions); }
            catch (error) { legacyCode = error.code; }
            const status = getSandboxStatus(boxOptions);
            const lines = [];
            const originalLog = console.log;
            console.log = (...values) => lines.push(values.join(' '));
            printSandboxStatus(status);
            console.log = originalLog;
            console.log(JSON.stringify({
                status,
                lines,
                lite: getRuntimeForAgent({ 'lite-sandbox': true }, boxOptions),
                container: getRuntimeForAgent({ container: 'explorer:test' }, boxOptions),
                legacyCode,
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
        assert.equal(output.status.insideBox, true);
        assert.equal(output.status.hybrid, true);
        assert.equal(output.status.bwrap.available, true);
        assert.equal(output.status.podman.available, true);
        assert.equal(output.status.helper.required, true);
        assert.equal(output.status.helper.available, true);
        assert.match(output.status.helper.version, /^ploinky-bwrap-launch-v1 source-sha=/);
        assert.deepEqual(output.status.agents.map((agent) => ({
            runtimeKey: agent.runtimeKey,
            selectedRuntime: agent.selectedRuntime,
            available: agent.available,
        })), [
            { runtimeKey: 'apps-explorer', selectedRuntime: 'podman', available: true },
            { runtimeKey: 'coding-opencode', selectedRuntime: 'bwrap', available: true },
        ]);
        assert.equal(output.lines.some((line) => /Bwrap fd launcher: ploinky-bwrap-launch-v1/.test(line)), true);
        assert.equal(output.lines.some((line) => /coding-opencode.*: bwrap - available/.test(line)), true);
        assert.equal(output.lines.some((line) => /apps-explorer.*: podman - available/.test(line)), true);
        assert.equal(output.lite, 'bwrap');
        assert.equal(output.container, 'podman');
        assert.equal(output.legacyCode, 'PLOINKY_LEGACY_RUNTIME_SELECTOR');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Box status exposes an invalid helper capability without selecting Podman for a strict agent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-box-status-helper-'));
    try {
        const binDir = makeFakeRuntimeBin(root, 'podman');
        makeFakeRuntimeBin(root, 'bwrap');
        const marker = path.join(root, 'ploinky-box');
        const helper = path.join(root, 'ploinky-bwrap-launch');
        const agentDir = path.join(root, '.ploinky', 'repos', 'coding', 'Codex');
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({ 'lite-sandbox': true }));
        fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({
            'coding-codex': { type: 'agent', repoName: 'coding', agentName: 'Codex' },
        }));
        fs.writeFileSync(marker, BOX_MARKER_CONTENT);
        fs.writeFileSync(helper, '#!/bin/sh\nprintf "%s\\n" "ploinky-bwrap-launch-v1 protocol=1 descriptor-fd=3"\n');
        fs.chmodSync(helper, 0o755);
        const script = `
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            console.log(JSON.stringify(getSandboxStatus({
                boxMarkerPath: ${JSON.stringify(marker)},
                bwrapHelperPath: ${JSON.stringify(helper)},
            })));
        `;
        const result = runModuleScript({
            cwd: root,
            env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
            script,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = parseLastJsonLine(result.stdout);
        assert.equal(output.helper.available, false);
        assert.equal(output.helper.missingCapabilities.length, 4);
        assert.equal(output.podman.available, true);
        assert.deepEqual(output.agents[0], {
            runtimeKey: 'coding-codex',
            agent: 'coding/Codex',
            instance: 'Codex',
            recordedRuntime: '',
            selectedRuntime: 'bwrap',
            available: false,
            errorCode: 'PLOINKY_HOST_SANDBOX_UNAVAILABLE',
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Box selection rejects invalid identity and missing fd-pinned helper without Podman fallback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-box-fail-closed-'));
    try {
        const marker = path.join(root, 'ploinky-box');
        const scriptFor = (helperResult) => `
            const { getRuntimeForAgent } = await import(${JSON.stringify(dockerCommonUrl)});
            try {
                getRuntimeForAgent({ 'lite-sandbox': true }, {
                    boxMarkerPath: ${JSON.stringify(marker)},
                    runtimeInstalled: () => true,
                    spawnSyncImpl: () => (${helperResult}),
                });
                console.log(JSON.stringify({ code: 'accepted' }));
            } catch (error) {
                console.log(JSON.stringify({ code: error.code, message: error.message }));
            }
        `;

        fs.writeFileSync(marker, 'not-a-box\n');
        const invalid = runModuleScript({ cwd: root, script: scriptFor("{ status: 0, stdout: '' }") });
        assert.equal(invalid.status, 0, invalid.stderr || invalid.stdout);
        assert.equal(parseLastJsonLine(invalid.stdout).code, 'PLOINKY_BOX_MARKER_INVALID');

        fs.writeFileSync(marker, BOX_MARKER_CONTENT);
        const helperMissing = runModuleScript({ cwd: root, script: scriptFor("{ status: 1, stdout: '', stderr: 'missing' }") });
        assert.equal(helperMissing.status, 0, helperMissing.stderr || helperMissing.stdout);
        const failure = parseLastJsonLine(helperMissing.stdout);
        assert.equal(failure.code, 'PLOINKY_HOST_SANDBOX_UNAVAILABLE');
        assert.match(failure.message, /fd-pinned Bubblewrap launcher/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ploinky box never falls back to Docker when nested Podman is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sandbox-box-docker-'));
    try {
        const binDir = makeFakeRuntimeBin(root, 'docker');
        const marker = path.join(root, 'ploinky-box');
        const reposRoot = path.join(root, '.ploinky', 'repos');
        const agentDir = path.join(reposRoot, 'apps', 'Explorer');
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({ container: 'explorer:test' }));
        fs.writeFileSync(marker, BOX_MARKER_CONTENT);
        const script = `
            const { getRuntime } = await import(${JSON.stringify(dockerCommonUrl)});
            const { getSandboxStatus } = await import(${JSON.stringify(sandboxRuntimeUrl)});
            const status = getSandboxStatus({
                boxMarkerPath: ${JSON.stringify(marker)},
                reposRoot: ${JSON.stringify(reposRoot)},
                agents: {
                    explorer: { type: 'agent', repoName: 'apps', agentName: 'Explorer' },
                },
            });
            try { getRuntime(${JSON.stringify(marker)}); console.log(JSON.stringify({ ok: true, status })); }
            catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, status })); }
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
        assert.equal(output.status.agents[0].selectedRuntime, 'podman');
        assert.equal(output.status.agents[0].available, false);
        assert.equal(output.status.agents[0].errorCode, 'PLOINKY_BOX_PODMAN_REQUIRED');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
