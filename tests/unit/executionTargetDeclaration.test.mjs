import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DECLARATION_ERROR_CODES,
    EXECUTION_TARGET_HELPER_CONTRACT_ID,
    TARGET_FRAME_BYTES_FLOOR,
    TARGET_LIMITS_V1,
    TARGET_POLICY_V1,
    UNRESTRICTED_SERVICE_NAMES,
    combineTargetLimits,
    readExecutionTargetDeclaration,
    requireExecutionTargetDeclaration,
    validateExecutionTargetDeclaration,
} from '../../cli/server/executionTarget/declaration.mjs';
import { INTERLOCK_LIMITS_V1 } from '../../cli/server/executionTarget/contract.mjs';

const digest = (char) => char.repeat(64);

function declaration(overrides = {}) {
    return {
        version: 1,
        helper: { contractId: EXECUTION_TARGET_HELPER_CONTRACT_ID, contractDigest: digest('a'), executableDigest: digest('b') },
        inventoryDigest: digest('c'),
        profile: { id: 'nested-target', digest: digest('d') },
        stateExports: [
            { id: 'cache', relativePath: 'state/cache', access: 'read', sharing: 'target-shared', filterPolicyDigest: digest('e') },
            { id: 'workdir', relativePath: 'state/work', access: 'write', sharing: 'target-shared', filterPolicyDigest: digest('f') },
        ],
        serviceExports: [
            { id: 'indexer', endpointId: 'indexer-endpoint', operations: ['query', 'status'], policyDigest: digest('1') },
        ],
        limits: { ...TARGET_LIMITS_V1 },
        ...overrides,
    };
}

const code = (result) => (result.ok ? 'ok' : result.error.code);
const check = (value) => validateExecutionTargetDeclaration(value);

function assertExactResult(result) {
    assert.equal(Object.isFrozen(result), true);
    if (result.ok) assert.deepEqual(Object.keys(result).sort(), ['ok', 'value']);
    else assert.deepEqual(result, { ok: false, error: { code: result.error.code } });
}

test('a valid declaration is returned as a deep-frozen copy', () => {
    const input = declaration();
    const result = check(input);
    assertExactResult(result);
    assert.equal(result.ok, true);
    assert.notEqual(result.value, input);
    assert.deepEqual(result.value, input);
    assert.equal(Object.isFrozen(result.value.serviceExports[0].operations), true);
    assert.equal(check(declaration({ stateExports: [], serviceExports: [] })).ok, true);
    assert.equal(Object.isFrozen(DECLARATION_ERROR_CODES), true);
});

test('ENC-01 unknown keys at every object level are invalid_request', () => {
    const mutations = [
        (value) => { value.extra = 1; },
        (value) => { value.helper.extra = 1; },
        (value) => { value.profile.extra = 1; },
        (value) => { value.stateExports[0].extra = 1; },
        (value) => { value.serviceExports[0].extra = 1; },
        (value) => { value.limits.extra = 1; },
    ];
    for (const mutate of mutations) {
        const value = declaration();
        mutate(value);
        assert.equal(code(check(value)), 'invalid_request');
    }
});

test('ENC-02 version 0, 2, "1" or missing is unsupported_version', () => {
    for (const version of [0, 2, '1', null]) assert.equal(code(check(declaration({ version }))), 'unsupported_version');
    const { version, ...missing } = declaration();
    assert.equal(code(check(missing)), 'unsupported_version');
});

test('DEC-01 a command, helper URL, arbitrary path or privilege grant is invalid_request', () => {
    const mutations = {
        command: (value) => { value.command = ['sh', '-c', 'x']; },
        helperUrl: (value) => { value.helper.url = 'http://helper.invalid'; },
        helperPath: (value) => { value.helper.path = '/usr/local/bin/helper'; },
        capabilities: (value) => { value.capabilities = ['SYS_ADMIN']; },
        privileged: (value) => { value.privileged = true; },
        devices: (value) => { value.devices = ['/dev/fuse']; },
        absolutePath: (value) => { value.stateExports[0].relativePath = '/var/lib/state'; },
        parentPath: (value) => { value.stateExports[0].relativePath = 'state/../../etc'; },
        backslash: (value) => { value.stateExports[0].relativePath = 'state\\x'; },
        socket: (value) => { value.serviceExports[0].socketPath = '/run/x.sock'; },
        hostname: (value) => { value.serviceExports[0].endpointId = 'helper.example.invalid'; },
        wrongContract: (value) => { value.helper.contractId = 'ploinky.execution-target-helper.v2'; },
        tagDigest: (value) => { value.helper.executableDigest = 'latest'; },
        uppercaseDigest: (value) => { value.inventoryDigest = digest('A'); },
        wideAccess: (value) => { value.stateExports[0].access = 'admin'; },
        notShared: (value) => { value.stateExports[0].sharing = 'confidential'; },
        badProfile: (value) => { value.profile.id = 'Nested'; },
    };
    for (const [label, mutate] of Object.entries(mutations)) {
        const value = declaration();
        mutate(value);
        assert.equal(code(check(value)), 'invalid_request', label);
    }
});

