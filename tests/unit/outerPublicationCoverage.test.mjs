import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
    MAX_OUTER_PUBLICATION_CONTRACT_BYTES,
    assertOuterPublicationCoverageForClaims,
    assertOuterPublicationCoverageForManifest,
    parseOuterPublicationContract,
} from '../../cli/services/docker/common.js';
import {
    plannerRequestForCommand,
    preflightBoxPublicationForCommand,
} from '../../cli/services/boxPublicationCoverage.js';

function contract(targets) {
    return { schemaVersion: 1, targets, publishes: [] };
}

test('contract parser validates schema and merges complete TCP/UDP intervals independently', () => {
    const parsed = parseOuterPublicationContract(JSON.stringify(contract([
        { start: 1000, end: 1004, protocol: 'tcp' },
        { start: 1005, end: 1010, protocol: 'tcp' },
        { start: 1000, end: 1002, protocol: 'udp' },
    ])));
    assert.deepEqual(parsed.targets, [
        { start: 1000, end: 1010, protocol: 'tcp' },
        { start: 1000, end: 1002, protocol: 'udp' },
    ]);
    assert.throws(
        () => parseOuterPublicationContract(JSON.stringify({ schemaVersion: 2, targets: [] })),
        (error) => error.code === 'PLOINKY_OUTER_PUBLICATION_REQUIRED' && /schemaVersion/.test(error.message),
    );
    assert.throws(
        () => parseOuterPublicationContract(JSON.stringify({ schemaVersion: 1, targets: [], surprise: true })),
        /unsupported outer publication contract field/,
    );
});

test('contract env size and malformed JSON fail closed before planning', async () => {
    let plannerCalls = 0;
    await assert.rejects(
        () => preflightBoxPublicationForCommand('cli', ['demo/agent'], {
            boxRuntime: true,
            contract: '{not-json',
            createPlan: async () => { plannerCalls += 1; return { claims: [] }; },
        }),
        /not valid JSON/,
    );
    assert.equal(plannerCalls, 0);
    assert.throws(
        () => parseOuterPublicationContract('x'.repeat(MAX_OUTER_PUBLICATION_CONTRACT_BYTES + 1)),
        /exceeds/,
    );
});

test('coverage requires the entire interval and keeps TCP/UDP independent', () => {
    const claim = {
        ownerRef: 'repo/media', raw: '127.0.0.1:1000-1010:2000-2010/udp',
        protocol: 'udp', boxSide: { start: 1000, end: 1010 },
    };
    assert.doesNotThrow(() => assertOuterPublicationCoverageForClaims([claim], {
        boxRuntime: true,
        contract: contract([
            { start: 1000, end: 1004, protocol: 'udp' },
            { start: 1005, end: 1010, protocol: 'udp' },
        ]),
    }));
    assert.throws(
        () => assertOuterPublicationCoverageForClaims([claim], {
            boxRuntime: true,
            contract: contract([
                { start: 1000, end: 1004, protocol: 'udp' },
                { start: 1005, end: 1010, protocol: 'tcp' },
            ]),
            commandHint: 'ploinky start repo/media',
        }),
        (error) => error.code === 'PLOINKY_OUTER_PUBLICATION_REQUIRED'
            && error.message.includes('1000-1010/udp')
            && error.message.includes('ploinky start repo/media'),
    );
});

test('per-agent defense rejects port zero and missing outer coverage before a runtime transition', () => {
    assert.throws(
        () => assertOuterPublicationCoverageForManifest({}, {
            openPorts: ['127.0.0.1:0:7000'],
        }, {
            boxRuntime: true,
            contract: contract([]),
        }),
        /host port 0 is not valid for outer box publish/,
    );
    assert.throws(
        () => assertOuterPublicationCoverageForManifest({}, {
            openPorts: ['127.0.0.1:17000:7000'],
        }, {
            boxRuntime: true,
            contract: contract([]),
            commandHint: 'ploinky enable agent AchillesIDE/onlyOffice',
        }),
        /17000\/tcp/,
    );
});

test('command request mapping covers every starting command and rejects start-tail --port', () => {
    assert.equal(plannerRequestForCommand('start', ['repo/root', '8097']).root, 'repo/root');
    assert.equal(plannerRequestForCommand('enable', ['agent', 'repo/a', 'global']).root, 'repo/a');
    assert.equal(plannerRequestForCommand('cli', ['repo/a', '--port', 'payload']).root, 'repo/a');
    assert.equal(plannerRequestForCommand('shell', ['repo/a']).operation, 'shell');
    assert.equal(plannerRequestForCommand('restart', ['repo/a']).includeEnabled, false);
    assert.equal(plannerRequestForCommand('restart', []).includeEnabled, true);
    assert.equal(plannerRequestForCommand('reinstall', ['agent', 'repo/a']).root, 'repo/a');
    assert.throws(
        () => plannerRequestForCommand('start', ['repo/root', '--port=8097']),
        /start-tail --port/,
    );
});

test('in-box command preflight proceeds when the authoritative contract covers all claims', async () => {
    const result = await preflightBoxPublicationForCommand('cli', ['repo/a', '--port=payload'], {
        boxRuntime: true,
        contract: contract([{ start: 17000, end: 17000, protocol: 'tcp' }]),
        createPlan: async (request) => ({
            schemaVersion: 1,
            operation: request.operation,
            claims: [{ protocol: 'tcp', boxSide: { start: 17000, end: 17000 } }],
        }),
    });
    assert.equal(result.enforced, true);
    assert.equal(result.coverage.covered, true);
});

