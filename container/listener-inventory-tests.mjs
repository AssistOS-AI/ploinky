import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    assertManagedNetworkInventoryCurrent,
    assertBoxListenerCollectorContract,
    collectBoxListenerInventory,
    collectManagedNetworkInventory,
} from './listener-collector.mjs';
import {
    buildContainerRecord,
    classifyBindAddress,
    compileListenerProfile,
    formatListenerInventory,
    loadListenerProfile,
    parsePidNamespaceInventory,
    parsePodmanPsJson,
    parseSocketAddress,
    parseSsOutput,
    validateListenerInventory,
} from './listener-inventory.mjs';
import {
    buildManagedNetworkRecord,
    managedNetworkWorkspaceHash,
    parseManagedNetworkInspection,
    parseManagedNetworkList,
} from './listener-network-inventory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FULL_PROFILE = path.join(HERE, 'profiles', 'full-explorer-listeners.json');
const ROUTING_PROFILE = path.join(HERE, 'profiles', 'routing-graph-listeners.json');
const NETWORK_WORKSPACE_HASH = managedNetworkWorkspaceHash('/workspace');

function managedNetworkFixture({
    logicalName = 'fixture',
    gateway = '10.89.0.1',
    id = 'network-id',
    labels = {},
} = {}) {
    const logicalHash = crypto.createHash('sha256').update(logicalName).digest('hex').slice(0, 12);
    const name = `ploinky-nw-${NETWORK_WORKSPACE_HASH}-${logicalHash}`;
    return {
        name,
        id,
        driver: 'bridge',
        internal: false,
        ipv6_enabled: false,
        dns_enabled: true,
        options: { isolate: 'true' },
        ipam_options: { driver: 'host-local' },
        subnets: [{ subnet: '10.89.0.0/24', gateway }],
        labels: {
            'io.assistos.ploinky.managed': '1',
            'io.assistos.ploinky.resource': 'network',
            'io.assistos.ploinky.network-schema': '2',
            'io.assistos.ploinky.workspace': NETWORK_WORKSPACE_HASH,
            'io.assistos.ploinky.logical': logicalName,
            ...labels,
        },
    };
}

function container({ name, networkMode = 'bridge', pids, managed = true }) {
    const initPid = pids[0];
    return buildContainerRecord({
        listed: { name, id: `${name}-id`, image: `${name}:test` },
        inspection: [{
            Id: `${name}-id`,
            Name: `/${name}`,
            Config: {
                Image: `${name}:test`,
                Labels: managed ? { 'io.assistos.ploinky.managed': '1' } : {},
            },
            HostConfig: { NetworkMode: networkMode, PidMode: '' },
            State: { Running: true, Pid: initPid, StartedAt: `started-${name}` },
        }],
        pidInventory: {
            initPid,
            pidNamespace: `pid:[${100000 + initPid}]`,
            pids,
        },
    });
}

