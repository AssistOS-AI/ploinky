import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    AGENTLIB_ERROR_CODES, AGENTLIB_STABLE_MOUNT_PATH, agentLibRuntimeEnv,
    imageSourceId, validateSelectionDescriptor,
} from '../../agentlib/contract.mjs';
import { buildImageSelection, readActiveDescriptor, resolveDescriptorSource, writeActiveDescriptor } from '../../agentlib/source.mjs';
import { prepareImageBundle, verifyImageBundle } from '../../agentlib/image-bundle.mjs';
import { selectWorkspaceAgentLibSource } from '../../ploinky-box/agentlib-source.mjs';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

const COMMIT = 'a'.repeat(40);
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const BUNDLE = { commit: COMMIT, fingerprint: 'c'.repeat(64), imageId: IMAGE_ID };
const roots = [];

function fixture() {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-image-'));
    roots.push(root);
    return { root, sourceDir: path.join(root, 'bundle'), metadataPath: path.join(root, 'metadata.json') };
}

function preparedFixture({ status = '', actualCommit = COMMIT } = {}) {
    const item = fixture();
    writeAgentLibCheckout(item.sourceDir);
    const spawn = (_command, args) => ({ status: 0, stdout: args.includes('rev-parse') ? actualCommit : status });
    const metadata = prepareImageBundle({ ...item, commit: COMMIT, spawn });
    return { ...item, metadata };
}

test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

test('image selection does not inspect a host source path or create managed source state', async () => {
    const { root } = fixture();
    let probes = 0;
    const { selection, mode } = await selectWorkspaceAgentLibSource({
        workspaceRoot: root, expectedCommit: COMMIT,
        loadImageBundle: async () => { probes += 1; return BUNDLE; },
        runner: { run() { throw new Error('host Git is forbidden'); } },
    });
    assert.equal(probes, 1);
    assert.equal(mode, 'image');
    assert.equal(selection.sourceDir, AGENTLIB_STABLE_MOUNT_PATH);
    assert.equal(selection.sourceRelativePath, 'image');
    assert.deepEqual(fs.readdirSync(root), []);
    const resolved = resolveDescriptorSource(selection, root);
    assert.equal(resolved.sourceDir, AGENTLIB_STABLE_MOUNT_PATH);
    assert.deepEqual(resolved.sourceId, imageSourceId(IMAGE_ID, BUNDLE.fingerprint));
});

test('valid and invalid local candidates both prevent an image probe', async () => {
    for (const valid of [true, false]) {
        const { root } = fixture();
        const local = writeAgentLibCheckout(path.join(root, 'achillesAgentLib'));
        if (!valid) fs.unlinkSync(path.join(local, 'jwt/jwtSign.mjs'));
        const select = () => selectWorkspaceAgentLibSource({
            workspaceRoot: root,
            loadImageBundle: async () => { throw new Error('local source must prevent image probing'); },
            gitState: () => ({ commit: null, branch: null, dirty: false }),
        });
        if (valid) assert.equal((await select()).mode, 'local');
        else await assert.rejects(select(), { code: AGENTLIB_ERROR_CODES.sourceInvalid });
    }
});

test('a local candidate appearing during the image probe wins or fails closed', async () => {
    for (const valid of [true, false]) {
        const { root } = fixture();
        const select = () => selectWorkspaceAgentLibSource({
            workspaceRoot: root, expectedCommit: COMMIT,
            loadImageBundle: async () => {
                const checkout = writeAgentLibCheckout(path.join(root, 'achillesAgentLib'));
                if (!valid) fs.unlinkSync(path.join(checkout, 'jwt/jwtSign.mjs'));
                return BUNDLE;
            },
            gitState: () => ({ commit: null, branch: null, dirty: false }),
        });
        if (valid) assert.equal((await select()).mode, 'local');
        else await assert.rejects(select(), { code: AGENTLIB_ERROR_CODES.sourceInvalid });
    }
});

test('absent local source fails without a verified image even when a legacy descriptor exists', async () => {
    const { root } = fixture();
    const generation = path.join(root, '.ploinky/agentlib/generations/old');
    writeAgentLibCheckout(generation);
    const { buildSelection } = await import('../../agentlib/source.mjs');
    const previous = buildSelection({ workspaceRoot: root, sourceDir: generation, mode: 'managed',
        remoteUrl: 'https://example.invalid/agentlib', resolvedCommit: COMMIT });
    writeActiveDescriptor(root, previous);
    await assert.rejects(selectWorkspaceAgentLibSource({ workspaceRoot: root, readOnly: true }),
        { code: AGENTLIB_ERROR_CODES.imageRequired });
    assert.equal(readActiveDescriptor(root).mode, 'managed');
});

test('image pin mismatch fails clearly and never clones', async () => {
    const { root } = fixture();
    await assert.rejects(selectWorkspaceAgentLibSource({
        workspaceRoot: root, imageBundle: BUNDLE, expectedCommit: 'd'.repeat(40),
        runner: { run() { throw new Error('host Git is forbidden'); } },
    }), (error) => error.code === AGENTLIB_ERROR_CODES.imagePinMismatch && /Rebuild/.test(error.message));
});

