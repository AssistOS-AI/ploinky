import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    readSmokeGraphInputs,
    SMOKE_GRAPH_REPOSITORIES,
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
    for (const name of SMOKE_GRAPH_REPOSITORIES) {
        const target = path.join(root, name);
        fs.mkdirSync(target);
        repositories[name] = target;
        revisions[name] = sha;
    }
    const runner = {
        query(command, args) {
            if (args.includes('rev-parse')) return { ok: true, stdout: `${sha}\n` };
            return { ok: true, stdout: '' };
        },
    };
    const graph = readSmokeGraphInputs({
        SMOKE_GRAPH_ARGS_JSON: '["start","AssistOSExplorer/explorer","19090"]',
        SMOKE_GRAPH_REPOSITORIES_JSON: JSON.stringify(repositories),
        SMOKE_GRAPH_REVISIONS_JSON: JSON.stringify(revisions),
    }, { runner });
    assert.equal(Object.keys(graph.repositories).length, 7);
    assert.deepEqual(graph.args, ['start', 'AssistOSExplorer/explorer', '19090']);

    const missing = { ...repositories };
    delete missing.basic;
    assert.throws(() => readSmokeGraphInputs({
        SMOKE_GRAPH_ARGS_JSON: JSON.stringify(graph.args),
        SMOKE_GRAPH_REPOSITORIES_JSON: JSON.stringify(missing),
        SMOKE_GRAPH_REVISIONS_JSON: JSON.stringify(revisions),
    }, { runner }), /exactly the seven/);
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
    const logical = 'docker.io/assistos/ploinky-box:runtime';
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
