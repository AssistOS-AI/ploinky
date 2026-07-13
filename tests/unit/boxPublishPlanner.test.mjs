import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    collectManifestClaims,
    parseOpenPortPublishSpec,
    planBoxPublishes,
    publishTarget,
    subtractIntervals,
} from '../../container/box-publish-planner.mjs';

// Mirrored from AssistOSExplorer/onlyOffice/manifest.json so this repository's
// unit suite stays standalone. Update both together; the owning repo's manifest
// test proves its live default/dev/prod declarations use these values.
const onlyOfficeOpenPorts = JSON.parse(fs.readFileSync(
    new URL('../fixtures/onlyoffice-openports.json', import.meta.url),
    'utf8',
));

function node(agentRef, openPorts, options = {}) {
    const alias = options.alias || '';
    return {
        id: alias ? `${agentRef} as ${alias}` : agentRef,
        instanceKey: alias ? `${agentRef}#alias:${alias}` : `${agentRef}#canonical`,
        agentRef,
        profile: options.profile || 'default',
        alias,
        networkMode: options.networkMode || 'default',
        selectionPath: options.path || [agentRef],
        openPorts,
    };
}

test('generic authoritative nodes produce TCP, UDP, range, root, dependency, and alias claims', () => {
    const plan = planBoxPublishes({
        nodes: [
            node('repo/root', ['127.0.0.1:9000:7000']),
            node('repo/worker', ['0.0.0.0:3478:3478/udp', '127.0.0.1:10000-10002:20000-20002/udp']),
            node('repo/aliasable', ['127.0.0.1:9100:9100'], { alias: 'blue' }),
        ],
        routerPort: 8080,
    });

    assert.deepEqual(plan.generatedPublishes, [
        '127.0.0.1:9000:9000',
        '0.0.0.0:3478:3478/udp',
        '127.0.0.1:10000-10002:10000-10002/udp',
        '127.0.0.1:9100:9100',
    ]);
    assert.equal(plan.claims[2].privateContainer.start, 20000);
    assert.equal(plan.claims[3].alias, 'blue');
});

test('manifest parser rejects box-side port zero and unequal ranges', () => {
    assert.throws(
        () => planBoxPublishes({ nodes: [node('repo/a', ['127.0.0.1:0:7000'])] }),
        /host port 0 is not valid for outer box publish/,
    );
    assert.throws(
        () => planBoxPublishes({ nodes: [node('repo/a', ['127.0.0.1:9000-9002:7000-7001'])] }),
        /range lengths must match/,
    );
});

test('different effective instances conflict with owner, profile, alias, path, and declarations', () => {
    assert.throws(
        () => collectManifestClaims([
            node('repo/service', ['127.0.0.1:9000:7000'], { alias: 'one', profile: 'dev', path: ['root', 'left'] }),
            node('repo/service', ['0.0.0.0:9000:8000'], { alias: 'two', profile: 'prod', path: ['root', 'right'] }),
        ]),
        (error) => {
            const message = error.message;
            return message.includes('repo/service')
                && message.includes('alias one')
                && message.includes('alias two')
                && message.includes('profile dev')
                && message.includes('profile prod')
                && message.includes('127.0.0.1:9000:7000')
                && message.includes('0.0.0.0:9000:8000');
        },
    );
});

test('same effective instance deduplicates only a semantically exact repeat', () => {
    const exact = node('repo/a', [
        '127.0.0.1:9000:7000',
        '127.0.0.1:9000:7000',
    ]);
    assert.equal(collectManifestClaims([exact]).length, 1);
    assert.throws(
        () => collectManifestClaims([node('repo/a', [
            '127.0.0.1:9000:7000',
            '127.0.0.1:9000:8000',
        ])]),
        /overlapping openPorts/,
    );
});

test('TCP and UDP on the same number are independent', () => {
    const plan = planBoxPublishes({
        nodes: [
            node('repo/tcp', ['127.0.0.1:3478:3478/tcp']),
            node('repo/udp', ['127.0.0.1:3478:3478/udp']),
        ],
    });
    assert.deepEqual(plan.generatedPublishes, [
        '127.0.0.1:3478:3478',
        '127.0.0.1:3478:3478/udp',
    ]);
});

test('explicit target intervals subtract every covered prefix, middle, and suffix deterministically', () => {
    const plan = planBoxPublishes({
        nodes: [node('repo/media', ['127.0.0.1:1000-1010:2000-2010/udp'])],
        explicitPublishes: [
            '127.0.0.1:41000:1000/udp',
            '127.0.0.1:41004-41005:1004-1005/udp',
            '127.0.0.1:41008-41010:1008-1010/udp',
        ],
    });
    assert.deepEqual(plan.explicitPublishes, [
        '127.0.0.1:41000:1000/udp',
        '127.0.0.1:41004-41005:1004-1005/udp',
        '127.0.0.1:41008-41010:1008-1010/udp',
    ]);
    assert.deepEqual(plan.generatedPublishes, [
        '127.0.0.1:1001-1003:1001-1003/udp',
        '127.0.0.1:1006-1007:1006-1007/udp',
    ]);
});

