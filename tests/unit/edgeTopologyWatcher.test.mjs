import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readEdgeTopology, watchEdgeTopology } from '../../Agent/lib/edgeTopology.mjs';

const CONFIGURATION = `sha256:${'c'.repeat(64)}`;
const AUTHORIZATION = `sha256:${'a'.repeat(64)}`;

function topology(publicationGeneration) {
    return {
        schemaVersion: 2,
        configurationGeneration: CONFIGURATION,
        authorizationGeneration: AUTHORIZATION,
        publicationGeneration,
        state: 'local-ready',
        services: [],
    };
}

function atomicReplace(file, value) {
    const temporary = `${file}.${value.publicationGeneration}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
}

function waitForGeneration(observed, generation) {
    if (observed.some((entry) => entry.publicationGeneration === generation)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`topology generation ${generation} was not observed`)), 2_000);
        const poll = setInterval(() => {
            if (!observed.some((entry) => entry.publicationGeneration === generation)) return;
            clearInterval(poll);
            clearTimeout(deadline);
            resolve();
        }, 10);
    });
}

test('topology watcher survives repeated atomic current-file replacement', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-topology-watch-'));
    const file = path.join(directory, 'current.json');
    fs.writeFileSync(file, JSON.stringify(topology(1)));
    const observed = [];
    const errors = [];
    const watcher = watchEdgeTopology({
        file,
        onChange: (value) => observed.push(value),
        onError: (error) => errors.push(error),
    });
    t.after(() => {
        watcher.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    assert.equal(observed.at(-1).publicationGeneration, 1);
    atomicReplace(file, topology(2));
    await waitForGeneration(observed, 2);
    atomicReplace(file, topology(3));
    await waitForGeneration(observed, 3);
    assert.deepEqual(observed.map((entry) => entry.publicationGeneration), [1, 2, 3]);
    assert.deepEqual(errors, []);
});

test('topology reader rejects a missing or malformed authorization generation', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-topology-auth-'));
    const file = path.join(directory, 'current.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const missing = topology(1);
    delete missing.authorizationGeneration;
    fs.writeFileSync(file, JSON.stringify(missing));
    assert.throws(() => readEdgeTopology({ file }), /invalid authorizationGeneration/);

    fs.writeFileSync(file, JSON.stringify({ ...topology(1), authorizationGeneration: 'sha256:not-a-digest' }));
    assert.throws(() => readEdgeTopology({ file }), /invalid authorizationGeneration/);
});