test('DEC-02 duplicate or unsorted export IDs are invalid; unrestricted management or shell services are service_policy_unavailable', () => {
    const duplicate = declaration();
    duplicate.stateExports[1].id = 'cache';
    assert.equal(code(check(duplicate)), 'invalid_request');
    const unsorted = declaration();
    unsorted.stateExports.reverse();
    assert.equal(code(check(unsorted)), 'invalid_request');
    const unsortedOperations = declaration();
    unsortedOperations.serviceExports[0].operations = ['status', 'query'];
    assert.equal(code(check(unsortedOperations)), 'invalid_request');
    const sameEndpoint = declaration();
    sameEndpoint.serviceExports.push({ ...sameEndpoint.serviceExports[0], id: 'search' });
    assert.equal(code(check(sameEndpoint)), 'invalid_request');
    for (const name of ['shell', 'exec', 'management', 'admin', 'engine', 'terminal']) {
        for (const field of ['operations', 'endpointId', 'id']) {
            const value = declaration();
            if (field === 'operations') value.serviceExports[0].operations = [name, 'status'].sort();
            else value.serviceExports[0][field] = name;
            assert.equal(code(check(value)), 'service_policy_unavailable', `${field}:${name}`);
        }
    }
    assert.ok(UNRESTRICTED_SERVICE_NAMES.includes('shell'));
});

test('DEC-03 agentExec or executionProvider is never a target opt-in', () => {
    const manifests = [
        { routerAccess: { agentExec: true } },
        { executionProvider: { version: 1, port: 7300, terminals: { path: '/t' } } },
        { executionProvider: { version: 1, port: 7300, terminals: { path: '/t' } }, routerAccess: { agentExec: true } },
        {},
    ];
    for (const manifest of manifests) {
        assert.deepEqual(readExecutionTargetDeclaration(manifest), { present: false });
        assert.deepEqual(requireExecutionTargetDeclaration(manifest), { ok: false, error: { code: 'target_contract_missing' } });
    }
    assert.equal(code(check(declaration({ agentExec: true }))), 'invalid_request');
    assert.equal(code(check(declaration({ executionProvider: {} }))), 'invalid_request');
});

test('presence is the own property: a present null or invalid declaration is invalid, never absent', () => {
    assert.deepEqual(readExecutionTargetDeclaration(null), { present: false });
    assert.deepEqual(readExecutionTargetDeclaration(Object.create({ executionTarget: declaration() })), { present: false });
    for (const value of [null, [], {}, 'x', 1, true]) {
        const read = readExecutionTargetDeclaration({ executionTarget: value });
        assert.equal(read.present, true);
        assert.equal(read.result.ok, false, JSON.stringify(value));
        assert.notEqual(requireExecutionTargetDeclaration({ executionTarget: value }).error.code, 'target_contract_missing');
    }
    const read = readExecutionTargetDeclaration({ executionTarget: declaration() });
    assert.equal(read.result.ok, true);
    assert.equal(Object.isFrozen(read), true);
});

test('CAP-01 export, operation and byte bounds at the ceiling and one above', () => {
    const states = (count) => Array.from({ length: count }, (_, index) => ({
        id: `s${String(index).padStart(3, '0')}`, relativePath: `state/${index}`, access: 'read', sharing: 'target-shared', filterPolicyDigest: digest('e'),
    }));
    assert.equal(check(declaration({ stateExports: states(32) })).ok, true);
    assert.equal(code(check(declaration({ stateExports: states(33) }))), 'capacity_exceeded');
    const services = (count) => Array.from({ length: count }, (_, index) => ({
        id: `v${String(index).padStart(3, '0')}`, endpointId: `e${String(index).padStart(3, '0')}`, operations: ['query'], policyDigest: digest('1'),
    }));
    assert.equal(check(declaration({ serviceExports: services(16) })).ok, true);
    assert.equal(code(check(declaration({ serviceExports: services(17) }))), 'capacity_exceeded');
    const operations = (count) => Array.from({ length: count }, (_, index) => `op${String(index).padStart(3, '0')}`);
    const withOperations = (count) => declaration({ serviceExports: [{ ...declaration().serviceExports[0], operations: operations(count) }] });
    assert.equal(check(withOperations(32)).ok, true);
    assert.equal(code(check(withOperations(33))), 'capacity_exceeded');
    assert.equal(code(check(withOperations(0))), 'invalid_request');
    const huge = declaration({ stateExports: states(32).map((entry) => ({ ...entry, relativePath: `${Array(15).fill('x'.repeat(250)).join('/')}/${entry.id}` })) });
    assert.equal(code(check(huge)), 'capacity_exceeded');
});