function fixtureProfile() {
    return compileListenerProfile({
        kind: 'ploinky-listener-profile',
        id: 'fixture',
        requireManagedContainers: true,
        rejectAdditionalContainers: true,
        requireProcessOwners: true,
        controlPorts: [7000, 7882, 8080, 9000],
        requiredContainers: [
            {
                id: 'livekit-container',
                namePattern: '^livekit-current$',
                networkModePattern: '^host$',
                effectiveInstance: 'agent:livekit',
            },
            {
                id: 'app-container',
                namePattern: '^app-current$',
                networkModePattern: '^bridge$',
                effectiveInstance: 'agent:app',
            },
        ],
        forbiddenSockets: [
            {
                id: 'no-media-range',
                protocols: ['udp'],
                portRanges: [{ start: 9001, end: 9010 }],
            },
        ],
        rules: [
            {
                id: 'router',
                namespacePattern: '^outer$',
                protocols: ['tcp'],
                ports: [8080],
                bindAddresses: ['0.0.0.0'],
                exactOwners: ['node'],
                effectiveInstance: 'ploinky-core',
                reviewedSensitive: true,
                minMatches: 1,
                maxMatches: 1,
                rationale: 'fixture Router',
            },
            {
                id: 'media',
                namespacePattern: '^outer$',
                protocols: ['udp'],
                ports: [7882],
                bindAddresses: ['0.0.0.0'],
                exactOwners: ['livekit-server'],
                ownerContainerPattern: '^livekit-current$',
                effectiveInstance: 'agent:livekit',
                reviewedSensitive: true,
                exclusiveSocket: true,
                minMatches: 1,
                maxMatches: 1,
                rationale: 'fixture media mux',
            },
            {
                id: 'app',
                namespacePattern: '^nested:app-current$',
                containerPattern: '^app-current$',
                protocols: ['tcp'],
                ports: [7000],
                bindClasses: ['wildcard'],
                exactOwners: ['node'],
                reviewedSensitive: true,
                minMatches: 1,
                maxMatches: 1,
                rationale: 'fixture app target',
            },
            {
                id: 'private-support',
                namespacePattern: '^nested:',
                protocols: ['tcp', 'udp'],
                bindClasses: ['loopback'],
                reviewedSensitive: false,
                minMatches: 0,
                rationale: 'fixture private support',
            },
        ],
    });
}

function validFixtureInventory() {
    const containers = [
        container({ name: 'livekit-current', networkMode: 'host', pids: [200, 201] }),
        container({ name: 'app-current', pids: [300] }),
    ];
    const listeners = [
        ...parseSsOutput(
            'tcp LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=100,fd=20))\n'
            + 'udp UNCONN 0 0 0.0.0.0:7882 0.0.0.0:* users:(("livekit-server",pid=201,fd=7))\n',
            { namespace: 'outer' },
        ),
        ...parseSsOutput(
            'tcp LISTEN 0 511 0.0.0.0:7000 0.0.0.0:* users:(("node",pid=300,fd=18))\n'
            + 'tcp LISTEN 0 128 [::1]:5555 [::]:* users:(("helper",pid=300,fd=19))\n',
            { namespace: 'nested:app-current', containerName: 'app-current' },
        ),
    ];
    return { containers, listeners };
}

test('ss parser preserves namespace, bind class, owner process, and owner PID', () => {
    const records = parseSsOutput(
        'tcp LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=77,fd=20))\n'
        + 'udp UNCONN 0 0 *:7882 *:* users:(("livekit-server",pid=88,fd=7))\n'
        + 'tcp LISTEN 0 128 [::1]:6379 [::]:* users:(("redis-server",pid=89,fd=6))\n'
        + 'tcp LISTEN 0 128 10.88.0.3%eth0:7000 0.0.0.0:* users:(("node",pid=90,fd=8))\n',
        { namespace: 'outer' },
    );
    assert.deepEqual(records.map(record => ({
        protocol: record.protocol,
        address: record.bindAddress,
        bindClass: record.bindClass,
        port: record.port,
        owners: record.ownerProcesses,
        pids: record.ownerPids,
    })), [
        { protocol: 'tcp', address: '0.0.0.0', bindClass: 'wildcard', port: 8080, owners: ['node'], pids: [77] },
        { protocol: 'udp', address: '*', bindClass: 'wildcard', port: 7882, owners: ['livekit-server'], pids: [88] },
        { protocol: 'tcp', address: '::1', bindClass: 'loopback', port: 6379, owners: ['redis-server'], pids: [89] },
        { protocol: 'tcp', address: '10.88.0.3%eth0', bindClass: 'specific', port: 7000, owners: ['node'], pids: [90] },
    ]);
});

test('socket and bind parsing reject malformed or out-of-range values', () => {
    assert.deepEqual(parseSocketAddress('[::]:8080'), { address: '::', port: 8080 });
    assert.equal(classifyBindAddress('::'), 'wildcard');
    assert.throws(() => parseSocketAddress('127.0.0.1'), /has no port/);
    assert.throws(() => parseSocketAddress('127.0.0.1:70000'), /must be an integer/);
    assert.throws(
        () => parseSsOutput('raw malformed line', { namespace: 'outer' }),
        /cannot parse ss record/,
    );
});

