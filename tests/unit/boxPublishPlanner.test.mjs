import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const plannerUrl = new URL('../../container/box-publish-planner.mjs', import.meta.url);
const {
    planBoxPublishesForStart,
    parseOpenPortPublishSpec,
    publishTarget,
} = await import(`${plannerUrl.href}?test=${Date.now()}`);

function makeWorkspace() {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-plan-'));
    fs.mkdirSync(path.join(workspaceRoot, 'ploinky'), { recursive: true });
    return {
        workspaceRoot,
        sourceDir: path.join(workspaceRoot, 'ploinky'),
        writeManifest(repoDir, agentName, manifest) {
            const agentDir = path.join(workspaceRoot, repoDir, agentName);
            fs.mkdirSync(agentDir, { recursive: true });
            fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        },
        cleanup() {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        },
    };
}

function writeExplorerFixture(workspace) {
    workspace.writeManifest('AssistOSExplorer', 'explorer', {
        enable: [
            'basic/webtty global',
            'webmeetInfra/liveKitServerAgent no-wait',
            'onlyOffice global no-wait',
        ],
        profiles: {
            default: {
                enable: [
                    {
                        agent: 'basic/web-publishing global',
                        profile: 'default',
                    },
                ],
            },
        },
    });
    workspace.writeManifest('basic', 'web-publishing', {
        profiles: {
            default: {
                openPorts: ['127.0.0.1:8081:8081'],
            },
        },
    });
    workspace.writeManifest('basic', 'webtty', {
        profiles: {
            default: {
                env: {
                    PORT: { default: '7681' },
                },
            },
        },
    });
    workspace.writeManifest('AssistOSExplorer', 'onlyOffice', {
        profiles: {
            default: {
                env: [
                    { name: 'ONLYOFFICE_JWT_SECRET', required: true },
                ],
            },
        },
    });
    workspace.writeManifest('webmeetInfra', 'liveKitServerAgent', {
        profiles: {
            default: {
                openPorts: [
                    '127.0.0.1:7881:7881',
                    '127.0.0.1:3478:3478/tcp',
                    '127.0.0.1:3478:3478/udp',
                    '127.0.0.1:7882-7892:7882-7892/udp',
                    '127.0.0.1:20000-20010:20000-20010/udp',
                ],
            },
        },
    });
}

function writeClaimGraph(workspace, enables, manifests) {
    workspace.writeManifest('AssistOSExplorer', 'explorer', {
        enable: enables,
        profiles: { default: {} },
    });
    for (const [agentName, manifest] of Object.entries(manifests)) {
        workspace.writeManifest('basic', agentName, manifest);
    }
}

function manifestWithPorts(openPorts) {
    return {
        profiles: {
            default: { openPorts },
        },
    };
}

test('planner derives Explorer outer publishes from enabled agents active openPorts', () => {
    const workspace = makeWorkspace();
    try {
        writeExplorerFixture(workspace);

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer' },
            sourceDir: workspace.sourceDir,
        });

        assert.deepEqual(plan.publishes, [
            '127.0.0.1:7881:7881',
            '127.0.0.1:3478:3478',
            '127.0.0.1:3478:3478/udp',
            '127.0.0.1:7882-7892:7882-7892/udp',
            '127.0.0.1:20000-20010:20000-20010/udp',
            '127.0.0.1:8081:8081',
        ]);
        assert.deepEqual(plan.graph.map((node) => node.ref), [
            'AchillesIDE/explorer',
            'basic/webtty',
            'webmeetInfra/liveKitServerAgent',
            'AchillesIDE/onlyOffice',
            'basic/web-publishing',
        ]);
    } finally {
        workspace.cleanup();
    }
});

