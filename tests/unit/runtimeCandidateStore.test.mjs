import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRuntimeCandidate, retireRuntimeCandidate, writeRuntimeCandidate } from '../../cli/sandbox/runtimeCandidateStore.js';

function fixture(t) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-candidate-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const containerId = 'a'.repeat(64);
    const candidate = {
        operationId: crypto.randomUUID(),
        containerName: 'ploinky_repo_demo_workspace',
        containerId,
        predecessorContainerId: 'b'.repeat(64),
        runtime: 'podman',
        runtimeNetwork: { mode: 'default' },
        registryRecord: {
            type: 'agent', agentName: 'demo', repoName: 'repo', runtime: 'podman', containerId,
            instanceId: 'instance-current', enableGeneration: 'enable-current',
            auth: { secret: 'must-not-persist' },
            config: {
                env: [{ name: 'SECRET', value: 'must-not-persist' }],
                binds: [{
                    source: path.join(workspaceRoot, '.ploinky/run/router-descriptors', `${crypto.randomUUID()}.json`),
                    target: '/run/ploinky/router-descriptor.json', ro: true, generatedRouterDescriptor: true,
                }],
            },
        },
        preparationLease: {
            transactionId: crypto.randomUUID(), preparedGeneration: `sha256:${'1'.repeat(64)}`,
            lifecycleBindingDigest: `sha256:${'2'.repeat(64)}`, selectorActivationId: crypto.randomUUID(),
            selectorDigest: `sha256:${'3'.repeat(64)}`, mode: 'replacement', predecessorGeneration: '',
        },
    };
    return { workspaceRoot, candidate };
}

test('failed candidate identity survives reload without changing the staged predecessor or persisting credentials', t => {
    const { workspaceRoot, candidate } = fixture(t);
    const predecessor = structuredClone(candidate.registryRecord);
    predecessor.containerId = candidate.predecessorContainerId;
    const before = JSON.stringify(predecessor);
    const saved = writeRuntimeCandidate(candidate, { workspaceRoot });
    const loaded = readRuntimeCandidate(candidate.containerName, predecessor, { workspaceRoot });
    assert.deepEqual(loaded, saved);
    assert.equal(JSON.stringify(predecessor), before);
    assert.equal(loaded.containerId, candidate.containerId);
    assert.equal(loaded.predecessorContainerId, predecessor.containerId);
    assert.deepEqual(loaded.preparationLease, candidate.preparationLease);
    assert.equal(loaded.registryRecord.config.binds[0].generatedRouterDescriptor, true);
    assert.equal(JSON.stringify(loaded).includes('must-not-persist'), false);
    const root = path.join(workspaceRoot, '.ploinky/run/runtime-candidates');
    assert.equal(fs.statSync(path.join(root, fs.readdirSync(root)[0])).mode & 0o777, 0o600);
});

test('candidate receipt cannot be overwritten or retired by another launch and allows an exact retry', t => {
    const { workspaceRoot, candidate } = fixture(t);
    const saved = writeRuntimeCandidate(candidate, { workspaceRoot });
    assert.deepEqual(writeRuntimeCandidate(candidate, { workspaceRoot }), saved);
    const other = { ...candidate, operationId: crypto.randomUUID() };
    assert.throws(() => writeRuntimeCandidate(other, { workspaceRoot }), /different launch/);
    assert.throws(() => retireRuntimeCandidate(other, { workspaceRoot }), /changed before retirement/);
    assert.equal(retireRuntimeCandidate(saved, { workspaceRoot }), true);
    assert.equal(retireRuntimeCandidate(saved, { workspaceRoot }), false);
    assert.equal(readRuntimeCandidate(candidate.containerName, candidate.registryRecord, { workspaceRoot }), null);
    assert.equal(writeRuntimeCandidate(other, { workspaceRoot }).operationId, other.operationId);
});

test('candidate lookup is scoped to its exact workspace and immutable registry tuple', t => {
    const { workspaceRoot, candidate } = fixture(t);
    writeRuntimeCandidate(candidate, { workspaceRoot });
    for (const field of ['instanceId', 'enableGeneration']) {
        const otherRecord = { ...candidate.registryRecord, [field]: 'another-generation' };
        assert.equal(readRuntimeCandidate(candidate.containerName, otherRecord, { workspaceRoot }), null);
    }
    assert.equal(readRuntimeCandidate('other-name', candidate.registryRecord, { workspaceRoot }), null);
    assert.equal(readRuntimeCandidate(candidate.containerName, candidate.registryRecord, { workspaceRoot: path.join(workspaceRoot, 'other') }), null);
    for (const [field, value] of Object.entries({
        type: 'other', repoName: 'other-repo', agentName: 'other-agent', runtime: 'docker', alias: 'another-instance',
    })) {
        assert.throws(() => readRuntimeCandidate(candidate.containerName, {
            ...candidate.registryRecord, [field]: value,
        }, { workspaceRoot }), /does not match its exact launch identity/);
    }
    const missingPrincipal = { ...candidate.registryRecord };
    delete missingPrincipal.repoName;
    assert.throws(() => readRuntimeCandidate(candidate.containerName, missingPrincipal, { workspaceRoot }), /does not match its exact launch identity/);
});

test('candidate receipts reject short IDs, unbounded documents and final-file symlinks', t => {
    const { workspaceRoot, candidate } = fixture(t);
    assert.throws(() => writeRuntimeCandidate({ ...candidate, containerId: 'a'.repeat(12) }, { workspaceRoot }), /full container ID/);
    assert.throws(() => writeRuntimeCandidate({
        ...candidate, registryRecord: { ...candidate.registryRecord, agentName: 'a'.repeat(100_000) },
    }, { workspaceRoot }), /registered agent identity/);
    writeRuntimeCandidate(candidate, { workspaceRoot });
    const root = path.join(workspaceRoot, '.ploinky/run/runtime-candidates');
    const file = path.join(root, fs.readdirSync(root)[0]);
    fs.renameSync(file, `${file}.original`);
    fs.symlinkSync(`${file}.original`, file);
    assert.throws(() => readRuntimeCandidate(candidate.containerName, candidate.registryRecord, { workspaceRoot }), /one regular file/);
    assert.equal(fs.existsSync(`${file}.original`), true);
});