test('podman JSON and PID-namespace parsers accept valid immutable evidence', () => {
    assert.deepEqual(parsePodmanPsJson('[{"Names":["one"],"Id":"1","Image":"img"}]'), [
        { name: 'one', id: '1', image: 'img' },
    ]);
    assert.deepEqual(parsePodmanPsJson('{"Names":"one","Id":"1"}\n{"Name":"/two","ID":"2"}\n'), [
        { name: 'one', id: '1', image: '' },
        { name: 'two', id: '2', image: '' },
    ]);
    assert.throws(() => parsePodmanPsJson('[{"Names":["missing-id"]}]'), /has no container ID/);
    assert.deepEqual(
        parsePidNamespaceInventory(
            '{"initPid":101,"pidNamespace":"pid:[4026533001]","pids":[102,101,102]}',
            'one',
        ),
        { initPid: 101, pidNamespace: 'pid:[4026533001]', pids: [101, 102] },
    );
    assert.throws(
        () => parsePidNamespaceInventory(
            '{"initPid":101,"pidNamespace":"pid:[4026533001]","pids":[102]}',
            'one',
        ),
        /init PID 101 is absent/,
    );
});

test('managed network evidence requires exact current workspace ownership and bridge state', () => {
    const fixture = managedNetworkFixture();
    assert.deepEqual(
        parseManagedNetworkList(JSON.stringify([{ Name: fixture.name }]), {
            workspaceHash: NETWORK_WORKSPACE_HASH,
        }),
        [fixture.name],
    );
    const record = buildManagedNetworkRecord({
        inspection: parseManagedNetworkInspection(JSON.stringify([fixture]), fixture.name),
        listedName: fixture.name,
        workspaceHash: NETWORK_WORKSPACE_HASH,
    });
    assert.equal(record.gateway, '10.89.0.1');
    assert.equal(record.id, 'network-id');
    assert.throws(
        () => buildManagedNetworkRecord({
            inspection: managedNetworkFixture({ labels: { unexpected: '1' } }),
            listedName: fixture.name,
            workspaceHash: NETWORK_WORKSPACE_HASH,
        }),
        /exact contract-2 ownership labels/,
    );
    assert.throws(
        () => buildManagedNetworkRecord({
            inspection: managedNetworkFixture({ gateway: 'not-an-ip' }),
            listedName: fixture.name,
            workspaceHash: NETWORK_WORKSPACE_HASH,
        }),
        /unsupported subnet or gateway state/,
    );
});

test('container records bind a running inspected init PID to exact PID-namespace evidence', () => {
    assert.throws(
        () => buildContainerRecord({
            listed: { name: 'stale', id: 'stale-id' },
            inspection: [{
                Id: 'stale-id',
                Name: '/stale',
                Config: { Labels: { 'io.assistos.ploinky.managed': '1' } },
                HostConfig: { NetworkMode: 'bridge', PidMode: '' },
                State: { Running: true, Pid: 301, StartedAt: 'before' },
            }],
            pidInventory: { initPid: 300, pidNamespace: 'pid:[1]', pids: [300] },
        }),
        /State\.Pid changed before PID-namespace collection/,
    );
    assert.throws(
        () => buildContainerRecord({
            listed: { name: 'stopped', id: 'stopped-id' },
            inspection: [{
                Id: 'stopped-id',
                Name: '/stopped',
                HostConfig: { NetworkMode: 'bridge', PidMode: '' },
                State: { Running: false, Pid: 0 },
            }],
            pidInventory: { initPid: 300, pidNamespace: 'pid:[1]', pids: [300] },
        }),
        /not in the running state/,
    );
    assert.throws(
        () => buildContainerRecord({
            listed: { name: 'shared', id: 'shared-id' },
            inspection: [{
                Id: 'shared-id',
                Name: '/shared',
                HostConfig: { NetworkMode: 'bridge', PidMode: 'host' },
                State: { Running: true, Pid: 300, StartedAt: 'before' },
            }],
            pidInventory: { initPid: 300, pidNamespace: 'pid:[1]', pids: [300] },
        }),
        /unsupported shared PID mode 'host'/,
    );
});