test('image descriptor round-trips and image identity is stable across workspaces', () => {
    const first = fixture();
    const second = fixture();
    const selection = buildImageSelection({ workspaceRoot: first.root, imageBundle: BUNDLE });
    const another = buildImageSelection({ workspaceRoot: second.root, imageBundle: BUNDLE });
    assert.deepEqual(selection.sourceId, another.sourceId);
    assert.equal(agentLibRuntimeEnv(selection, selection.sourceDir).PLOINKY_AGENTLIB_SOURCE_ID,
        agentLibRuntimeEnv(another, another.sourceDir).PLOINKY_AGENTLIB_SOURCE_ID);
    writeActiveDescriptor(first.root, selection);
    assert.deepEqual(readActiveDescriptor(first.root), validateSelectionDescriptor(selection));
    assert.throws(() => resolveDescriptorSource(selection, second.root), { code: AGENTLIB_ERROR_CODES.descriptorInvalid });
    for (const overrides of [{ sourceRelativePath: 'achillesAgentLib' }, { sourceId: { device: '1', inode: '2' } },
        { imageId: 'latest' }, { dirty: true }, { resolvedCommit: null }, { remoteUrl: 'https://example.invalid' }]) {
        assert.throws(() => validateSelectionDescriptor({ ...selection, ...overrides }));
    }
});

test('bundle metadata verifies copied bytes without requiring Git metadata', () => {
    const item = preparedFixture();
    assert.deepEqual(verifyImageBundle({ ...item, expectedCommit: COMMIT, requireImmutable: false }), item.metadata);
    assert.equal(fs.existsSync(path.join(item.sourceDir, '.git')), false);
    assert.throws(() => verifyImageBundle({ ...item, expectedCommit: 'e'.repeat(40), requireImmutable: false }),
        { code: AGENTLIB_ERROR_CODES.imagePinMismatch });
    fs.appendFileSync(path.join(item.sourceDir, 'LLMAgents/index.mjs'), '// changed\n');
    assert.throws(() => verifyImageBundle({ ...item, requireImmutable: false }), { code: AGENTLIB_ERROR_CODES.imageInvalid });
});

test('bundle verification rejects missing metadata, symlinked metadata, invalid source and writable ownership', () => {
    const item = preparedFixture();
    fs.chmodSync(path.join(item.sourceDir, 'index.mjs'), 0o666);
    assert.throws(() => verifyImageBundle(item), { code: AGENTLIB_ERROR_CODES.imageInvalid });
    fs.chmodSync(path.join(item.sourceDir, 'index.mjs'), 0o644);
    fs.renameSync(item.metadataPath, `${item.metadataPath}.real`);
    assert.throws(() => verifyImageBundle({ ...item, requireImmutable: false }), { code: AGENTLIB_ERROR_CODES.imageInvalid });
    fs.symlinkSync(`${item.metadataPath}.real`, item.metadataPath);
    assert.throws(() => verifyImageBundle({ ...item, requireImmutable: false }), { code: AGENTLIB_ERROR_CODES.imageInvalid });
    fs.unlinkSync(item.metadataPath);
    fs.renameSync(`${item.metadataPath}.real`, item.metadataPath);
    fs.unlinkSync(path.join(item.sourceDir, 'jwt/jwtVerify.mjs'));
    assert.throws(() => verifyImageBundle({ ...item, requireImmutable: false }), { code: AGENTLIB_ERROR_CODES.sourceInvalid });
});

test('bundle preparation rejects wrong revision, dirty or ignored bytes, dependencies and recursive metadata', () => {
    assert.throws(() => preparedFixture({ actualCommit: 'e'.repeat(40) }), { code: AGENTLIB_ERROR_CODES.imageInvalid });
    for (const status of [' M index.mjs', '!! node_modules/']) {
        assert.throws(() => preparedFixture({ status }), { code: AGENTLIB_ERROR_CODES.imageInvalid });
    }
    const item = fixture();
    writeAgentLibCheckout(item.sourceDir);
    const packagePath = path.join(item.sourceDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath));
    fs.writeFileSync(packagePath, JSON.stringify({ ...pkg, dependencies: { missing: '1.0.0' } }));
    assert.throws(() => prepareImageBundle({ ...item, commit: COMMIT }), { code: AGENTLIB_ERROR_CODES.imageInvalid });
    assert.throws(() => prepareImageBundle({ ...item, commit: COMMIT,
        metadataPath: path.join(item.sourceDir, 'metadata.json') }), { code: AGENTLIB_ERROR_CODES.imageInvalid });
});

test('bundle CLI reports invalid arguments and missing metadata through stderr and nonzero exit', () => {
    const script = new URL('../../agentlib/image-bundle.mjs', import.meta.url);
    const item = fixture();
    for (const args of [[], ['verify', '--bad', 'value'], ['verify', '--metadata', item.metadataPath]]) {
        const result = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.ok(result.stderr.trim());
    }
});
