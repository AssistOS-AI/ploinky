import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    applyEdgeRoutingGeneration,
    commitAdditiveEdgeRoutingGeneration,
    loadActiveEdgeRoutingGeneration,
    prepareAdditiveEdgeRoutingGeneration,
    readCurrentEdgeTopology,
    withEdgeGenerationApplyLock,
} from '../../cli/sandbox/edgeGeneration.js';
import {
    createRouterOriginsWorkspace,
    digestGenerationParts as digestParts,
    generationDocumentFile as generationFile,
    generationSourceParts as sourceParts,
    installGenerationWithoutPublicHosts,
    readGenerationDocument,
    selectActiveGeneration as selectActive,
    selectBinding,
    sha256,
    stableValue,
} from '../helpers/routerOriginsWorkspace.mjs';

test('public Router hosts are an immutable generation source with a bound topology projection', (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['100.73.151.25', 'pgx'] });
    const { applied } = fixture;
    const document = readGenerationDocument(fixture.edgeDir, applied.selector.generation);
    assert.equal(Buffer.from(document.sources.routerPublicHosts, 'base64').toString('utf8'), '["100.73.151.25","pgx"]');
    assert.equal(document.sourceDigests.routerPublicHosts, sha256(Buffer.from('["100.73.151.25","pgx"]')));
    assert.equal(digestParts(sourceParts(document)), applied.selector.generation, 'the host list is part of the exact identity');
    assert.equal(Object.hasOwn(document.compiled, 'routerOrigins'), false, 'compiled routing policy is unchanged');

    const active = loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).generation;
    assert.deepEqual(active.routerPublicHosts, ['100.73.151.25', 'pgx']);
    assert.deepEqual(active.routerOrigins, ['http://100.73.151.25:3000', 'http://pgx:3000']);
    const topology = readCurrentEdgeTopology({ workspaceRoot: fixture.workspace });
    assert.deepEqual(topology.routerOrigins, active.routerOrigins);
    assert.equal(topology.configurationGeneration, sha256(Buffer.from(JSON.stringify({ routerOrigins: active.routerOrigins }))));
});

test('a binding-host-only or port-only change yields a new generation and configuration hash', (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    const first = fixture.applied;
    selectBinding({ hosts: ['100.73.151.25', 'pgx'] });
    const rebound = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'rebind' });
    assert.notEqual(rebound.selector.generation, first.selector.generation);
    assert.notEqual(rebound.topology.configurationGeneration, first.topology.configurationGeneration);
    assert.deepEqual(rebound.topology.routerOrigins, ['http://100.73.151.25:3000', 'http://pgx:3000']);
    assert.deepEqual(rebound.generation.compiled, first.generation.compiled);
    assert.deepEqual(rebound.generation.routing, first.generation.routing);

    selectBinding({ hosts: ['100.73.151.25', 'pgx'], routerHostPort: 3001 });
    const moved = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'port-change' });
    assert.notEqual(moved.selector.generation, rebound.selector.generation);
    assert.deepEqual(moved.topology.routerOrigins, ['http://100.73.151.25:3001', 'http://pgx:3001']);

    selectBinding({ hosts: undefined, routerHostPort: 3001 });
    const loopback = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'loopback-only' });
    assert.deepEqual(loopback.topology.routerOrigins, [], 'an empty present list still advertises the capability');
    assert.notEqual(loopback.topology.configurationGeneration, moved.topology.configurationGeneration);
});

test('media topology fields and hashing keep their contract alongside Router origins', (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['pgx'], apply: false });
    fs.writeFileSync(path.join(fixture.edgeDir, 'desired.json'), JSON.stringify({
        hosts: {},
        media: { publicIPv4: '8.8.8.8', addressMode: 'nat-forward' },
    }));
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'media-and-origins' });
    const media = { publicIPv4: '8.8.8.8', addressMode: 'nat-forward', udpPort: 17891 };
    assert.deepEqual(applied.topology.media, media);
    assert.deepEqual(applied.topology.routerOrigins, ['http://pgx:3000']);
    assert.equal(applied.topology.configurationGeneration,
        sha256(Buffer.from(JSON.stringify(stableValue({ media, routerOrigins: ['http://pgx:3000'] })))));
});