test('validator annotates every accepted listener with effective instance and rationale', () => {
    const result = validateListenerInventory(validFixtureInventory(), fixtureProfile());
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.listeners.length, 4);
    assert.deepEqual(
        result.listeners.map(record => record.effectiveInstance).sort(),
        ['agent:app', 'agent:app', 'agent:livekit', 'ploinky-core'].sort(),
    );
    assert.equal(result.listeners.every(record => record.rationale), true);
    const report = formatListenerInventory(result);
    assert.match(report, /"bindAddress":"0\.0\.0\.0"/);
    assert.match(report, /"effectiveInstance":"agent:livekit"/);
    assert.match(report, /"rationale":"fixture media mux"/);
});

test('private Router bind set is exactly loopback plus every current managed gateway', () => {
    const profile = compileListenerProfile({
        kind: 'ploinky-listener-profile',
        id: 'private-router-bind-fixture',
        requireManagedContainers: true,
        rejectAdditionalContainers: true,
        requireProcessOwners: true,
        controlPorts: [8081],
        requiredContainers: [],
        forbiddenSockets: [],
        rules: [{
            id: 'router-private',
            namespacePattern: '^outer$',
            protocols: ['tcp'],
            ports: [8081],
            dynamicBindSet: 'loopback-and-managed-gateways',
            exactOwners: ['node'],
            reviewedSensitive: true,
            minMatches: 1,
            rationale: 'fixture private Router bind set',
        }],
    });
    const managedNetworks = [
        { name: 'first', gateway: '10.89.0.1' },
        { name: 'second', gateway: '10.90.0.1' },
    ];
    const line = address => (
        `tcp LISTEN 0 511 ${address}:8081 0.0.0.0:* users:(("node",pid=100,fd=20))`
    );
    const exact = validateListenerInventory({
        listeners: parseSsOutput([
            line('127.0.0.1'),
            line('10.89.0.1'),
            line('10.90.0.1'),
        ].join('\n'), { namespace: 'outer' }),
        containers: [],
        managedNetworks,
    }, profile);
    assert.equal(exact.ok, true, exact.errors.join('\n'));

    for (const addresses of [
        ['127.0.0.1', '10.89.0.1'],
        ['127.0.0.1', '10.89.0.1', '10.90.0.1', '0.0.0.0'],
        ['127.0.0.1', '10.89.0.1', '10.90.0.1', '192.0.2.10'],
        ['127.0.0.1', '127.0.0.1', '10.89.0.1', '10.90.0.1'],
    ]) {
        const result = validateListenerInventory({
            listeners: parseSsOutput(addresses.map(line).join('\n'), { namespace: 'outer' }),
            containers: [],
            managedNetworks,
        }, profile);
        assert.equal(result.ok, false, `unexpectedly admitted ${addresses.join(',')}`);
    }
});

test('LiveKit UDP ownership requires exact process name and current host-container PID', () => {
    const wrongName = validFixtureInventory();
    wrongName.listeners = wrongName.listeners.map(record => record.port === 7882
        ? { ...record, ownerProcesses: Object.freeze(['turnserver']) }
        : record);
    const nameResult = validateListenerInventory(wrongName, fixtureProfile());
    assert.equal(nameResult.ok, false);
    assert.match(nameResult.errors.join('\n'), /unexpected wildcard listener.*7882/);

    const wrongPid = validFixtureInventory();
    wrongPid.listeners = wrongPid.listeners.map(record => record.port === 7882
        ? { ...record, ownerPids: Object.freeze([999]) }
        : record);
    const pidResult = validateListenerInventory(wrongPid, fixtureProfile());
    assert.equal(pidResult.ok, false);
    assert.match(pidResult.errors.join('\n'), /unexpected wildcard listener.*7882/);
});

