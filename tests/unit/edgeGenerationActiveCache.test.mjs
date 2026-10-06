// R1: the verified active-generation cache. A cache hit keeps every per-call
// invariant-7 check (fresh selector read, generation/activation comparison,
// generation-file lstat stamp, runtime bindings, hardware-revision fence) and
// only skips re-parsing and re-verifying an untouched generation file. Real
// workspaces and real generations; no mocks of the edge module.
import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as edgeGeneration from '../../cli/sandbox/edgeGeneration.js';
import { makeWorld } from './hardwareAvailabilityResolverFixtures.mjs';
import {
    generationDocumentFile,
    readGenerationDocument,
    selectActiveGeneration,
} from '../helpers/routerOriginsWorkspace.mjs';

const { loadActiveEdgeRoutingGeneration: load } = edgeGeneration;

// Every test starts with an empty cache so its stats are its own.
function quiet(t) {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    edgeGeneration.__testables.resetActiveGenerationCache();
}

const stats = () => edgeGeneration.__testables.activeGenerationCacheStats();

function generationPath(world, generation = world.selection().generation) {
    return generationDocumentFile(path.join(world.ploinkyDir, 'data', 'edge-routing'), generation);
}

function envScope(t, names) {
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    t.after(() => {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

// A new manifest route changes the captured manifest bytes and so the generation id.
function applyDistinctGeneration(world, index) {
    const manifestFile = path.join(world.ploinkyDir, 'repos', 'fixtures', 'alpha', 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify({
        routerAccess: { httpRoutes: [{ path: `/public-${index}.html`, access: 'public' }], agentPorts: true },
    }));
    return world.apply(`distinct-${index}`);
}

test('1: a warm cache serves 200 captures and commits without any reconstruction', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const warm = world.lease();
    assert.equal(warm.commit(), true);
    const before = stats();
    for (let index = 0; index < 200; index += 1) {
        assert.equal(world.lease().commit(), true, `commit ${index}`);
    }
    const after = stats();
    assert.equal(after.reconstructs - before.reconstructs, 0, 'no reconstructGeneration after warm-up');
    assert.equal(after.misses - before.misses, 0);
    assert.ok(after.hits - before.hits >= 400, 'every capture and commit was a cache hit');
});

test('2: re-applying the same generation fails the old lease without reconstruction', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const lease = world.lease();
    assert.equal(lease.commit(), true);
    const before = stats();
    const reapplied = world.apply('reapply-same-generation');
    assert.equal(reapplied, lease.id, 'unchanged sources select the same generation id');
    assert.equal(lease.commit(), false, 'a new activation id fails the old lease');
    assert.equal(lease.isCurrent(), false);
    const fresh = world.lease();
    assert.notEqual(fresh.activationId, lease.activationId);
    assert.equal(fresh.commit(), true);
    assert.equal(stats().reconstructs - before.reconstructs, 0, 'same id and publicationState reuse the cache');
});

test('3: an inactive selector throws EDGE_GENERATION_INACTIVE and fails the old lease with a warm cache', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const lease = world.lease();
    assert.equal(lease.commit(), true);
    world.inactivate('cache-test-inactive');
    assert.throws(() => world.lease(), { code: 'EDGE_GENERATION_INACTIVE' });
    assert.throws(() => load(world.options), { code: 'EDGE_GENERATION_INACTIVE' });
    assert.equal(lease.commit(), false);
    assert.equal(lease.isCurrent(), false);
});

test('4: runtime binding changes throw EDGE_GENERATION_RUNTIME_MISMATCH on a warm cache', (t) => {
    quiet(t);
    const world = makeWorld(t);
    envScope(t, ['PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MEDIA_HOST_PORT', 'PLOINKY_PUBLIC_ROUTER_HOSTS']);
    assert.equal(world.lease().commit(), true);
    const lease = world.lease();
    for (const [name, value] of [
        ['PLOINKY_ROUTER_HOST_PORT', '18999'],
        ['PLOINKY_MEDIA_HOST_PORT', '17999'],
        ['PLOINKY_PUBLIC_ROUTER_HOSTS', JSON.stringify(['attacker.example'])],
    ]) {
        const original = process.env[name];
        process.env[name] = value;
        assert.throws(() => load(world.options), { code: 'EDGE_GENERATION_RUNTIME_MISMATCH' }, name);
        assert.throws(() => world.lease(), { code: 'EDGE_GENERATION_RUNTIME_MISMATCH' }, name);
        assert.equal(lease.commit(), false, `${name}: an existing lease fails closed`);
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
        assert.equal(lease.commit(), true, `${name}: restored binding is current again`);
    }
});

test('5: a missing generation file throws EDGE_GENERATION_CORRUPT on every call and errors are never cached', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const file = generationPath(world);
    load(world.options);
    const backup = `${file}.backup`;
    fs.renameSync(file, backup);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.throws(() => load(world.options), { code: 'EDGE_GENERATION_CORRUPT' }, `warm cache, attempt ${attempt}`);
    }
    fs.renameSync(backup, file);
    assert.equal(load(world.options).selector.generation, world.selection().generation, 'the next call succeeds');

    // The same without a prior hit.
    edgeGeneration.__testables.resetActiveGenerationCache();
    fs.renameSync(file, backup);
    assert.throws(() => load(world.options), { code: 'EDGE_GENERATION_CORRUPT' });
    assert.throws(() => load(world.options), { code: 'EDGE_GENERATION_CORRUPT' });
    assert.equal(stats().size, 0, 'a failed load inserts nothing');
    fs.renameSync(backup, file);
    assert.doesNotThrow(() => load(world.options));
});

