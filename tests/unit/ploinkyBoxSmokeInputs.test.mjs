import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { BOX_IMAGE_REFERENCE } from '../../ploinky-box/constants.mjs';
import {
    readSmokeGraphInputs,
    SMOKE_GRAPH_REPOSITORIES,
    stageSmokeGraph,
} from '../../ploinky-box/smoke/graph.mjs';
import {
    readProxyTrace,
    writeCandidatePodmanProxy,
} from '../e2e/ploinkyBox/candidatePodmanProxy.mjs';

test('smoke graph requires exactly seven clean absolute real checkouts at exact SHAs', (t) => {
    const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-smoke-inputs-'));
    const root = fs.realpathSync(createdRoot);
    t.after(() => fs.rmSync(createdRoot, { recursive: true, force: true }));
    const repositories = {};
    const revisions = {};
    const sha = 'a'.repeat(40);
    const calls = [];
    const desiredCandidate = path.join(root, 'edge-desired.json');
    fs.writeFileSync(desiredCandidate, JSON.stringify({
        hosts: {},
    }));
    const desiredDigest = crypto.createHash('sha256')
        .update(fs.readFileSync(desiredCandidate))
        .digest('hex');
    for (const name of SMOKE_GRAPH_REPOSITORIES) {
        const target = path.join(root, name);
        fs.mkdirSync(target);
        repositories[name] = target;
        revisions[name] = sha;
    }
    const runner = {
        run(command, args) {
            calls.push([command, ...args]);
        },
        query(command, args) {
            if (args.includes('rev-parse')) return { ok: true, stdout: `${sha}\n` };
            if (args.includes('sha256sum')) return { ok: true, stdout: `${desiredDigest}  desired.json\n` };
            return { ok: true, stdout: '' };
        },
    };
    const baseEnvironment = {
        SMOKE_GRAPH_ARGS_JSON: '["start","AchillesIDE/explorer","19090"]',
        SMOKE_GRAPH_REPOSITORIES_JSON: JSON.stringify(repositories),
        SMOKE_GRAPH_REVISIONS_JSON: JSON.stringify(revisions),
        SMOKE_GRAPH_EDGE_DESIRED_FILE: desiredCandidate,
    };
    const graph = readSmokeGraphInputs(baseEnvironment, { runner });
    assert.equal(Object.keys(graph.repositories).length, 7);
    assert.deepEqual(graph.args, ['start', 'AchillesIDE/explorer', '19090']);

    const containerId = 'b'.repeat(64);
    stageSmokeGraph({ graph, containerId, runner });
    const copyCalls = calls.filter((call) => call[1] === 'container' && call[2] === 'cp');
    assert.ok(copyCalls.some((call) => call.at(-1) === (
        `${containerId}:/workspace/.ploinky/repos/AchillesIDE`
    )));
    assert.ok(copyCalls.every((call) => !call.at(-1).endsWith('/AssistOSExplorer')));
    assert.ok(copyCalls.some((call) => call.at(-1).endsWith('/desired.json.smoke-candidate')));
    const initializeIndex = calls.findIndex((call) => (
        call.includes('/opt/ploinky/ploinky-box/entrypoint/initialize-edge-routing.mjs')
        && call.includes('PLOINKY_WORKSPACE_ROOT=/workspace')
    ));
    const desiredCopyIndex = calls.findIndex((call) => (
        call[1] === 'container'
        && call[2] === 'cp'
        && call.at(-1).endsWith('/desired.json.smoke-candidate')
    ));
    assert.ok(initializeIndex >= 0);
    assert.ok(initializeIndex < desiredCopyIndex);
    assert.throws(() => stageSmokeGraph({
        graph,
        containerId,
        runner: {
            ...runner,
            query(command, args) {
                if (args.includes('sha256sum')) {
                    return { ok: true, stdout: `${'0'.repeat(64)}  desired.json\n` };
                }
                return runner.query(command, args);
            },
        },
    }), /desired state changed during graph staging/);

    const missing = { ...repositories };
    delete missing.basic;
    assert.throws(() => readSmokeGraphInputs({
        ...baseEnvironment,
        SMOKE_GRAPH_REPOSITORIES_JSON: JSON.stringify(missing),
    }, { runner }), /exactly the seven/);

    assert.throws(() => readSmokeGraphInputs({
        ...baseEnvironment,
        SMOKE_GRAPH_EDGE_DESIRED_FILE: 'edge-desired.json',
    }, { runner }), /must be an absolute path/);

    const desiredSymlink = path.join(root, 'edge-desired-link.json');
    fs.symlinkSync(desiredCandidate, desiredSymlink);
    assert.throws(() => readSmokeGraphInputs({
        ...baseEnvironment,
        SMOKE_GRAPH_EDGE_DESIRED_FILE: desiredSymlink,
    }, { runner }), /non-symlink regular real path/);

    const duplicateAuthorityCandidate = path.join(root, 'edge-desired-duplicate-authority.json');
    fs.writeFileSync(duplicateAuthorityCandidate, JSON.stringify({
        hosts: {},
        security: {
            hostNetworkAllowedInstances: ['media/livekit'],
        },
    }));
    assert.throws(() => readSmokeGraphInputs({
        ...baseEnvironment,
        SMOKE_GRAPH_EDGE_DESIRED_FILE: duplicateAuthorityCandidate,
    }, { runner }), /must not duplicate manifest or HTTP route policy authority/);
});