test('nested listener owner PIDs must belong to the exact attributed container', () => {
    const inventory = validFixtureInventory();
    inventory.listeners = inventory.listeners.map(record => record.port === 7000
        ? { ...record, ownerPids: Object.freeze([201]) }
        : record);
    const result = validateListenerInventory(inventory, fixtureProfile());
    assert.equal(result.ok, false);
    assert.match(
        result.errors.join('\n'),
        /owner PID\(s\) 201 do not belong to exact nested container 'app-current'/,
    );
});

test('unexpected wildcard, control, forbidden, and ownerless listeners fail closed', () => {
    const cases = [
        {
            line: 'tcp LISTEN 0 10 0.0.0.0:4444 0.0.0.0:* users:(("rogue",pid=300,fd=1))',
            pattern: /unexpected wildcard listener/,
        },
        {
            line: 'tcp LISTEN 0 10 127.0.0.1:9000 0.0.0.0:* users:(("rogue",pid=300,fd=1))',
            pattern: /sensitive socket matched non-sensitive rule/,
        },
        {
            line: 'udp UNCONN 0 0 127.0.0.1:9005 0.0.0.0:* users:(("rogue",pid=300,fd=1))',
            pattern: /matches forbidden socket 'no-media-range'/,
        },
        {
            line: 'tcp LISTEN 0 10 127.0.0.1:5556 0.0.0.0:*',
            pattern: /has no owner PID\/process/,
        },
    ];
    for (const fixture of cases) {
        const inventory = validFixtureInventory();
        inventory.listeners.push(...parseSsOutput(fixture.line, {
            namespace: 'nested:app-current',
            containerName: 'app-current',
        }));
        const result = validateListenerInventory(inventory, fixtureProfile());
        assert.equal(result.ok, false);
        assert.match(result.errors.join('\n'), fixture.pattern);
    }
});

test('missing, additional, and unmanaged nested containers fail the profile', () => {
    const missing = validFixtureInventory();
    missing.containers = missing.containers.filter(value => value.name !== 'app-current');
    assert.match(
        validateListenerInventory(missing, fixtureProfile()).errors.join('\n'),
        /required container 'app-container'.*found 0/,
    );

    const additional = validFixtureInventory();
    additional.containers.push(container({ name: 'manual', pids: [400], managed: false }));
    const errors = validateListenerInventory(additional, fixtureProfile()).errors.join('\n');
    assert.match(errors, /lacks io\.assistos\.ploinky\.managed=1/);
    assert.match(errors, /unexpected nested container 'manual'/);

    const sharedPidNamespace = validFixtureInventory();
    sharedPidNamespace.containers = sharedPidNamespace.containers.map(containerRecord => ({
        ...containerRecord,
        pidNamespace: 'pid:[4026533999]',
    }));
    assert.match(
        validateListenerInventory(sharedPidNamespace, fixtureProfile()).errors.join('\n'),
        /share PID namespace 'pid:\[4026533999\]'/,
    );
});