test('planner treats string suffixes as mode tokens and object profile as profile selection', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: [
                'basic/web-publishing global no-wait',
                {
                    agent: 'webmeetInfra/liveKitServerAgent no-wait',
                    profile: 'lan',
                },
            ],
        });
        workspace.writeManifest('basic', 'web-publishing', {
            profiles: {
                default: {
                    openPorts: ['127.0.0.1:8081:8081'],
                },
            },
        });
        workspace.writeManifest('webmeetInfra', 'liveKitServerAgent', {
            profiles: {
                default: {
                    openPorts: ['127.0.0.1:7881:7881'],
                },
                lan: {
                    openPorts: ['0.0.0.0:7881:7881'],
                },
            },
        });

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer' },
            sourceDir: workspace.sourceDir,
        });

        assert.deepEqual(plan.publishes, [
            '127.0.0.1:8081:8081',
            '0.0.0.0:7881:7881',
        ]);
        assert.equal(plan.graph.find((node) => node.ref === 'basic/web-publishing')?.profile, 'default');
        assert.equal(plan.graph.find((node) => node.ref === 'webmeetInfra/liveKitServerAgent')?.profile, 'lan');
    } finally {
        workspace.cleanup();
    }
});

test('planner fails when a required enabled manifest is missing', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: ['basic/web-publishing global'],
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer' },
                sourceDir: workspace.sourceDir,
            }),
            /missing manifest for enabled agent basic\/web-publishing/,
        );
    } finally {
        workspace.cleanup();
    }
});

test('planner does not resolve bare enables from sibling repos', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: ['sharedTool global'],
        });
        workspace.writeManifest('basic', 'sharedTool', {
            profiles: {
                default: {
                    openPorts: ['127.0.0.1:9000:9000'],
                },
            },
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer' },
                sourceDir: workspace.sourceDir,
            }),
            /missing manifest for enabled agent sharedTool/,
        );
    } finally {
        workspace.cleanup();
    }
});

test('planner fails when an enabled directive names a missing profile', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: [
                {
                    agent: 'basic/web-publishing global',
                    profile: 'lan',
                },
            ],
        });
        workspace.writeManifest('basic', 'web-publishing', {
            profiles: {
                default: {
                    openPorts: ['127.0.0.1:8081:8081'],
                },
            },
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer' },
                sourceDir: workspace.sourceDir,
            }),
            /profile lan is not defined by basic\/web-publishing/,
        );
    } finally {
        workspace.cleanup();
    }
});

test('planner rejects host port 0 because outer box publishes must be stable', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: ['basic/web-publishing global'],
        });
        workspace.writeManifest('basic', 'web-publishing', {
            profiles: {
                default: {
                    openPorts: ['127.0.0.1:0:8081'],
                },
            },
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer' },
                sourceDir: workspace.sourceDir,
            }),
            /host port 0 is not valid for outer box publish/,
        );
    } finally {
        workspace.cleanup();
    }
});

test('parseOpenPortPublishSpec normalizes protocols and target keys', () => {
    const udp = parseOpenPortPublishSpec('127.0.0.1:3478:3478/udp');
    assert.deepEqual(udp, {
        raw: '127.0.0.1:3478:3478/udp',
        spec: '127.0.0.1:3478:3478/udp',
        hostIp: '127.0.0.1',
        bindClass: 'specific',
        hostPortSpec: '3478',
        containerPortSpec: '3478',
        protocol: 'udp',
        target: '3478/udp',
        boxSide: { start: 3478, end: 3478, length: 1 },
        privateContainer: { start: 3478, end: 3478, length: 1 },
    });
    assert.deepEqual(parseOpenPortPublishSpec('0.0.0.0:9081:8081'), {
        raw: '0.0.0.0:9081:8081',
        spec: '0.0.0.0:9081:9081',
        hostIp: '0.0.0.0',
        bindClass: 'wildcard',
        hostPortSpec: '9081',
        containerPortSpec: '8081',
        protocol: 'tcp',
        target: '9081/tcp',
        boxSide: { start: 9081, end: 9081, length: 1 },
        privateContainer: { start: 8081, end: 8081, length: 1 },
    });
    assert.equal(publishTarget('0.0.0.0:7882-7892:7882-7892/udp'), '7882-7892/udp');
    assert.equal(publishTarget('127.0.0.1:8081:8081'), '8081/tcp');
});

