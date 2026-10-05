// `ploinky status` reports the selected achillesAgentLib source by its
// mode-aware identity: a local checkout by content fingerprint and drift, the
// image-supplied copy by the outer Box image that carries it plus optional
// informational provenance.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildImageSelection, buildSelection, writeActiveDescriptor } from '../../agentlib/source.mjs';
import { OUTER_IMAGE_ID_FIXTURE, writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';
import { installFakeEngine } from './dependencyStoreFakeEngine.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const PROVENANCE = {
    repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git', branch: 'master', commit: 'a'.repeat(40), packageVersion: '1.2.3',
};

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agentlib-status-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
    return root;
}

function checkout(root) {
    const sourceDir = path.join(root, 'achillesAgentLib');
    fs.mkdirSync(sourceDir);
    writeAgentLibCheckout(sourceDir);
    return sourceDir;
}

function statusOutput(root) {
    const result = spawnSync(process.execPath, [
        '--input-type=module', '-e',
        "const m = await import(process.argv[1]); m.printAgentLibStatus({});",
        path.join(repoRoot, 'cli/utils/status.js'),
    ], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root, NO_COLOR: '1', FORCE_COLOR: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

test('a local source is reported by its content fingerprint and drift is a restart requirement', (t) => {
    const root = workspace(t);
    const sourceDir = checkout(root);
    const selection = buildSelection({ workspaceRoot: root, sourceDir, resolvedCommit: 'b'.repeat(40) });
    writeActiveDescriptor(root, selection);
    const clean = statusOutput(root);
    assert.match(clean, /AgentLib source: local achillesAgentLib/);
    assert.ok(clean.includes(`AgentLib active:   ${selection.contentFingerprint.slice(0, 12)}`));
    assert.doesNotMatch(clean, /restart required|Box image|undefined/);

    fs.appendFileSync(path.join(sourceDir, 'index.mjs'), '// uncommitted edit\n');
    const drifted = statusOutput(root);
    assert.match(drifted, /restart required/);
    assert.doesNotMatch(drifted, /undefined/);
});

test('an image source is reported by the supplying Box image with its optional provenance, without any fingerprint', (t) => {
    const root = workspace(t);
    writeActiveDescriptor(root, buildImageSelection({
        workspaceRoot: root, supplyingImageId: OUTER_IMAGE_ID_FIXTURE, provenance: PROVENANCE,
    }));
    const output = statusOutput(root);
    assert.match(output, /AgentLib source: image image/);
    assert.ok(output.includes(`AgentLib active:   Box image ${OUTER_IMAGE_ID_FIXTURE.slice(0, 19)}`));
    assert.match(output, /AgentLib package:  version 1\.2\.3, commit aaaaaaaaaaaa, branch master/);
    assert.match(output, /AgentLib identity: [0-9a-f]{12}  source image/);
    assert.doesNotMatch(output, /undefined|content:/);
});

test('an image source without recorded provenance reports it as unavailable', (t) => {
    const root = workspace(t);
    writeActiveDescriptor(root, buildImageSelection({ workspaceRoot: root, supplyingImageId: OUTER_IMAGE_ID_FIXTURE }));
    const output = statusOutput(root);
    assert.match(output, /AgentLib package:  provenance unavailable/);
    assert.doesNotMatch(output, /undefined/);
});

test('an active image selection with a local checkout now present is a restart requirement', (t) => {
    const root = workspace(t);
    writeActiveDescriptor(root, buildImageSelection({ workspaceRoot: root, supplyingImageId: OUTER_IMAGE_ID_FIXTURE }));
    checkout(root);
    const output = statusOutput(root);
    assert.match(output, /AgentLib source: local achillesAgentLib/);
    assert.match(output, /restart required/);
});

test('an unsupported active descriptor is reported with its file, never converted or deleted', (t) => {
    const root = workspace(t);
    const descriptor = path.join(root, '.ploinky', 'agentlib', 'active.json');
    fs.mkdirSync(path.dirname(descriptor), { recursive: true });
    const previousShape = JSON.stringify({
        schemaVersion: 1, workspacePathHash: 'h', mode: 'managed', sourceRelativePath: '.ploinky/agentlib/generations/x',
        sourceId: { device: '1', inode: '2' }, contentFingerprint: 'a'.repeat(64), selectedAt: '2026-01-01T00:00:00.000Z',
        remoteUrl: 'https://example.invalid/lib.git',
    });
    fs.writeFileSync(descriptor, previousShape);
    const output = statusOutput(root);
    assert.ok(output.includes(descriptor), 'the detail names the unsupported file');
    assert.equal(fs.readFileSync(descriptor, 'utf8'), previousShape);
});

test('native status reaches that report through its read-only bootstrap; other native commands refuse by file', async (t) => {
    const root = workspace(t);
    checkout(root);
    const descriptor = path.join(root, '.ploinky', 'agentlib', 'active.json');
    fs.mkdirSync(path.dirname(descriptor), { recursive: true });
    const previousShape = JSON.stringify({
        schemaVersion: 1, workspacePathHash: 'h', mode: 'image', sourceRelativePath: 'image',
        sourceId: { device: `image:sha256:${'c'.repeat(64)}`, inode: 'a'.repeat(64) }, contentFingerprint: 'a'.repeat(64),
        imageId: `sha256:${'c'.repeat(64)}`, resolvedCommit: 'b'.repeat(40), selectedAt: '2026-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(descriptor, previousShape);
    fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), '{"port":8080}\n');

    // A test-owned engine answers the status command's engine probes (a real engine is never asked).
    const engine = installFakeEngine(root, { engines: ['podman'] });
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'cli/index.js'), 'status'], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, ...engine.env, PLOINKY_WORKSPACE_ROOT: root, NO_COLOR: '1', FORCE_COLOR: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(descriptor), 'status names the unsupported file');
    assert.match(result.stdout, /not converted: remove this file and run the command again/);
    assert.equal(fs.readFileSync(descriptor, 'utf8'), previousShape);

    const { bootstrapAgentLibRuntime, resetAgentLibBootstrap } = await import('../../agentlib/bootstrap.mjs');
    t.after(() => resetAgentLibBootstrap());
    const readOnly = await bootstrapAgentLibRuntime({
        env: { PLOINKY_WORKSPACE_ROOT: root }, insideBox: false, readOnly: true, cwd: root, force: true,
    });
    assert.equal(readOnly.mode, 'local');
    await assert.rejects(bootstrapAgentLibRuntime({
        env: { PLOINKY_WORKSPACE_ROOT: root }, insideBox: false, cwd: root, force: true,
    }), (error) => error.code === 'PLOINKY_AGENTLIB_DESCRIPTOR_INVALID' && error.message.includes(descriptor));
    assert.equal(fs.readFileSync(descriptor, 'utf8'), previousShape);
});