test('collector inventories one outer namespace and each distinct nested namespace', () => {
    const responses = new Map([
        [JSON.stringify(['exec', '--user', '0', 'box', 'node', '--version']), {
            status: 0,
            stdout: 'v24.0.0\n',
        }],
        [JSON.stringify(['exec', '--user', '0', 'box', 'ss', '--version']), {
            status: 0,
            stdout: 'ss utility, iproute2-6.17.0\n',
        }],
        [JSON.stringify(['exec', '--user', '0', 'box', 'nsenter', '--version']), {
            status: 0,
            stdout: 'nsenter from util-linux 2.41.4\n',
        }],
        [JSON.stringify(['exec', 'box', 'podman', 'ps', '--format', 'json']), {
            status: 0,
            stdout: JSON.stringify([
                { Names: ['livekit-current'], Id: '1', Image: 'livekit:test' },
                { Names: ['app-current'], Id: '2', Image: 'app:test' },
            ]),
        }],
        [JSON.stringify(['exec', 'box', 'podman', 'network', 'ls', '--format', 'json']), {
            status: 0,
            stdout: '[]',
        }],
        [JSON.stringify(['exec', 'box', 'podman', 'container', 'inspect', 'livekit-current']), {
            status: 0,
            stdout: JSON.stringify([{
                Id: '1',
                Name: '/livekit-current',
                Config: { Image: 'livekit:test', Labels: { 'io.assistos.ploinky.managed': '1' } },
                HostConfig: { NetworkMode: 'host', PidMode: '' },
                State: { Running: true, Pid: 200, StartedAt: 'livekit-start' },
            }]),
        }],
        [JSON.stringify(['exec', 'box', 'podman', 'container', 'inspect', 'app-current']), {
            status: 0,
            stdout: JSON.stringify([{
                Id: '2',
                Name: '/app-current',
                Config: { Image: 'app:test', Labels: { 'io.assistos.ploinky.managed': '1' } },
                HostConfig: { NetworkMode: 'bridge', PidMode: '' },
                State: { Running: true, Pid: 300, StartedAt: 'app-start' },
            }]),
        }],
        [JSON.stringify(['exec', '--user', '0', 'box', 'ss', '-H', '-lntup']), {
            status: 0,
            stdout: 'udp UNCONN 0 0 0.0.0.0:7882 0.0.0.0:* users:(("livekit-server",pid=200,fd=7))\n',
        }],
        [JSON.stringify(['exec', '--user', '0', 'box', 'nsenter', '-t', '300', '-n', 'ss', '-H', '-lntup']), {
            status: 0,
            stdout: 'tcp LISTEN 0 10 0.0.0.0:7000 0.0.0.0:* users:(("node",pid=300,fd=8))\n',
        }],
    ]);
    const calls = [];
    const result = collectBoxListenerInventory({
        outerContainer: 'box',
        run(args) {
            calls.push(args);
            if (args[4] === 'node' && args[5] === '-e') {
                const initPid = Number(args.at(-1));
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        initPid,
                        pidNamespace: `pid:[${100000 + initPid}]`,
                        pids: [initPid],
                    }),
                };
            }
            return responses.get(JSON.stringify(args)) || { status: 1, stderr: `unexpected ${args.join(' ')}` };
        },
    });
    assert.deepEqual(result.listeners.map(record => record.namespace), ['outer', 'nested:app-current']);
    assert.equal(calls.some(args => args.includes('livekit-current') && args.includes('ss')), false);
    assert.equal(calls.some(args => args.includes('app-current') && args.includes('ss')), false);
    assert.equal(calls.some(args => args.includes('nsenter') && args.includes('300')), true);
    assert.equal(result.containers.find(value => value.name === 'livekit-current').namespace, 'outer');
    assert.equal(result.containers.find(value => value.name === 'app-current').initPid, 300);
});

test('managed-network collector rejects a generation change around listener collection', () => {
    const fixture = managedNetworkFixture();
    let inspectCalls = 0;
    const run = (args) => {
        if (args[3] === 'network' && args[4] === 'ls') {
            return { status: 0, stdout: JSON.stringify([{ Name: fixture.name }]) };
        }
        if (args[3] === 'network' && args[4] === 'inspect') {
            inspectCalls += 1;
            const current = inspectCalls === 1 ? fixture : { ...fixture, id: 'replacement-id' };
            return { status: 0, stdout: JSON.stringify([current]) };
        }
        return { status: 1, stderr: `unexpected ${args.join(' ')}` };
    };
    const expected = collectManagedNetworkInventory({ outerContainer: 'box', run });
    assert.equal(expected[0].gateway, '10.89.0.1');
    assert.throws(
        () => assertManagedNetworkInventoryCurrent({
            outerContainer: 'box',
            run,
            expected,
        }),
        /managed-network generation changed while its listener generation was collected/,
    );
});