test('limits carry exactly the TARGET_LIMITS_V1 keys and may only lower the ceilings', () => {
    assert.equal(Object.keys(TARGET_LIMITS_V1).length, 31);
    for (const [key, ceiling] of Object.entries(TARGET_LIMITS_V1)) {
        assert.equal(check(declaration({ limits: { ...TARGET_LIMITS_V1, [key]: 1 } })).ok, true, key);
        for (const bad of [0, -1, ceiling + 1, 1.5, '1', null]) {
            assert.equal(code(check(declaration({ limits: { ...TARGET_LIMITS_V1, [key]: bad } }))), 'invalid_request', `${key}=${bad}`);
        }
    }
    const { frameBytes, ...missing } = TARGET_LIMITS_V1;
    assert.equal(code(check(declaration({ limits: missing }))), 'invalid_request');
});

test('CAP-03 a declaration lowering settledReceiptRetentionMs or carrying any interlock key is invalid_request', () => {
    assert.equal(TARGET_POLICY_V1.settledReceiptRetentionMs, 604800000);
    assert.equal(code(check(declaration({ limits: { ...TARGET_LIMITS_V1, settledReceiptRetentionMs: 1 } }))), 'invalid_request');
    for (const key of [...Object.keys(INTERLOCK_LIMITS_V1), 'retiredWorkerGenerations']) {
        assert.equal(code(check(declaration({ limits: { ...TARGET_LIMITS_V1, [key]: 1 } }))), 'invalid_request', key);
        assert.equal(code(check(declaration({ [key]: 1 }))), 'invalid_request', key);
    }
});

test('combined limits are the component-wise minimum and satisfy the A1.4 and A2.4 relationships', () => {
    const combined = combineTargetLimits({ ...TARGET_LIMITS_V1, executionsPerTarget: 2 }, { ...TARGET_LIMITS_V1, connectionsPerExecution: 32 });
    assert.equal(combined.ok, true);
    assert.equal(combined.value.executionsPerTarget, 2);
    assert.equal(combined.value.connectionsPerExecution, 32);
    assert.equal(combineTargetLimits().ok, true);
    const violations = {
        'renewal ratio 3x (A2.4)': { renewIntervalMs: 5000, leaseTtlMs: 14999 },
        'frame floor (A2.4)': { frameBytes: TARGET_FRAME_BYTES_FLOOR - 1 },
        'data frame within connection buffer (A2.4)': { bufferedBytesPerConnection: 65535 },
        'header plus data plus envelope': { headerBytes: 16384, dataBytesPerFrame: 65536, frameBytes: TARGET_FRAME_BYTES_FLOOR, bufferedBytesPerConnection: 262144 },
        'pending opens': { pendingOpensPerTarget: 7 },
        'connections per execution vs target': { connectionsPerTarget: 63 },
        'listeners within connections': { connectionsPerExecution: 20 },
        'buffered chain': { bufferedBytesPerExecution: 262143 },
        'descriptor chain': { descriptorsPerExecution: 7 },
        'descriptor target': { descriptorsPerTarget: 255 },
        'challenge within lease': { leaseTtlMs: 4999, renewIntervalMs: 1000 },
        'connection within execution lifetime': { executionLifetimeMs: 86399999 },
        'idle within connection lifetime': { connectionLifetimeMs: 299999, executionLifetimeMs: 299999 },
    };
    for (const [label, lowered] of Object.entries(violations)) {
        const result = combineTargetLimits({ ...TARGET_LIMITS_V1, ...lowered });
        if (label === 'header plus data plus envelope') {
            assert.equal(result.ok, true, label);
            continue;
        }
        assert.equal(code(result), 'invalid_request', label);
    }
    assert.equal(combineTargetLimits({ ...TARGET_LIMITS_V1, renewIntervalMs: 5000, leaseTtlMs: 15000 }).ok, true);
    assert.equal(code(combineTargetLimits({ ...TARGET_LIMITS_V1, extra: 1 })), 'invalid_request');
});