test('source tampering and impossible source shapes fail generation verification', (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    const { generation } = fixture.applied.selector;
    const file = generationFile(fixture.edgeDir, generation);
    const original = fs.readFileSync(file);
    const mutate = (change) => {
        const document = JSON.parse(original.toString('utf8'));
        change(document);
        fs.writeFileSync(file, JSON.stringify(document, null, 2));
        return document;
    };
    const load = () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace });

    mutate((document) => {
        document.sources.routerPublicHosts = Buffer.from('["attacker.example","pgx"]').toString('base64');
    });
    assert.throws(load, { code: 'EDGE_GENERATION_CORRUPT' });

    mutate((document) => {
        const bytes = Buffer.from('["attacker.example","pgx"]');
        document.sources.routerPublicHosts = bytes.toString('base64');
        document.sourceDigests.routerPublicHosts = sha256(bytes);
    });
    assert.throws(load, { code: 'EDGE_GENERATION_CORRUPT' }, 'a rewritten digest cannot match the selected identity');

    // Even a self-consistent document cannot carry a non-canonical host list.
    const nonCanonical = mutate((document) => {
        const bytes = Buffer.from('["pgx", "10.0.0.2"]');
        document.sources.routerPublicHosts = bytes.toString('base64');
        document.sourceDigests.routerPublicHosts = sha256(bytes);
        document.generation = digestParts(sourceParts(document));
    });
    fs.writeFileSync(generationFile(fixture.edgeDir, nonCanonical.generation), JSON.stringify(nonCanonical, null, 2));
    selectActive(fixture.edgeDir, nonCanonical.generation);
    assert.throws(load, { code: 'EDGE_GENERATION_CORRUPT' });

    const withoutMedia = JSON.parse(original.toString('utf8'));
    const partsWithoutMedia = sourceParts(withoutMedia).filter(([name]) => name !== 'media-host-port');
    delete withoutMedia.sources.mediaHostPort;
    delete withoutMedia.sourceDigests.mediaHostPort;
    withoutMedia.generation = digestParts(partsWithoutMedia);
    fs.writeFileSync(generationFile(fixture.edgeDir, withoutMedia.generation), JSON.stringify(withoutMedia, null, 2));
    selectActive(fixture.edgeDir, withoutMedia.generation);
    assert.throws(load, { code: 'EDGE_GENERATION_CORRUPT' });
});

test('a generation without its public Router hosts source is rejected and never completed from the environment', (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['100.73.151.25', 'pgx'] });
    const unsupported = installGenerationWithoutPublicHosts(fixture.edgeDir, fixture.applied.selector.generation);
    assert.notEqual(unsupported.generation, fixture.applied.selector.generation);
    const load = () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace });
    assert.throws(load, (error) => error?.code === 'EDGE_GENERATION_CORRUPT'
        && /missing its required routerPublicHosts source/.test(error.message));

    // No binding, including the one it was captured under, completes it.
    for (const hosts of [['100.73.151.25', 'pgx'], ['192.168.1.10'], undefined]) {
        selectBinding({ hosts });
        assert.throws(load, { code: 'EDGE_GENERATION_CORRUPT' }, JSON.stringify(hosts));
    }

    // Nor is it silently superseded: a replacement requires a readable predecessor.
    const selectorFile = path.join(fixture.edgeDir, 'active.json');
    const selectorBytes = fs.readFileSync(selectorFile, 'utf8');
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'unsupported-replacement' }),
        { code: 'EDGE_GENERATION_CORRUPT' },
    );
    assert.equal(fs.readFileSync(selectorFile, 'utf8'), selectorBytes);
    assert.equal(JSON.parse(selectorBytes).generation, unsupported.generation);
});

test('an active generation fails closed when the Box host list differs from its capture', (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    selectBinding({ hosts: ['100.73.151.25', 'pgx'] });
    assert.throws(() => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_RUNTIME_MISMATCH' });
    process.env.PLOINKY_PUBLIC_ROUTER_HOSTS = '["pgx", "100.73.151.25"]';
    assert.throws(() => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_RUNTIME_MISMATCH' });
    selectBinding({ hosts: ['pgx'] });
    assert.equal(loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).selector.generation,
        fixture.applied.selector.generation);
});

test('additive commit rejects a binding-host change after preparation without changing routing', (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    const predecessor = fixture.applied;
    const selectorBefore = fs.readFileSync(predecessor.paths.activeSelectorFile);
    const routing = structuredClone(predecessor.generation.routing);
    routing.routes.consumer.hostPort = 43112;
    let prepared;
    withEdgeGenerationApplyLock((applyLockCapability) => {
        prepared = prepareAdditiveEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            routing,
            applyLockCapability,
        });
    }, { workspaceRoot: fixture.workspace });
    assert.deepEqual(prepared.generation.routerOrigins, ['http://pgx:3000']);

    selectBinding({ hosts: ['100.73.151.25', 'pgx'] });
    assert.throws(() => withEdgeGenerationApplyLock((applyLockCapability) => commitAdditiveEdgeRoutingGeneration(
        prepared.preparationLease,
        { workspaceRoot: fixture.workspace, routing, applyLockCapability },
    ), { workspaceRoot: fixture.workspace, preparationLease: prepared.preparationLease }), (error) => (
        error.code === 'EDGE_PREPARATION_SOURCE_CHANGED' && /routerPublicHosts/.test(error.message)
    ));
    assert.deepEqual(fs.readFileSync(predecessor.paths.activeSelectorFile), selectorBefore);
});