test('collector rejects a nested graph membership change during collection', () => {
    let listCalls = 0;
    const inspection = JSON.stringify([{
        Id: 'app-id',
        Name: '/app-current',
        Config: {
            Image: 'app:test',
            Labels: { 'io.assistos.ploinky.managed': '1' },
        },
        HostConfig: { NetworkMode: 'bridge', PidMode: '' },
        State: { Running: true, Pid: 300, StartedAt: 'app-start' },
    }]);
    assert.throws(
        () => collectBoxListenerInventory({
            outerContainer: 'box',
            verifyTools: false,
            run(args) {
                if (args[2] === 'podman' && args[3] === 'network') {
                    return { status: 0, stdout: '[]' };
                }
                if (args[2] === 'podman' && args[3] === 'ps') {
                    listCalls += 1;
                    const containers = [{ Names: ['app-current'], Id: 'app-id', Image: 'app:test' }];
                    if (listCalls === 2) {
                        containers.push({ Names: ['rogue'], Id: 'rogue-id', Image: 'rogue:test' });
                    }
                    return { status: 0, stdout: JSON.stringify(containers) };
                }
                if (args[2] === 'podman' && args[3] === 'container') {
                    return { status: 0, stdout: inspection };
                }
                if (args[4] === 'node' && args[5] === '-e') {
                    return {
                        status: 0,
                        stdout: '{"initPid":300,"pidNamespace":"pid:[100300]","pids":[300]}',
                    };
                }
                if (args.includes('ss')) return { status: 0, stdout: '' };
                return { status: 1, stderr: `unexpected ${args.join(' ')}` };
            },
        }),
        /running-container set changed while its listener generation was collected/,
    );
    assert.equal(listCalls, 2);
});

test('collector reports a missing box nsenter dependency with contractual remediation', () => {
    const responses = new Map([
        [JSON.stringify(['exec', '--user', '0', 'box', 'node', '--version']), {
            status: 0,
            stdout: 'v24.0.0\n',
        }],
        [JSON.stringify(['exec', '--user', '0', 'box', 'ss', '--version']), {
            status: 0,
            stdout: 'ss utility, iproute2-6.17.0\n',
        }],
        [JSON.stringify(['exec', '--user', '0', 'box', 'nsenter', '--version']), {
            status: 127,
            stderr: 'exec: nsenter: executable file not found',
        }],
    ]);
    assert.throws(
        () => assertBoxListenerCollectorContract({
            outerContainer: 'box',
            run: args => responses.get(JSON.stringify(args)),
        }),
        /must install util-linux-core.*entrypoint must reject.*nsenter/,
    );
});

test('collector fails closed when box root cannot enter a nested network namespace', () => {
    const responses = new Map([
        [JSON.stringify(['exec', 'box', 'podman', 'network', 'ls', '--format', 'json']), {
            status: 0,
            stdout: '[]',
        }],
        [JSON.stringify(['exec', 'box', 'podman', 'ps', '--format', 'json']), {
            status: 0,
            stdout: '[{"Names":["app-current"],"Id":"app-id"}]',
        }],
        [JSON.stringify(['exec', 'box', 'podman', 'container', 'inspect', 'app-current']), {
            status: 0,
            stdout: '[{"Id":"app-id","Name":"/app-current","Config":{"Labels":{"io.assistos.ploinky.managed":"1"}},"HostConfig":{"NetworkMode":"bridge","PidMode":""},"State":{"Running":true,"Pid":300,"StartedAt":"app-start"}}]',
        }],
        [JSON.stringify(['exec', '--user', '0', 'box', 'ss', '-H', '-lntup']), {
            status: 0,
            stdout: '',
        }],
        [JSON.stringify(['exec', '--user', '0', 'box', 'nsenter', '-t', '300', '-n', 'ss', '-H', '-lntup']), {
            status: 1,
            stderr: 'nsenter: reassociate to namespace failed: Operation not permitted',
        }],
    ]);
    assert.throws(
        () => collectBoxListenerInventory({
            outerContainer: 'box',
            run(args) {
                if (args[4] === 'node' && args[5] === '-e') {
                    return {
                        status: 0,
                        stdout: '{"initPid":300,"pidNamespace":"pid:[100300]","pids":[300]}',
                    };
                }
                return responses.get(JSON.stringify(args));
            },
            verifyTools: false,
        }),
        /permit entry.*app-current.*retain the outer PID namespace/,
    );
});

