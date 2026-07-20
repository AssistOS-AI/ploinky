import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-repo-'));
const originalCwd = process.cwd();
process.chdir(tempDir);

const { PolicyStateRepository } = await import(`../../cli/server/policy/PolicyStateRepository.js?t=${Date.now()}`);
const { FileSystemPolicyStateStore } = await import(`../../cli/server/policy/FileSystemPolicyStateStore.js?t=${Date.now()}`);
const {
    initializeFreshEdgeRoutingSources,
    loadActiveEdgeRoutingGeneration,
} = await import(`../../cli/sandbox/edgeGeneration.js?t=${Date.now()}`);
const file = path.join(tempDir, '.ploinky', 'data', 'router-security', 'policy-state.json');
const edgeGenerationModuleUrl = new URL('../../cli/sandbox/edgeGeneration.js', import.meta.url).href;
const maintenanceLocksModuleUrl = new URL('../../cli/utils/runtime/maintenanceLocks.js', import.meta.url).href;

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
    const repo = new PolicyStateRepository({
        store: new FileSystemPolicyStateStore({ file: () => file, coordinate: false }),
    });
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

test('coordinated policy write excludes a competing apply until candidate replacement and activation', () => {
    fs.rmSync(path.join(tempDir, '.ploinky'), { recursive: true, force: true });
    const { paths } = initializeFreshEdgeRoutingSources({ workspaceRoot: tempDir });
    const originalPolicy = fs.readFileSync(paths.policyFile, 'utf8');
    const nextPolicy = {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [mcp('explorer', 'docs', 'authenticated')],
    };
    let competingApply = null;
    let candidateRenameCount = 0;
    const store = new FileSystemPolicyStateStore({
        testHooks: {
            beforeCandidateReplace({ file: candidateFile }) {
                assert.equal(fs.realpathSync(candidateFile), fs.realpathSync(paths.policyFile));
                candidateRenameCount += 1;
                const selector = JSON.parse(fs.readFileSync(paths.activeSelectorFile, 'utf8'));
                assert.equal(selector.state, 'inactive');
                assert.equal(fs.readFileSync(paths.policyFile, 'utf8'), originalPolicy);
                const script = `
                    const { applyEdgeRoutingGeneration } = await import(${JSON.stringify(edgeGenerationModuleUrl)});
                    const { createWorkspaceMutationLease } = await import(${JSON.stringify(maintenanceLocksModuleUrl)});
                    let workspaceLease;
                    try {
                        createWorkspaceMutationLease({ operation: 'competing-policy-probe' });
                        workspaceLease = { outcome: 'acquired' };
                    } catch (error) {
                        workspaceLease = { outcome: 'rejected', code: error.code, message: error.message };
                    }
                    try {
                        const result = applyEdgeRoutingGeneration({ workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT });
                        process.stdout.write(JSON.stringify({ workspaceLease, apply: { outcome: 'activated', generation: result.selector.generation } }));
                    } catch (error) {
                        process.stdout.write(JSON.stringify({ workspaceLease, apply: { outcome: 'rejected', code: error.code, message: error.message } }));
                    }
                `;
                competingApply = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
                    cwd: tempDir,
                    env: { ...process.env, PLOINKY_WORKSPACE_ROOT: tempDir },
                    encoding: 'utf8',
                }));
            },
        },
    });

    store.write(nextPolicy);

    assert.equal(candidateRenameCount, 1);
    assert.equal(competingApply.workspaceLease.outcome, 'rejected');
    assert.equal(competingApply.workspaceLease.code, 'PLOINKY_WORKSPACE_MUTATION_BUSY');
    assert.match(competingApply.workspaceLease.message, /policy-write.*already active/);
    assert.deepEqual(competingApply.apply, {
        outcome: 'rejected',
        code: 'EDGE_GENERATION_BUSY',
        message: 'edge generation apply is already in progress',
    });
    const active = loadActiveEdgeRoutingGeneration({ workspaceRoot: tempDir });
    assert.equal(active.selector.state, 'active');
    assert.equal(active.generation.policy.mcpTools[0].agent, 'explorer');
    assert.equal(active.generation.policy.mcpTools[0].tool, 'docs');
    assert.equal(active.generation.policy.mcpTools[0].access, 'authenticated');
});