test('planner fails closed when different private targets claim the same box-side socket', () => {
    const workspace = makeWorkspace();
    try {
        writeClaimGraph(workspace, ['basic/alpha global', 'basic/beta global'], {
            alpha: manifestWithPorts(['127.0.0.1:9081:8081']),
            beta: manifestWithPorts(['127.0.0.1:9081:9090']),
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer' },
                sourceDir: workspace.sourceDir,
            }),
            (error) => {
                const message = String(error?.message || error);
                return message.includes('basic/alpha')
                    && message.includes('profile default')
                    && message.includes('127.0.0.1:9081:8081')
                    && message.includes('basic/beta')
                    && message.includes('127.0.0.1:9081:9090');
            },
        );
    } finally {
        workspace.cleanup();
    }
});

test('planner rejects overlapping UDP box-side ranges', () => {
    const workspace = makeWorkspace();
    try {
        writeClaimGraph(workspace, ['basic/alpha global', 'basic/beta global'], {
            alpha: manifestWithPorts(['127.0.0.1:7882-7892:7882-7892/udp']),
            beta: manifestWithPorts(['127.0.0.1:7890-7900:7890-7900/udp']),
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer' },
                sourceDir: workspace.sourceDir,
            }),
            /overlapping openPorts box-side socket.*7882-7892.*7890-7900/i,
        );
    } finally {
        workspace.cleanup();
    }
});

test('planner treats TCP and UDP claims at the same number as independent', () => {
    const workspace = makeWorkspace();
    try {
        writeClaimGraph(workspace, ['basic/alpha global', 'basic/beta global'], {
            alpha: manifestWithPorts(['127.0.0.1:3478:3478/tcp']),
            beta: manifestWithPorts(['127.0.0.1:3478:3478/udp']),
        });

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer' },
            sourceDir: workspace.sourceDir,
        });
        assert.deepEqual(plan.publishes, [
            '127.0.0.1:3478:3478',
            '127.0.0.1:3478:3478/udp',
        ]);
    } finally {
        workspace.cleanup();
    }
});

test('planner accepts adjacent non-overlapping ranges', () => {
    const workspace = makeWorkspace();
    try {
        writeClaimGraph(workspace, ['basic/alpha global', 'basic/beta global'], {
            alpha: manifestWithPorts(['127.0.0.1:7882-7892:7882-7892/udp']),
            beta: manifestWithPorts(['127.0.0.1:7893-7900:7893-7900/udp']),
        });

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer' },
            sourceDir: workspace.sourceDir,
        });
        assert.equal(plan.publishes.length, 2);
    } finally {
        workspace.cleanup();
    }
});

test('planner deduplicates an exact repeated claim only inside one effective node', () => {
    const workspace = makeWorkspace();
    try {
        writeClaimGraph(workspace, ['basic/alpha global'], {
            alpha: manifestWithPorts([
                '127.0.0.1:8081:8081',
                '127.0.0.1:8081:8081',
            ]),
        });

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer' },
            sourceDir: workspace.sourceDir,
        });
        assert.deepEqual(plan.publishes, ['127.0.0.1:8081:8081']);
    } finally {
        workspace.cleanup();
    }
});

test('planner rejects the same claim from two different effective nodes', () => {
    const workspace = makeWorkspace();
    try {
        writeClaimGraph(workspace, ['basic/alpha global', 'basic/beta global'], {
            alpha: manifestWithPorts(['127.0.0.1:8081:8081']),
            beta: manifestWithPorts(['127.0.0.1:8081:8081']),
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer' },
                sourceDir: workspace.sourceDir,
            }),
            /overlapping openPorts box-side socket.*basic\/alpha.*basic\/beta/i,
        );
    } finally {
        workspace.cleanup();
    }
});