test('6: a selector with a wrong selectorDigest is inactive even with a warm cache', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const lease = world.lease();
    assert.equal(lease.commit(), true);
    const selector = JSON.parse(fs.readFileSync(world.paths.activeSelectorFile, 'utf8'));
    fs.writeFileSync(world.paths.activeSelectorFile, JSON.stringify({
        ...selector,
        selectorDigest: `sha256:${'0'.repeat(64)}`,
    }));
    assert.throws(() => load(world.options), { code: 'EDGE_GENERATION_INACTIVE' });
    assert.throws(() => world.lease(), { code: 'EDGE_GENERATION_INACTIVE' });
    assert.equal(lease.commit(), false);
});

test('7: the same generation id in a second workspace with a tampered file is corrupt, not served from the first cache', (t) => {
    quiet(t);
    const first = makeWorld(t);
    const second = makeWorld(t);
    const { generation: id } = first.selection();
    const warmFirst = load(first.options).generation;

    const secondEdgeDir = path.join(second.ploinkyDir, 'data', 'edge-routing');
    const document = readGenerationDocument(path.join(first.ploinkyDir, 'data', 'edge-routing'), id);
    // Control: an untampered copy is a valid, separately cached generation.
    fs.writeFileSync(generationDocumentFile(secondEdgeDir, id), JSON.stringify(document, null, 2));
    selectActiveGeneration(secondEdgeDir, id);
    const warmSecond = load(second.options).generation;
    assert.notEqual(warmSecond, warmFirst, 'a different generationsDir is a different cache entry');
    assert.equal(stats().size, 2);

    fs.writeFileSync(generationDocumentFile(secondEdgeDir, id), JSON.stringify({
        ...document,
        compiledDigest: `sha256:${'0'.repeat(64)}`,
    }, null, 2));
    assert.throws(() => load(second.options), { code: 'EDGE_GENERATION_CORRUPT' });
    assert.equal(load(first.options).generation, warmFirst, 'the first workspace is unaffected');
});

test('8: the result is frozen, the generation object is shared, and the cache holds at most 4 entries', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const first = load(world.options);
    const second = load(world.options);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.selector));
    assert.ok(Object.isFrozen(first.paths));
    assert.ok(Object.isFrozen(first.generation));
    assert.ok(Object.isFrozen(first.generation.compiled));
    assert.ok(Object.isFrozen(first.generation.routing));
    assert.notEqual(first, second, 'the wrapper is fresh per call');
    assert.equal(first.generation, second.generation, 'the verified generation is shared');

    const ids = [world.selection().generation];
    for (let index = 1; index < 6; index += 1) {
        ids.push(applyDistinctGeneration(world, index));
        load(world.options);
        assert.ok(stats().size <= 4, `size after generation ${index + 1}`);
    }
    assert.equal(new Set(ids).size, 6, 'six distinct generations');
    assert.equal(stats().size, 4);

    const edgeDir = path.join(world.ploinkyDir, 'data', 'edge-routing');
    // LRU: the newest generation is still cached, the oldest was evicted.
    let before = stats().reconstructs;
    selectActiveGeneration(edgeDir, ids[5]);
    load(world.options);
    assert.equal(stats().reconstructs - before, 0, 'newest generation is a hit');
    before = stats().reconstructs;
    selectActiveGeneration(edgeDir, ids[0]);
    load(world.options);
    assert.equal(stats().reconstructs - before, 1, 'oldest generation was evicted and is re-verified');
    assert.equal(stats().size, 4);
});

test('9: a hardware-availability revision change between capture and commit still fails the lease on a warm cache', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slot = world.stageSlot('alpha');
    world.writeWorker('alpha', slot, { kind: 'starting' });
    const lease = world.lease();
    assert.equal(lease.commit(), true);
    const before = stats();
    world.writeWorker('alpha', slot, { kind: 'hardware' });
    assert.equal(lease.commit(), false, 'the fence is evaluated on every commit');
    assert.equal(lease.isCurrent(), false);
    assert.equal(stats().reconstructs - before.reconstructs, 0, 'the failure came from the fence, not from a reload');
    const later = world.lease();
    assert.equal(later.effective.denials.get('alpha').state, 'refused');
    assert.equal(later.commit(), true, 'a lease captured after the change is current');
});

test('10a: an in-place rewrite of a cached generation file is re-verified and fails closed', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const file = generationPath(world);
    load(world.options);
    const original = fs.readFileSync(file);
    // Same size, different bytes: only the stamp can notice.
    const rewritten = Buffer.from(original);
    const at = rewritten.indexOf(Buffer.from('"schemaVersion"')) + 1;
    rewritten[at] = rewritten[at] === 0x53 ? 0x54 : 0x53;
    assert.equal(rewritten.length, original.length);
    fs.writeFileSync(file, rewritten);
    assert.throws(() => load(world.options), { code: 'EDGE_GENERATION_CORRUPT' });
    fs.writeFileSync(file, original);
    assert.doesNotThrow(() => load(world.options));
    fs.unlinkSync(file);
    assert.throws(() => load(world.options), { code: 'EDGE_GENERATION_CORRUPT' });
});

test('11: 1000 warm loads perform one lstat each and no read of the generation file', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const file = generationPath(world);
    load(world.options);
    const originalLstat = fs.lstatSync;
    const originalRead = fs.readFileSync;
    const lstats = [];
    const reads = [];
    t.mock.method(fs, 'lstatSync', (...args) => {
        if (args[0] === file) lstats.push(args[0]);
        return originalLstat.apply(fs, args);
    });
    t.mock.method(fs, 'readFileSync', (...args) => {
        if (args[0] === file) reads.push(args[0]);
        return originalRead.apply(fs, args);
    });
    for (let index = 0; index < 1000; index += 1) load(world.options);
    assert.equal(lstats.length, 1000);
    assert.equal(reads.length, 0);
});
