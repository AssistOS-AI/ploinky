import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createWorkspaceCheckout,
    installFsCallCounter,
    installGitSpawnCounter,
} from './agentLookupCostProbe.mjs';

// Agent lookups keep no cross-request state: a principal that cannot name an
// agent costs nothing, and a manifest edit is visible on the very next call.

const originalCwd = process.cwd();
const originalWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-nomemo-'));
fs.mkdirSync(path.join(workspace, '.ploinky', 'repos', 'basic', 'keycloak'), { recursive: true });
fs.writeFileSync(path.join(workspace, '.ploinky', 'repos', 'basic', 'keycloak', 'manifest.json'),
    JSON.stringify({ ssoProvider: true }));
// The checkout supplies the registered AchillesIDE repository under another
// folder name, as in a deployed workspace.
const checkout = path.join(workspace, 'AssistOSExplorer');
createWorkspaceCheckout(checkout);
fs.mkdirSync(path.join(checkout, 'explorer'), { recursive: true });
fs.writeFileSync(path.join(checkout, 'explorer', 'manifest.json'), JSON.stringify({ about: 'explorer' }));
// Written before any lookup runs, so the first lookups below see it.
const userPersistoManifest = path.join(checkout, 'userPersistoAgent', 'manifest.json');
fs.mkdirSync(path.dirname(userPersistoManifest), { recursive: true });
fs.writeFileSync(userPersistoManifest, '{"ssoProvider":false,"runtime":{"resources":{"env":{"MARK":"aaaa"}}}}');
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.chdir(workspace);

const gitSpawns = installGitSpawnCounter(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-nomemo-git-')));
const fsCounter = installFsCallCounter();
const { getAgentDescriptorByPrincipal, resolveAgentDescriptor } = await import('../../cli/utils/agentRegistry.js');

test.after(() => {
    gitSpawns.restore();
    process.chdir(originalCwd);
    if (originalWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalWorkspaceRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('T1: a principal without repo/agent form resolves to null with no fs call and no git spawn', () => {
    for (const principal of ['agent:explorer', 'agent:explorer', 'agent:', 'user:explorer', 'agent:a/b/c']) {
        const spawnsBefore = gitSpawns.count();
        const { result, error, calls } = fsCounter.measure(() => getAgentDescriptorByPrincipal(principal));
        assert.equal(error, null);
        assert.equal(result, null, principal);
        assert.deepEqual(calls, [], `${principal}: no synchronous fs call`);
        assert.equal(gitSpawns.count() - spawnsBefore, 0, `${principal}: no git spawn`);
    }
});

function rewriteInPlace(filePath, text) {
    const before = fs.statSync(filePath);
    assert.equal(Buffer.byteLength(text), before.size, 'fixture rewrite keeps the size');
    const fd = fs.openSync(filePath, 'r+');
    try {
        fs.writeSync(fd, text, 0, 'utf8');
    } finally {
        fs.closeSync(fd);
    }
    const after = fs.statSync(filePath);
    assert.equal(after.ino, before.ino, 'same inode');
    assert.equal(after.size, before.size, 'same size');
}

test('T2: an in-place manifest edit is visible on the immediately following lookup', () => {
    const manifestPath = userPersistoManifest;
    const principal = 'agent:AchillesIDE/userPersistoAgent';
    const ref = 'AchillesIDE/userPersistoAgent';

    // Warm every accessor first, so any cross-call reuse would be in place.
    assert.equal(resolveAgentDescriptor(ref)?.ssoProvider, false);
    assert.equal(getAgentDescriptorByPrincipal(principal)?.ssoProvider, false);
    assert.equal(resolveAgentDescriptor(ref)?.runtimeResources.env.MARK, 'aaaa');

    rewriteInPlace(manifestPath, '{"ssoProvider":true ,"runtime":{"resources":{"env":{"MARK":"aaaa"}}}}');
    assert.equal(resolveAgentDescriptor(ref)?.ssoProvider, true, 'edit visible to the very next ref lookup');
    assert.equal(getAgentDescriptorByPrincipal(principal)?.ssoProvider, true, 'edit visible to the very next principal lookup');

    // A same-size change of another manifest field the descriptor carries.
    rewriteInPlace(manifestPath, '{"ssoProvider":true ,"runtime":{"resources":{"env":{"MARK":"bbbb"}}}}');
    assert.equal(resolveAgentDescriptor(ref)?.runtimeResources.env.MARK, 'bbbb');
    assert.equal(getAgentDescriptorByPrincipal(principal)?.runtimeResources.env.MARK, 'bbbb');

    rewriteInPlace(manifestPath, '{"ssoProvider":false,"runtime":{"resources":{"env":{"MARK":"bbbb"}}}}');
    assert.equal(getAgentDescriptorByPrincipal(principal)?.ssoProvider, false);
    assert.equal(resolveAgentDescriptor(ref)?.ssoProvider, false);
});

test('T2: a principal lookup reads only that agent\'s manifest', () => {
    const { result, calls } = fsCounter.measure(() => getAgentDescriptorByPrincipal('agent:basic/keycloak'));
    assert.equal(result?.agentRef, 'basic/keycloak');
    assert.equal(result?.ssoProvider, true);
    // Repository configuration files are read to locate the repository; the
    // only manifest read is the requested agent's own.
    const manifestReads = calls
        .filter((call) => call.name === 'readFileSync' && path.basename(call.target) === 'manifest.json')
        .map((call) => call.target);
    assert.deepEqual(manifestReads, [path.join(workspace, '.ploinky', 'repos', 'basic', 'keycloak', 'manifest.json')]);
});

test('T7: the registry has no memo and the minter never calls findAgent', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const registry = fs.readFileSync(path.join(root, 'cli', 'utils', 'agentRegistry.js'), 'utf8');
    const minter = fs.readFileSync(path.join(root, 'cli', 'server', 'mcp-proxy', 'invocationMinter.js'), 'utf8');
    assert.doesNotMatch(registry, /AGENT_INDEX_TTL_MS|agentIndexMemo|readEdgeRoutingSelection/);
    assert.doesNotMatch(minter, /findAgent/);
});