test('planner treats aliases of the same ref and profile as different runtime instances', () => {
    const workspace = makeWorkspace();
    try {
        writeClaimGraph(workspace, [
            { agent: 'basic/alpha global', alias: 'one' },
            { agent: 'basic/alpha global', as: 'two' },
        ], {
            alpha: manifestWithPorts(['127.0.0.1:8081:8081']),
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer' },
                sourceDir: workspace.sourceDir,
            }),
            (error) => {
                const message = String(error?.message || error);
                return /overlapping openPorts box-side socket/i.test(message)
                    && message.includes('alias one')
                    && message.includes('alias two');
            },
        );
    } finally {
        workspace.cleanup();
    }
});

test('planner rejects a wildcard bind overlapping a specific bind', () => {
    const workspace = makeWorkspace();
    try {
        writeClaimGraph(workspace, ['basic/alpha global', 'basic/beta global'], {
            alpha: manifestWithPorts(['0.0.0.0:8081:8081']),
            beta: manifestWithPorts(['127.0.0.1:8081:8081']),
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer' },
                sourceDir: workspace.sourceDir,
            }),
            /overlapping openPorts box-side socket.*wildcard.*specific/i,
        );
    } finally {
        workspace.cleanup();
    }
});

test('planner lets selected profile openPorts replace default openPorts', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: [
                {
                    agent: 'basic/web-publishing global',
                    profile: 'lan',
                },
            ],
        });
        workspace.writeManifest('basic', 'web-publishing', {
            profiles: {
                default: {
                    openPorts: ['127.0.0.1:8081:8081'],
                },
                lan: {
                    openPorts: ['0.0.0.0:9081:8081'],
                },
            },
        });

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer' },
            sourceDir: workspace.sourceDir,
        });

        assert.deepEqual(plan.publishes, ['0.0.0.0:9081:9081']);
    } finally {
        workspace.cleanup();
    }
});

test('planner targets the box-side host port when inner openPorts remap a container port', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: [
                'basic/web-publishing global',
                'basic/preview global',
            ],
        });
        workspace.writeManifest('basic', 'web-publishing', {
            profiles: {
                default: {
                    openPorts: ['127.0.0.1:9081:8081'],
                },
            },
        });
        workspace.writeManifest('basic', 'preview', {
            profiles: {
                default: {
                    openPorts: ['127.0.0.1:9082:8081'],
                },
            },
        });

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer' },
            sourceDir: workspace.sourceDir,
        });

        assert.deepEqual(plan.publishes, [
            '127.0.0.1:9081:9081',
            '127.0.0.1:9082:9082',
        ]);
    } finally {
        workspace.cleanup();
    }
});

test('planner rejects malformed openPorts publish specs', () => {
    assert.throws(() => parseOpenPortPublishSpec('bad-spec'), /invalid openPorts publish spec/i);
});

test('planner rejects protocol conflicts inside one publish spec', () => {
    assert.throws(
        () => parseOpenPortPublishSpec('127.0.0.1:3478/tcp:3478/udp'),
        /conflicting protocols/i,
    );
});

test('planner rejects host and container range length mismatches', () => {
    assert.throws(
        () => parseOpenPortPublishSpec('127.0.0.1:7882-7892:7882-7883/udp'),
        /range lengths must match/i,
    );
});

test('planner rejects publish ports outside the TCP and UDP range', () => {
    assert.throws(
        () => parseOpenPortPublishSpec('127.0.0.1:70000:70000'),
        /invalid port range/i,
    );
});

test('planner defaults workspaceRoot to the sibling of sourceDir', () => {
    const workspace = makeWorkspace();
    try {
        writeExplorerFixture(workspace);

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer' },
            sourceDir: workspace.sourceDir,
            workspaceRoot: undefined,
        });

        assert.equal(plan.graph[0].manifestPath, path.join(workspace.workspaceRoot, 'AssistOSExplorer', 'explorer', 'manifest.json'));
    } finally {
        workspace.cleanup();
    }
});