test('checked-in full Explorer profile pins exact LiveKit UDP ownership and expected graph', () => {
    const profile = loadListenerProfile(FULL_PROFILE);
    assert.equal(profile.requiredContainers.length, 19);
    const livekitContainer = profile.requiredContainers.find(entry => entry.id === 'livekit');
    assert.equal(livekitContainer.networkModePattern.test('host'), true);
    assert.equal(livekitContainer.networkModePattern.test('bridge'), false);
    const media = profile.rules.find(rule => rule.id === 'livekit-udp-mux');
    assert.deepEqual(media.protocols, ['udp']);
    assert.deepEqual(media.ports, [7882]);
    assert.deepEqual(media.bindAddresses, ['0.0.0.0']);
    assert.deepEqual(media.exactOwners, ['livekit-server']);
    assert.equal(media.exclusiveSocket, true);
    assert.ok(media.ownerContainerPattern);
    const privateRouter = profile.rules.find(rule => rule.id === 'router-private');
    assert.equal(privateRouter.dynamicBindSet, 'loopback-and-managed-gateways');
    assert.deepEqual(privateRouter.bindAddresses, []);
    assert.equal(profile.rules.find(rule => rule.id === 'standard-agentserver').minMatches, 16);
    assert.equal(profile.controlPorts.includes(7681), false);
    assert.equal(profile.requiredContainers.some(entry => (
        entry.id === 'webtty'
        || entry.namePattern.test('ploinky_basic_webtty_fixture')
        || entry.effectiveInstance === 'agent:basic/webtty'
    )), false);
    assert.equal(profile.rules.some(rule => (
        rule.id === 'webtty-service'
        || rule.ports.includes(7681)
        || rule.containerPattern?.test('ploinky_basic_webtty_fixture')
    )), false);
    for (const [id, port, owner] of [
        ['onlyoffice-redis', 6379, 'redis-server'],
        ['onlyoffice-adminpanel', 9000, 'node'],
    ]) {
        const support = profile.rules.find(rule => rule.id === id);
        assert.deepEqual(support.ports, [port]);
        assert.deepEqual(support.bindClasses, ['loopback']);
        assert.equal(support.ownerPattern.test(owner), true);
        assert.equal(support.reviewedSensitive, true);
    }
});

test('checked-in routing graph profile rejects wildcard private Router binds', () => {
    const profile = loadListenerProfile(ROUTING_PROFILE);
    const publicRouter = profile.rules.find(rule => rule.id === 'router-public');
    const privateRouter = profile.rules.find(rule => rule.id === 'router-private');
    assert.equal(publicRouter.ownerPattern.test('node'), true);
    assert.equal(publicRouter.ownerPattern.test('MainThread'), true);
    assert.equal(privateRouter.ownerPattern.test('node'), true);
    assert.equal(privateRouter.ownerPattern.test('MainThread'), true);
    assert.equal(privateRouter.dynamicBindSet, 'loopback-and-managed-gateways');
    const result = validateListenerInventory({
        listeners: parseSsOutput(
            'tcp LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=100,fd=20))\n'
            + 'tcp LISTEN 0 511 0.0.0.0:8081 0.0.0.0:* users:(("node",pid=100,fd=21))\n',
            { namespace: 'outer' },
        ),
        containers: [],
        managedNetworks: [{ name: 'managed', gateway: '10.89.0.1' }],
    }, profile);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /unexpected wildcard listener.*8081/);
});