test('explicit full coverage removes a generated claim while another protocol does not', () => {
    const full = planBoxPublishes({
        nodes: [node('repo/media', ['127.0.0.1:1000-1002:2000-2002/udp'])],
        explicitPublishes: ['127.0.0.1:5000-5002:1000-1002/udp'],
    });
    assert.deepEqual(full.generatedPublishes, []);

    const tcpOnly = planBoxPublishes({
        nodes: [node('repo/media', ['127.0.0.1:1000-1002:2000-2002/udp'])],
        explicitPublishes: ['127.0.0.1:5000-5002:1000-1002/tcp'],
    });
    assert.deepEqual(tcpOnly.generatedPublishes, ['127.0.0.1:1000-1002:1000-1002/udp']);
});

test('reserved router TCP socket conflicts while UDP remains valid', () => {
    assert.throws(
        () => planBoxPublishes({ nodes: [node('repo/a', ['127.0.0.1:8079-8081:7000-7002'])], routerPort: 8080 }),
        /reserved outer router socket 8080\/tcp/,
    );
    assert.doesNotThrow(
        () => planBoxPublishes({ nodes: [node('repo/a', ['127.0.0.1:8080:7000/udp'])], routerPort: 8080 }),
    );
});

test('real-shaped OnlyOffice profiles contain stable nonzero claims and produce no internal conflict', () => {
    for (const profile of ['default', 'dev', 'prod']) {
        const plan = planBoxPublishes({
            nodes: [node('AchillesIDE/onlyOffice', onlyOfficeOpenPorts[profile].openPorts, { profile })],
        });
        assert.ok(plan.generatedPublishes.includes('127.0.0.1:17002:17002'));
        assert.equal(plan.claims.some((claim) => claim.boxSide.start === 0), false);
    }
});

test('Explorer-shaped OnlyOffice and LiveKit control sockets remain distinct', () => {
    const plan = planBoxPublishes({
        nodes: [
            node(
                'AchillesIDE/onlyOffice',
                onlyOfficeOpenPorts.default.openPorts,
                { profile: 'default' },
            ),
            node(
                'webmeetInfra/liveKitServerAgent',
                ['127.0.0.1:17000:17000'],
                { profile: 'default' },
            ),
        ],
    });
    assert.ok(plan.generatedPublishes.includes('127.0.0.1:17000:17000'));
    assert.ok(plan.generatedPublishes.includes('127.0.0.1:17002:17002'));
});

test('canonical parser helper retains box target and private target separately', () => {
    const parsed = parseOpenPortPublishSpec('0.0.0.0:9081:8081');
    assert.equal(parsed.target, '9081/tcp');
    assert.equal(parsed.privateContainer.start, 8081);
    assert.equal(publishTarget('127.0.0.1:7882-7892:7882-7892/udp'), '7882-7892/udp');
    assert.deepEqual(
        subtractIntervals({ start: 1, end: 5 }, [{ start: 2, end: 4 }]),
        [{ start: 1, end: 1, length: 1 }, { start: 5, end: 5, length: 1 }],
    );
});

test('host mode publishes physical ports directly to private box-namespace ports', () => {
    const plan = planBoxPublishes({
        nodes: [node('repo/hosted', ['127.0.0.1:19000:7000'], { networkMode: 'host' })],
    });
    assert.deepEqual(plan.generatedPublishes, ['127.0.0.1:19000:7000']);
    assert.equal(plan.claims[0].networkMode, 'host');
    assert.deepEqual(plan.claims[0].physicalHost, { start: 19000, end: 19000, length: 1 });
    assert.deepEqual(plan.claims[0].boxSide, { start: 7000, end: 7000, length: 1 });
    assert.deepEqual(plan.claims[0].privateContainer, { start: 7000, end: 7000, length: 1 });
});

test('planner detects host/bridge box namespace conflicts even when physical ports differ', () => {
    assert.throws(() => planBoxPublishes({
        nodes: [
            node('repo/bridge', ['127.0.0.1:7000:9000'], { networkMode: 'bridge' }),
            node('repo/host', ['127.0.0.1:19000:7000'], { networkMode: 'host' }),
        ],
    }), /box-namespace socket 7000\/tcp/);
});

test('bridge implicit AgentServer mapping is deterministic and explicit private 7000 suppresses it', () => {
    const implicitNode = node('repo/implicit', [], { networkMode: 'bridge' });
    implicitNode.implicitAgentServer = true;
    const first = planBoxPublishes({ nodes: [implicitNode] });
    const second = planBoxPublishes({ nodes: [implicitNode] });
    assert.deepEqual(first.generatedPublishes, second.generatedPublishes);
    assert.equal(first.claims.length, 1);
    assert.equal(first.claims[0].privateContainer.start, 7000);

    const explicitNode = node('repo/explicit', ['127.0.0.1:19000:7000'], { networkMode: 'bridge' });
    explicitNode.implicitAgentServer = true;
    const explicit = planBoxPublishes({ nodes: [explicitNode] });
    assert.equal(explicit.claims.length, 1);
    assert.deepEqual(explicit.generatedPublishes, ['127.0.0.1:19000:19000']);
});