test('in-box authoritative preflight uses saved alias and canonical profiles instead of workspace profile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-saved-profile-coverage-'));
    try {
        const reposDir = path.join(root, '.ploinky', 'repos', 'demo');
        const sharedDir = path.join(reposDir, 'shared');
        const soloDir = path.join(reposDir, 'solo');
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.mkdirSync(soloDir, { recursive: true });
        fs.writeFileSync(path.join(sharedDir, 'manifest.json'), JSON.stringify({
            profiles: {
                default: { openPorts: ['127.0.0.1:18300:7000'] },
                dev: { openPorts: ['127.0.0.1:18301:7000'] },
            },
        }));
        fs.writeFileSync(path.join(soloDir, 'manifest.json'), JSON.stringify({
            profiles: {
                default: { openPorts: ['127.0.0.1:18400:7000'] },
                prod: { openPorts: ['127.0.0.1:18402:7000'] },
            },
        }));
        fs.writeFileSync(path.join(root, '.ploinky', 'profile'), 'default\n');
        fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({
            alias_container: {
                type: 'agent', repoName: 'demo', agentName: 'shared', alias: 'blue', profile: 'dev',
            },
            canonical_container: {
                type: 'agent', repoName: 'demo', agentName: 'solo', profile: 'prod',
            },
        }));

        const coverageUrl = pathToFileURL(path.join(
            path.resolve(new URL('../..', import.meta.url).pathname),
            'cli/services/boxPublicationCoverage.js',
        )).href;
        const script = `
const { preflightBoxPublicationForCommand } = await import(${JSON.stringify(coverageUrl)});
const alias = await preflightBoxPublicationForCommand('cli', ['blue'], {
  boxRuntime: true,
  contract: { schemaVersion: 1, targets: [{ start: 18301, end: 18301, protocol: 'tcp' }], publishes: [] },
  planOptions: { bootRepos: [] },
});
const canonical = await preflightBoxPublicationForCommand('reinstall', ['solo'], {
  boxRuntime: true,
  contract: { schemaVersion: 1, targets: [{ start: 18402, end: 18402, protocol: 'tcp' }], publishes: [] },
  planOptions: { bootRepos: [] },
});
process.stdout.write(JSON.stringify({
  alias: { profile: alias.plan.profile, node: alias.plan.nodes[0], covered: alias.coverage.covered },
  canonical: { profile: canonical.plan.profile, node: canonical.plan.nodes[0], covered: canonical.coverage.covered },
}));`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_MASTER_KEY: '5'.repeat(64),
            },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = JSON.parse(result.stdout);
        assert.deepEqual({
            profile: output.alias.profile,
            nodeProfile: output.alias.node.profile,
            alias: output.alias.node.alias,
            containerName: output.alias.node.containerName,
            openPorts: output.alias.node.openPorts,
            covered: output.alias.covered,
        }, {
            profile: 'dev',
            nodeProfile: 'dev',
            alias: 'blue',
            containerName: 'alias_container',
            openPorts: ['127.0.0.1:18301:7000'],
            covered: true,
        });
        assert.deepEqual({
            profile: output.canonical.profile,
            nodeProfile: output.canonical.node.profile,
            alias: output.canonical.node.alias,
            containerName: output.canonical.node.containerName,
            openPorts: output.canonical.node.openPorts,
            covered: output.canonical.covered,
        }, {
            profile: 'prod',
            nodeProfile: 'prod',
            alias: '',
            containerName: 'canonical_container',
            openPorts: ['127.0.0.1:18402:7000'],
            covered: true,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('core start denial precedes profile, registry, hook, router, and container mutation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-command-coverage-'));
    try {
        const reposDir = path.join(root, '.ploinky', 'repos');
        for (const repo of ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents', 'demo']) {
            fs.mkdirSync(path.join(reposDir, repo), { recursive: true });
        }
        const agentDir = path.join(reposDir, 'demo', 'root');
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({
            profiles: {
                default: { openPorts: ['127.0.0.1:17000:7000'] },
                dev: { openPorts: ['127.0.0.1:17000:7000'] },
            },
        }));
        const marker = path.join(root, 'ploinky-box');
        fs.writeFileSync(marker, '1\n');
        const cliUrl = pathToFileURL(path.resolve(new URL('../..', import.meta.url).pathname, 'cli/commands/cli.js')).href;
        const script = `
import fs from 'node:fs';
import path from 'node:path';
const { handleCommand } = await import(${JSON.stringify(cliUrl)});
let error = null;
try { await handleCommand(['start', 'demo/root', '--profile', 'dev']); }
catch (caught) { error = { code: caught.code, message: caught.message }; }
const ploinky = path.join(process.cwd(), '.ploinky');
process.stdout.write(JSON.stringify({
  error,
  profileExists: fs.existsSync(path.join(ploinky, 'profile')),
  agentsExists: fs.existsSync(path.join(ploinky, 'agents.json')),
  routingExists: fs.existsSync(path.join(ploinky, 'routing.json')),
  dataExists: fs.existsSync(path.join(process.cwd(), '.data')),
}));`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_BOX_MARKER_PATH: marker,
                PLOINKY_OUTER_PUBLICATION_CONTRACT: JSON.stringify(contract([])),
                PLOINKY_MASTER_KEY: '5'.repeat(64),
            },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = JSON.parse(result.stdout);
        assert.equal(output.error.code, 'PLOINKY_OUTER_PUBLICATION_REQUIRED');
        assert.match(output.error.message, /ploinky start demo\/root --profile dev/);
        assert.deepEqual({
            profileExists: output.profileExists,
            agentsExists: output.agentsExists,
            routingExists: output.routingExists,
            dataExists: output.dataExists,
        }, {
            profileExists: false,
            agentsExists: false,
            routingExists: false,
            dataExists: false,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