test('workspace dev profile merges default and replaces default openPorts when the manifest defines dev', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: ['basic/web-publishing global'],
            profiles: {
                default: { env: { BASE: 'yes' } },
                dev: { env: { MODE: 'dev' } },
            },
        });
        workspace.writeManifest('basic', 'web-publishing', {
            profiles: {
                default: {
                    env: { BASE: 'yes' },
                    openPorts: ['127.0.0.1:8081:8081'],
                },
                dev: {
                    env: { MODE: 'dev' },
                    openPorts: ['127.0.0.1:9081:8081'],
                },
            },
        });

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer', profile: 'dev' },
            sourceDir: workspace.sourceDir,
        });
        assert.deepEqual(plan.publishes, ['127.0.0.1:9081:9081']);
        assert.equal(plan.graph.find((node) => node.ref === 'basic/web-publishing')?.profile, 'dev');
    } finally {
        workspace.cleanup();
    }
});

test('workspace dev profile falls back to each manifest default when dev is absent', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: ['basic/web-publishing global'],
            profiles: { default: {}, dev: {} },
        });
        workspace.writeManifest('basic', 'web-publishing', {
            profiles: {
                default: { openPorts: ['127.0.0.1:8081:8081'] },
            },
        });

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer', profile: 'dev' },
            sourceDir: workspace.sourceDir,
        });
        assert.deepEqual(plan.publishes, ['127.0.0.1:8081:8081']);
        assert.equal(plan.graph.find((node) => node.ref === 'basic/web-publishing')?.profile, 'default');
    } finally {
        workspace.cleanup();
    }
});

test('explicit edge-local default overrides the workspace dev profile', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: [{ agent: 'basic/web-publishing global', profile: 'default' }],
            profiles: { default: {}, dev: {} },
        });
        workspace.writeManifest('basic', 'web-publishing', {
            profiles: {
                default: { openPorts: ['127.0.0.1:8081:8081'] },
                dev: { openPorts: ['127.0.0.1:9081:8081'] },
            },
        });

        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'explorer', profile: 'dev' },
            sourceDir: workspace.sourceDir,
        });
        assert.deepEqual(plan.publishes, ['127.0.0.1:8081:8081']);
        assert.equal(plan.graph.find((node) => node.ref === 'basic/web-publishing')?.profile, 'default');
    } finally {
        workspace.cleanup();
    }
});

test('explicit edge-local nonexistent profile fails with the ref and available profiles', () => {
    const workspace = makeWorkspace();
    try {
        workspace.writeManifest('AssistOSExplorer', 'explorer', {
            enable: [{ agent: 'basic/web-publishing global', profile: 'missing' }],
            profiles: { default: {}, dev: {} },
        });
        workspace.writeManifest('basic', 'web-publishing', {
            profiles: {
                default: { openPorts: ['127.0.0.1:8081:8081'] },
                prod: { openPorts: ['127.0.0.1:8082:8082'] },
            },
        });

        assert.throws(
            () => planBoxPublishesForStart({
                startPlan: { hasAgent: true, agent: 'explorer', profile: 'dev' },
                sourceDir: workspace.sourceDir,
            }),
            /profile missing is not defined by basic\/web-publishing; available profiles: default, prod/,
        );
    } finally {
        workspace.cleanup();
    }
});

test('accepted Explorer start spellings select the same root and publish graph', () => {
    const workspace = makeWorkspace();
    try {
        writeExplorerFixture(workspace);
        const spellings = ['explorer', 'AchillesIDE/explorer', 'AssistOSExplorer/explorer'];
        const plans = spellings.map((agent) => planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent, profile: 'default' },
            sourceDir: workspace.sourceDir,
        }));
        assert.deepEqual(plans[1], plans[0]);
        assert.deepEqual(plans[2], plans[0]);
        assert.equal(plans[0].graph[0].ref, 'AchillesIDE/explorer');
    } finally {
        workspace.cleanup();
    }
});

test('planner returns no derived publishes for non-Explorer public starts in this task scope', () => {
    const workspace = makeWorkspace();
    try {
        const plan = planBoxPublishesForStart({
            startPlan: { hasAgent: true, agent: 'demo' },
            sourceDir: workspace.sourceDir,
        });

        assert.deepEqual(plan, { publishes: [], graph: [] });
    } finally {
        workspace.cleanup();
    }
});