test('generated candidate proxy embeds one digest outside the repository and writes NUL-safe traces', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-proxy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'proxy');
    const tracePath = path.join(root, 'trace.bin');
    const delegated = path.join(root, 'delegated.txt');
    const realPodman = path.join(root, 'real-podman');
    fs.writeFileSync(realPodman, [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$@" > ${JSON.stringify(delegated)}`,
        '',
    ].join('\n'), { mode: 0o700 });
    const candidateReference = `docker.io/assistos/ploinky-box@sha256:${'b'.repeat(64)}`;
    const proxy = writeCandidatePodmanProxy({
        directory,
        realPodman,
        candidateReference,
        tracePath,
    });
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(proxy.podman).mode & 0o777, 0o700);
    assert.match(fs.readFileSync(proxy.podman, 'utf8'), new RegExp(candidateReference));
    const logical = BOX_IMAGE_REFERENCE;
    const allowed = spawnSync(proxy.podman, ['pull', logical], { encoding: 'utf8' });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.deepEqual(fs.readFileSync(delegated, 'utf8').trim().split('\n'), [
        'pull', candidateReference,
    ]);
    assert.deepEqual(readProxyTrace(tracePath), [
        ['argv', 'pull', logical],
        ['rewrite', logical, candidateReference],
    ]);
    const immutableImageId = `sha256:${'c'.repeat(64)}`;
    const immutableInspect = spawnSync(
        proxy.podman, ['image', 'inspect', immutableImageId], { encoding: 'utf8' },
    );
    assert.equal(immutableInspect.status, 0, immutableInspect.stderr);
    assert.deepEqual(fs.readFileSync(delegated, 'utf8').trim().split('\n'), [
        'image', 'inspect', immutableImageId,
    ]);
    assert.deepEqual(readProxyTrace(tracePath).at(-1), [
        'argv', 'image', 'inspect', immutableImageId,
    ]);
    const rejected = spawnSync(proxy.podman, ['pull', 'docker.io/attacker/image:latest'], {
        encoding: 'utf8',
    });
    assert.equal(rejected.status, 64);
    assert.match(rejected.stderr, /rejected unsupported image-bearing/);
    assert.deepEqual(readProxyTrace(tracePath).at(-2), [
        'argv', 'pull', 'docker.io/attacker/image:latest',
    ]);
    assert.deepEqual(readProxyTrace(tracePath).at(-1), [
        'reject', 'pull', 'docker.io/attacker/image:latest',
    ]);
});
