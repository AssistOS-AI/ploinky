import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const suffix = `?t=${Date.now()}`;
const { FileSystemPolicyStateStore } = await import(`../../cli/server/policy/FileSystemPolicyStateStore.js${suffix}`);
const { InMemoryPolicyStateStore } = await import(`../../cli/server/policy/InMemoryPolicyStateStore.js${suffix}`);
const { PolicyStateRepository } = await import(`../../cli/server/policy/PolicyStateRepository.js${suffix}`);

function doc(mcpTools = [], httpRoutes = []) {
    return { schema: 'router-policy', httpRoutes, mcpTools };
}

function mcp(agent, tool, access) {
    return { agent, tool, access, source: 'admin', enabled: true, createdAt: 't', createdBy: 't', updatedAt: 't', updatedBy: 't' };
}

// ---- FileSystemPolicyStateStore ----------------------------------------------

test('fs store: null version when absent, then round-trips a document', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-store-'));
    try {
        const file = path.join(tempDir, 'policy-state.json');
        const store = new FileSystemPolicyStateStore({ file: () => file });
        assert.equal(store.currentVersion(), null);

        const v1 = store.write(doc([mcp('a', 'b', 'internal')]));
        assert.equal(typeof v1, 'string');
        assert.notEqual(v1, null);
        assert.equal(store.currentVersion(), v1);

        const { found, document } = store.read();
        assert.equal(found, true);
        assert.equal(document.mcpTools[0].access, 'internal');
        // The on-disk write is the canonical JSON document.
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schema, 'router-policy');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('fs store: read() throws on an undecodable payload (so the repository fails closed)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-store-'));
    try {
        const file = path.join(tempDir, 'policy-state.json');
        fs.writeFileSync(file, '{ not json');
        const store = new FileSystemPolicyStateStore({ file: () => file });
        assert.notEqual(store.currentVersion(), null); // file exists → has a version
        assert.throws(() => store.read());
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// ---- InMemoryPolicyStateStore ------------------------------------------------

test('in-memory store: round-trips and returns isolated clones', () => {
    const store = new InMemoryPolicyStateStore();
    assert.equal(store.currentVersion(), null);
    assert.deepEqual(store.read(), { found: false });

    store.write(doc([mcp('a', 'b', 'authenticated')]));
    assert.notEqual(store.currentVersion(), null);

    const first = store.read();
    first.document.mcpTools[0].access = 'admin'; // mutate the returned clone
    const second = store.read();
    assert.equal(second.document.mcpTools[0].access, 'authenticated'); // store is unaffected
});

// ---- Seam proof: the repository contract holds over a non-filesystem store ----

test('repository over in-memory store: empty store is a valid empty state', () => {
    const repo = new PolicyStateRepository({ store: new InMemoryPolicyStateStore() });
    assert.equal(repo.isCorrupt(), false);
    assert.equal(repo.getMcpToolEntry('a', 'b'), null);
    assert.deepEqual(repo.listHttpRoutes(), { corrupt: false, entries: [] });
});

test('repository over in-memory store: loads, indexes, and mutates with no filesystem', () => {
    const store = new InMemoryPolicyStateStore({ document: doc([mcp('explorer', 'docs', 'authenticated')], [{ path: '/x/*', enabled: true }]) });
    const repo = new PolicyStateRepository({ store });
    assert.equal(repo.getMcpToolEntry('explorer', 'docs').access, 'authenticated');
    assert.equal(repo.getHttpRouteEntry('/x/*').enabled, true);

    repo.mutate((state) => { state.mcpTools.push(mcp('a', 'b', 'internal')); return state; });
    assert.equal(repo.getMcpToolEntry('a', 'b').access, 'internal');
    // The mutation is observable through a fresh repository over the same store.
    assert.equal(new PolicyStateRepository({ store }).getMcpToolEntry('a', 'b').access, 'internal');
});

test('repository over in-memory store: schema-invalid document fails closed', () => {
    const store = new InMemoryPolicyStateStore({ document: { schema: 'router-policy', httpRoutes: 'oops', mcpTools: [] } });
    const repo = new PolicyStateRepository({ store });
    assert.equal(repo.isCorrupt(), true);
    assert.equal(repo.getMcpToolEntry('a', 'b').corrupt, true);
    assert.equal(repo.listMcpTools().corrupt, true);
    assert.throws(() => repo.mutate((s) => s), /corrupt/);
});

test('repository over in-memory store: mutate throws POLICY_PERSISTENCE_ERROR when corrupt', () => {
    const store = new InMemoryPolicyStateStore({ document: { schema: 'router-policy', mcpTools: [{ agent: 'a', tool: 'b', access: 'nope' }], httpRoutes: [] } });
    const repo = new PolicyStateRepository({ store });
    try {
        repo.mutate((s) => s);
        assert.fail('expected mutate to throw');
    } catch (err) {
        assert.equal(err.code, 'POLICY_PERSISTENCE_ERROR');
    }
});
