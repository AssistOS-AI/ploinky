import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    AGENTLIB_ERROR_CODES, AGENTLIB_STABLE_MOUNT_PATH, agentLibIdentityEquals, agentLibRuntimeEnv,
    imageSourceIdentity, validateSelectionDescriptor,
} from '../../agentlib/contract.mjs';
import { buildImageSelection, readActiveDescriptor, resolveDescriptorSource, writeActiveDescriptor } from '../../agentlib/source.mjs';
import { readImageProvenance, verifyImageAgentLibPackage } from '../../agentlib/image-bundle.mjs';
import { selectWorkspaceAgentLibSource } from '../../ploinky-box/agentlib-source.mjs';
import { OUTER_IMAGE_ID_FIXTURE, writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

const IMAGE_ID = OUTER_IMAGE_ID_FIXTURE;
const PROVENANCE = {
    repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git',
    branch: 'master',
    commit: 'a'.repeat(40),
    packageVersion: '1.2.3',
};
const BUNDLE = { supplyingImageId: IMAGE_ID, provenance: PROVENANCE };
const roots = [];

function fixture() {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-image-'));
    roots.push(root);
    return { root, sourceDir: path.join(root, 'bundle'), metadataPath: path.join(root, 'metadata.json') };
}

function metadataRecord(overrides = {}) {
    return {
        schema: 'ploinky.box.library/v1',
        library: 'achillesAgentLib',
        packageName: 'ploinky-agent-lib',
        packageVersion: '1.2.3',
        repository: PROVENANCE.repository,
        branch: 'master',
        commit: PROVENANCE.commit,
        ...overrides,
    };
}

function suppliedFixture(metadata = metadataRecord()) {
    const item = fixture();
    writeAgentLibCheckout(item.sourceDir);
    if (metadata) fs.writeFileSync(item.metadataPath, `${JSON.stringify(metadata)}\n`);
    return item;
}

test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

test('image selection does not inspect a host source path or create source state', async () => {
    const { root } = fixture();
    let probes = 0;
    const { selection, mode } = await selectWorkspaceAgentLibSource({
        workspaceRoot: root,
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
    assert.deepEqual(resolved.sourceId, imageSourceIdentity(IMAGE_ID));
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
            workspaceRoot: root,
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

test('a dirty local checkout wins over the image and no Git command modifies it', async () => {
    const { root } = fixture();
    const local = writeAgentLibCheckout(path.join(root, 'achillesAgentLib'));
    fs.writeFileSync(path.join(local, 'index.mjs'), 'export const marker = "uncommitted";\n');
    const gitCalls = [];
    const { selection, mode } = await selectWorkspaceAgentLibSource({
        workspaceRoot: root,
        loadImageBundle: async () => { throw new Error('a local checkout must win without probing the image'); },
        gitState: (dir) => { gitCalls.push(dir); return { commit: 'a'.repeat(40), branch: 'feature', dirty: true }; },
    });
    assert.equal(mode, 'local');
    assert.equal(selection.dirty, true);
    assert.match(selection.contentFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(path.join(local, 'index.mjs'), 'utf8'), 'export const marker = "uncommitted";\n');
    assert.equal(gitCalls.length, 1, 'only the read-only state probe runs');
});

test('an absent local source fails without an image even when an earlier selection exists', async () => {
    const { root } = fixture();
    const previous = buildImageSelection({ workspaceRoot: root, supplyingImageId: IMAGE_ID });
    writeActiveDescriptor(root, previous);
    await assert.rejects(selectWorkspaceAgentLibSource({ workspaceRoot: root, readOnly: true }),
        { code: AGENTLIB_ERROR_CODES.imageRequired });
    assert.equal(readActiveDescriptor(root).mode, 'image');
});

test('images built from any revision select without a revision comparison or warning', async () => {
    const { root } = fixture();
    const seen = [];
    for (const commit of ['214ba4c3d64fd857361bf8ab56a5640c5efb30e0', 'e'.repeat(40), null]) {
        const { selection, mode } = await selectWorkspaceAgentLibSource({
            workspaceRoot: root,
            loadImageBundle: async () => ({
                supplyingImageId: IMAGE_ID,
                provenance: { ...PROVENANCE, commit },
            }),
        });
        assert.equal(mode, 'image');
        seen.push(selection);
    }
    assert.equal(seen.every((selection) => agentLibIdentityEquals(seen[0], selection)), true,
        'the commit is informational; the supplying image is the identity');
    assert.equal(seen[0].provenance.commit, '214ba4c3d64fd857361bf8ab56a5640c5efb30e0');
    assert.equal(seen[2].provenance.commit, null);
});

test('image descriptor round-trips and image identity is stable across workspaces', () => {
    const first = fixture();
    const second = fixture();
    const selection = buildImageSelection({ workspaceRoot: first.root, supplyingImageId: IMAGE_ID, provenance: PROVENANCE });
    const another = buildImageSelection({ workspaceRoot: second.root, supplyingImageId: IMAGE_ID });
    assert.deepEqual(selection.sourceId, another.sourceId);
    assert.equal(agentLibRuntimeEnv(selection, selection.sourceDir).PLOINKY_AGENTLIB_SOURCE_ID,
        agentLibRuntimeEnv(another, another.sourceDir).PLOINKY_AGENTLIB_SOURCE_ID);
    writeActiveDescriptor(first.root, selection);
    assert.deepEqual(readActiveDescriptor(first.root), validateSelectionDescriptor(selection));
    assert.throws(() => resolveDescriptorSource(selection, second.root), { code: AGENTLIB_ERROR_CODES.descriptorInvalid });
});

test('the supplied package is checked without hashing, Git or a revision comparison', () => {
    const item = suppliedFixture();
    const read = [];
    const fsApi = { ...fs, readFileSync: (file, ...rest) => { read.push(path.relative(item.root, String(file))); return fs.readFileSync(file, ...rest); } };
    const result = verifyImageAgentLibPackage({ ...item, fsApi, requireImmutable: false });
    assert.equal(result.packageName, 'ploinky-agent-lib');
    assert.equal(result.packageVersion, '0.0.0');
    assert.deepEqual(result.provenance, PROVENANCE);
    assert.equal(fs.existsSync(path.join(item.sourceDir, '.git')), false);
    assert.deepEqual(read.sort(), ['bundle/package.json', 'metadata.json'],
        'only package metadata is read: no library file body is read for a digest');
});

test('changed library bytes are not rejected by any content digest, only structure is checked', () => {
    const item = suppliedFixture();
    fs.appendFileSync(path.join(item.sourceDir, 'LLMAgents/index.mjs'), '// functional, same-shape edit\n');
    assert.equal(verifyImageAgentLibPackage({ ...item, requireImmutable: false }).packageName, 'ploinky-agent-lib');
});

test('provenance is optional diagnostics: absent, old-format or malformed records read as unavailable', () => {
    const unavailable = { repository: null, branch: null, commit: null, packageVersion: null };
    for (const metadata of [
        null,
        { schemaVersion: 1, commit: 'a'.repeat(40), fingerprint: 'c'.repeat(64) },
        metadataRecord({ schema: 'ploinky.box.library/v0' }),
        metadataRecord({ library: 'mcp-sdk' }),
    ]) {
        const item = suppliedFixture(metadata);
        assert.deepEqual(readImageProvenance(item), unavailable);
        assert.deepEqual(verifyImageAgentLibPackage({ ...item, requireImmutable: false }).provenance, unavailable);
    }
    const item = suppliedFixture(metadataRecord({ commit: 'not-a-commit', branch: '' }));
    assert.deepEqual(readImageProvenance(item), { ...PROVENANCE, commit: null, branch: null });
    fs.writeFileSync(item.metadataPath, '{ not json');
    assert.deepEqual(readImageProvenance(item), unavailable);
    fs.rmSync(item.metadataPath);
    fs.symlinkSync(path.join(item.root, 'missing'), item.metadataPath);
    assert.deepEqual(readImageProvenance(item), unavailable);
});

test('an unusable package is rejected: missing entry points, wrong package, symlink escape, writable files', () => {
    const missingResponder = suppliedFixture();
    fs.unlinkSync(path.join(missingResponder.sourceDir, 'LLMAgents/openAiAgenticResponder.mjs'));
    assert.throws(() => verifyImageAgentLibPackage({ ...missingResponder, requireImmutable: false }),
        { code: AGENTLIB_ERROR_CODES.imageInvalid, message: /openAiAgenticResponder\.mjs/ });

    const missingJwt = suppliedFixture();
    fs.unlinkSync(path.join(missingJwt.sourceDir, 'jwt/jwtVerify.mjs'));
    assert.throws(() => verifyImageAgentLibPackage({ ...missingJwt, requireImmutable: false }),
        { code: AGENTLIB_ERROR_CODES.imageInvalid });

    const wrongPackage = suppliedFixture();
    const packagePath = path.join(wrongPackage.sourceDir, 'package.json');
    fs.writeFileSync(packagePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(packagePath)), name: 'other' }));
    assert.throws(() => verifyImageAgentLibPackage({ ...wrongPackage, requireImmutable: false }),
        { code: AGENTLIB_ERROR_CODES.imageInvalid });

    const escaping = suppliedFixture();
    fs.symlinkSync(os.tmpdir(), path.join(escaping.sourceDir, 'escape'));
    assert.throws(() => verifyImageAgentLibPackage({ ...escaping, requireImmutable: false }),
        { code: AGENTLIB_ERROR_CODES.imageInvalid });

    const writable = suppliedFixture();
    fs.chmodSync(path.join(writable.sourceDir, 'index.mjs'), 0o666);
    assert.throws(() => verifyImageAgentLibPackage(writable), { code: AGENTLIB_ERROR_CODES.imageInvalid },
        'the protected-ownership check still applies to the supplied copy');

    assert.throws(() => verifyImageAgentLibPackage({ ...fixture(), requireImmutable: false }),
        { code: AGENTLIB_ERROR_CODES.imageInvalid }, 'a missing package is an error');
});
