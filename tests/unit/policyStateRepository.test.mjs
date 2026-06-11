import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-repo-'));
const originalCwd = process.cwd();
process.chdir(tempDir);

const { PolicyStateRepository } = await import(`../../cli/server/policy/PolicyStateRepository.js?t=${Date.now()}`);
const file = path.join(tempDir, '.ploinky', 'data', 'router-security', 'policy-state.json');

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeState(mcpTools = [], httpRoutes = []) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 'router-policy', httpRoutes, mcpTools }, null, 2));
}

function mcp(agent, tool, access, extra = {}) {
    return { agent, tool, access, source: 'admin', enabled: true, createdAt: 't', createdBy: 't', updatedAt: 't', updatedBy: 't', ...extra };
}

test('missing file is a valid empty state, not corrupt', () => {
    const repo = new PolicyStateRepository();
    assert.equal(repo.isCorrupt(), false);
    assert.equal(repo.getMcpToolEntry('a', 'b'), null);
    assert.deepEqual(repo.listHttpRoutes(), { corrupt: false, entries: [] });
});

test('reads entries and indexes by agent+tool and by path', () => {
    writeState([mcp('explorer', 'docs', 'authenticated')], [{ path: '/x/*', access: 'public', enabled: true }]);
    const repo = new PolicyStateRepository();
    assert.equal(repo.getMcpToolEntry('explorer', 'docs').access, 'authenticated');
    assert.equal(repo.getHttpRouteEntry('/x/*').enabled, true);
});

test('httpRoutes entries without access mark the whole document corrupt (no legacy public default)', () => {
    writeState([mcp('explorer', 'docs', 'authenticated')], [{ path: '/x/*', enabled: true }]);
    const repo = new PolicyStateRepository();
    assert.equal(repo.isCorrupt(), true);
    assert.deepEqual(repo.listHttpRoutes(), { corrupt: true, entries: [] });
    // The corrupt document also blocks MCP reads and mutations; operators
    // must delete policy-state.json (documented remediation), not patch it.
    assert.deepEqual(repo.getMcpToolEntry('explorer', 'docs'), { corrupt: true });
    assert.throws(() => repo.mutate((state) => state), /POLICY_PERSISTENCE_ERROR|refusing to overwrite/);
});

test('corrupt file fails closed: isCorrupt true, accessors signal corrupt, mutate refuses & keeps file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const repo = new PolicyStateRepository();
    assert.equal(repo.isCorrupt(), true);
    assert.equal(repo.getMcpToolEntry('a', 'b').corrupt, true);
    assert.equal(repo.listMcpTools().corrupt, true);
    assert.throws(() => repo.mutate((s) => s), /corrupt/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('mutate writes atomically and re-reads the new state', () => {
    writeState([], []);
    const repo = new PolicyStateRepository();
    repo.mutate((state) => { state.mcpTools.push(mcp('a', 'b', 'internal')); return state; });
    assert.equal(repo.getMcpToolEntry('a', 'b').access, 'internal');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.schema, 'router-policy');
    assert.equal(onDisk.mcpTools.length, 1);
});

test('mutate throws a POLICY_PERSISTENCE_ERROR-coded error when corrupt', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'still not json');
    const repo = new PolicyStateRepository();
    try {
        repo.mutate((s) => s);
        assert.fail('expected mutate to throw');
    } catch (err) {
        assert.equal(err.code, 'POLICY_PERSISTENCE_ERROR');
    }
});
