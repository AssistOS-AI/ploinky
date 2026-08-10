import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildCandidateEvidence,
    captureCandidateEvidence,
} from '../e2e/ploinkyBox/candidateEvidence.mjs';

const CONTAINER_ID = 'a'.repeat(64);
const CANDIDATE_REFERENCE = `docker.io/assistos/ploinky-box@sha256:${'b'.repeat(64)}`;

function inspection(overrides = {}) {
    return {
        Id: CONTAINER_ID,
        Config: {
            CreateCommand: [
                'podman', 'container', 'create', '--tmpfs',
                '/tmp:rw,exec,nosuid,nodev,mode=1777,notmpcopyup',
            ],
            Env: ['TOKEN=must-not-appear'],
        },
        HostConfig: {
            Tmpfs: { '/tmp': 'rw,exec,nosuid,nodev,mode=1777,rprivate' },
        },
        Mounts: [
            {
                Type: 'bind', Source: '/secret/workspace', Destination: '/workspace', RW: true,
            },
            {
                Type: 'bind', Source: '/secret/tmp-source', Name: 'secret-volume-name',
                Destination: '/tmp', RW: true,
                Options: ['rw', 'exec', 'nosuid', 'nodev', 'mode=1777'],
            },
        ],
        ...overrides,
    };
}

function version() {
    return {
        Client: { APIVersion: '6.0.1', Version: '6.0.1', Os: 'darwin', OsArch: 'darwin/arm64' },
        Server: { APIVersion: '6.0.2', Version: '6.0.2', Os: 'linux', OsArch: 'linux/arm64' },
    };
}

function info() {
    return {
        host: {
            security: { rootless: true },
            networkBackend: 'netavark',
            pasta: { version: 'pasta 1.2.3\nsecret second line' },
        },
    };
}

test('candidate evidence projects exact restart facts without inspect secrets or bind sources', () => {
    const evidence = buildCandidateEvidence({
        name: 'native-stop-start',
        candidateReference: CANDIDATE_REFERENCE,
        beforeContainerId: CONTAINER_ID,
        afterContainerId: CONTAINER_ID,
        inspected: inspection(),
        restartTrace: [
            ['argv', 'container', 'start', CONTAINER_ID],
            ['argv', 'container', 'inspect', CONTAINER_ID],
        ],
        version: version(),
        info: info(),
        verified: { healthConfirmed: true, tmpfsCanaryAbsent: true },
        platform: 'darwin',
        architecture: 'arm64',
    });

    assert.equal(evidence.candidateDigest, `sha256:${'b'.repeat(64)}`);
    assert.equal(evidence.outerContainer.sameId, true);
    assert.deepEqual(evidence.outerContainer.createTmpfs, [
        '/tmp:rw,exec,nosuid,nodev,mode=1777,notmpcopyup',
    ]);
    assert.equal(evidence.outerContainer.hostConfigTmpfs['/tmp'],
        'rw,exec,nosuid,nodev,mode=1777,rprivate');
    assert.equal(evidence.outerContainer.mounts.length, 1);
    assert.deepEqual(evidence.restart, {
        argvRecordCount: 2,
        pullObserved: false,
        createObserved: false,
        removeObserved: false,
    });
    assert.equal(evidence.podman.pastaVersion, 'pasta 1.2.3');
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes('must-not-appear'), false);
    assert.equal(serialized.includes('/secret/workspace'), false);
    assert.equal(serialized.includes('/secret/tmp-source'), false);
    assert.equal(serialized.includes('secret-volume-name'), false);
    assert.equal(serialized.includes('secret second line'), false);
});

test('candidate evidence writes one immutable 0600 artifact when an absolute directory is supplied', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-evidence-unit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const diagnostics = [];
    const runner = {
        query(_engine, argv) {
            if (argv[0] === 'version') return { ok: true, stdout: JSON.stringify(version()) };
            if (argv[0] === 'info') return { ok: true, stdout: JSON.stringify(info()) };
            return { ok: false, stdout: '' };
        },
    };
    const result = captureCandidateEvidence({
        runner,
        evidenceDirectory: path.join(root, 'evidence'),
        diagnostic: (message) => diagnostics.push(message),
        name: 'public-cli-stop-start',
        candidateReference: CANDIDATE_REFERENCE,
        beforeContainerId: CONTAINER_ID,
        afterContainerId: CONTAINER_ID,
        inspected: inspection(),
        restartTrace: [['argv', 'container', 'start', CONTAINER_ID]],
        verified: { healthConfirmed: true },
        platform: 'linux',
        architecture: 'x64',
    });

    assert.equal(path.basename(result.path), 'public-cli-stop-start-linux-x64.json');
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(result.path, 'utf8')).outerContainer.sameId, true);
    assert.equal(diagnostics.length, 1);
    assert.throws(() => captureCandidateEvidence({
        runner,
        evidenceDirectory: path.dirname(result.path),
        name: 'public-cli-stop-start',
        candidateReference: CANDIDATE_REFERENCE,
        beforeContainerId: CONTAINER_ID,
        afterContainerId: CONTAINER_ID,
        inspected: inspection(),
        restartTrace: [],
        platform: 'linux',
        architecture: 'x64',
    }), /EEXIST/);
});

test('candidate evidence rejects mutable references, identity drift, unsafe verification data, and relative paths', () => {
    const base = {
        name: 'native-stop-start',
        candidateReference: CANDIDATE_REFERENCE,
        beforeContainerId: CONTAINER_ID,
        afterContainerId: CONTAINER_ID,
        inspected: inspection(),
        restartTrace: [],
        version: version(),
        info: info(),
    };
    for (const candidate of [
        { ...base, candidateReference: 'docker.io/assistos/ploinky-box:latest' },
        { ...base, afterContainerId: 'c'.repeat(64) },
        { ...base, verified: { diagnostic: 'must-not-be-recorded' } },
        { ...base, name: '../escape' },
    ]) {
        assert.throws(
            () => buildCandidateEvidence(candidate),
            (error) => error.code === 'PLOINKY_BOX_CANDIDATE_EVIDENCE_INVALID',
        );
    }

    const runner = {
        query(_engine, argv) {
            return { ok: true, stdout: JSON.stringify(argv[0] === 'version' ? version() : info()) };
        },
    };
    assert.throws(() => captureCandidateEvidence({
        runner,
        evidenceDirectory: 'relative/evidence',
        ...base,
    }), /absolute path/);
});
