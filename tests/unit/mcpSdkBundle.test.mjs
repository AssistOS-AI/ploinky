import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as bundle from '../../ploinky-box/mcp-sdk-bundle.mjs';
import {
    MCP_SDK_BUNDLE_METADATA_NAME,
    MCP_SDK_LIBRARY_NAME,
    MCP_SDK_PACKAGE_NAME,
    MCP_SDK_REPOSITORY_URL,
    assertMcpSdkTree,
    mcpSdkIdentity,
    readMcpSdkPackage,
    readMcpSdkProvenance,
} from '../../ploinky-box/mcp-sdk-bundle.mjs';
import { OUTER_IMAGE_ID_FIXTURE } from '../helpers/agentlibFixture.mjs';

function fixture(t, packageOverrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mcp-sdk-package-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, 'mcp-sdk');
    fs.mkdirSync(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({
        name: MCP_SDK_PACKAGE_NAME,
        version: '1.19.1',
        type: 'module',
        exports: { '.': './index.mjs' },
        ...packageOverrides,
    }));
    fs.writeFileSync(path.join(sourceRoot, 'index.mjs'), 'export const value = 42;\n');
    return { root, sourceRoot };
}

test('the runtime module has no lock, revision, fingerprint or packaging surface left', () => {
    for (const removed of [
        'prepareMcpSdkBundle', 'validateMcpSdkBundle', 'fingerprintMcpSdkBundle',
        'createMcpSdkBundleMetadata', 'readMcpSdkRepositoryFromLock', 'MCP_SDK_BUNDLE_SCHEMA',
    ]) {
        assert.equal(bundle[removed], undefined, `${removed} must not exist: the image owns packaging`);
    }
    assert.equal(MCP_SDK_LIBRARY_NAME, 'mcp-sdk');
    assert.equal(MCP_SDK_REPOSITORY_URL, 'https://github.com/AssistOS-AI/MCPSDK.git');
});

test('a usable package is accepted without reading library bytes or any revision', (t) => {
    const { sourceRoot } = fixture(t);
    const reads = [];
    const fsApi = { ...fs, readFileSync: (file, ...rest) => { reads.push(path.basename(String(file))); return fs.readFileSync(file, ...rest); } };
    const result = readMcpSdkPackage({ sourceRoot, fsApi });
    assert.equal(result.packageName, MCP_SDK_PACKAGE_NAME);
    assert.equal(result.packageVersion, '1.19.1');
    assert.equal(result.entry, 'index.mjs');
    assert.equal(result.sourceRoot, sourceRoot);
    assert.deepEqual(reads, ['package.json']);
    // Whatever the entry file contains is not the runtime's business.
    fs.writeFileSync(path.join(sourceRoot, 'index.mjs'), 'export const value = "edited but functional";\n');
    assert.equal(readMcpSdkPackage({ sourceRoot }).entry, 'index.mjs');
});

test('the entry point may be a condition map; nothing else is a usable entry', (t) => {
    const conditional = fixture(t, { exports: { '.': { import: './index.mjs', require: './index.cjs' } } });
    assert.equal(readMcpSdkPackage({ sourceRoot: conditional.sourceRoot }).entry, 'index.mjs');

    const noExports = fixture(t, { exports: undefined, main: './index.mjs' });
    assert.throws(() => readMcpSdkPackage({ sourceRoot: noExports.sourceRoot }), /declares no exports/);

    const missingEntry = fixture(t);
    fs.rmSync(path.join(missingEntry.sourceRoot, 'index.mjs'));
    assert.throws(() => readMcpSdkPackage({ sourceRoot: missingEntry.sourceRoot }), /entry point .* is missing/);

    const escaping = fixture(t, { exports: { '.': '../outside.mjs' } });
    fs.writeFileSync(path.join(escaping.root, 'outside.mjs'), 'export {};\n');
    assert.throws(() => readMcpSdkPackage({ sourceRoot: escaping.sourceRoot }), /outside the package/);

    const linkedEntry = fixture(t);
    fs.rmSync(path.join(linkedEntry.sourceRoot, 'index.mjs'));
    fs.writeFileSync(path.join(linkedEntry.root, 'real.mjs'), 'export {};\n');
    fs.symlinkSync(path.join(linkedEntry.root, 'real.mjs'), path.join(linkedEntry.sourceRoot, 'index.mjs'));
    assert.throws(() => readMcpSdkPackage({ sourceRoot: linkedEntry.sourceRoot }), /not a regular file/);
});

test('the wrong or an unversioned package is rejected, and a missing directory is an error', (t) => {
    const wrongName = fixture(t, { name: 'something-else' });
    assert.throws(() => readMcpSdkPackage({ sourceRoot: wrongName.sourceRoot }), /must contain @modelcontextprotocol\/sdk/);
    const noVersion = fixture(t, { version: '' });
    assert.throws(() => readMcpSdkPackage({ sourceRoot: noVersion.sourceRoot }), /must contain @modelcontextprotocol\/sdk/);
    assert.throws(() => readMcpSdkPackage({ sourceRoot: path.join(noVersion.root, 'absent') }), /directory is missing/);
    const linkedRoot = fixture(t);
    fs.symlinkSync(linkedRoot.sourceRoot, path.join(linkedRoot.root, 'linked'));
    assert.throws(() => readMcpSdkPackage({ sourceRoot: path.join(linkedRoot.root, 'linked') }), /not a real directory/);
});

test('the file tree must be plain: no symlinks, Git metadata or special files', (t) => {
    const plain = fixture(t);
    assert.doesNotThrow(() => assertMcpSdkTree(plain.sourceRoot));

    const linked = fixture(t);
    fs.symlinkSync('index.mjs', path.join(linked.sourceRoot, 'linked.mjs'));
    assert.throws(() => assertMcpSdkTree(linked.sourceRoot), /must not contain symlinks/);

    const git = fixture(t);
    fs.mkdirSync(path.join(git.sourceRoot, '.git'));
    assert.throws(() => assertMcpSdkTree(git.sourceRoot), /must not contain Git metadata/);

    const hardlinked = fixture(t);
    fs.linkSync(path.join(hardlinked.sourceRoot, 'index.mjs'), path.join(hardlinked.root, 'second-name.mjs'));
    assert.throws(() => assertMcpSdkTree(hardlinked.sourceRoot), /non-regular file/);
});

test('provenance is optional, informational and read only in the current format', (t) => {
    const unavailable = { repository: null, branch: null, commit: null, packageVersion: null };
    const { sourceRoot } = fixture(t);
    assert.deepEqual(readMcpSdkProvenance({ sourceRoot }), unavailable);

    const record = {
        schema: 'ploinky.box.library/v1', library: 'mcp-sdk', packageName: MCP_SDK_PACKAGE_NAME,
        packageVersion: '1.19.1', repository: MCP_SDK_REPOSITORY_URL, branch: 'main', commit: 'a'.repeat(40),
    };
    fs.writeFileSync(path.join(sourceRoot, MCP_SDK_BUNDLE_METADATA_NAME), JSON.stringify(record));
    assert.deepEqual(readMcpSdkProvenance({ sourceRoot }), {
        repository: MCP_SDK_REPOSITORY_URL, branch: 'main', commit: 'a'.repeat(40), packageVersion: '1.19.1',
    });

    // The format earlier versions wrote is not read, and never blocks the package.
    fs.writeFileSync(path.join(sourceRoot, MCP_SDK_BUNDLE_METADATA_NAME), JSON.stringify({
        schema: 'ploinky.box.mcp-sdk/v1', repository: { url: MCP_SDK_REPOSITORY_URL, commit: 'a'.repeat(40) },
        package: { name: MCP_SDK_PACKAGE_NAME, version: '1.19.1' }, contentSha256: 'c'.repeat(64),
    }));
    assert.deepEqual(readMcpSdkProvenance({ sourceRoot }), unavailable);
    fs.writeFileSync(path.join(sourceRoot, MCP_SDK_BUNDLE_METADATA_NAME), JSON.stringify({ ...record, library: 'achillesAgentLib' }));
    assert.deepEqual(readMcpSdkProvenance({ sourceRoot }), unavailable);
    fs.writeFileSync(path.join(sourceRoot, MCP_SDK_BUNDLE_METADATA_NAME), '{ not json');
    assert.deepEqual(readMcpSdkProvenance({ sourceRoot }), unavailable);
    assert.equal(readMcpSdkPackage({ sourceRoot }).packageName, MCP_SDK_PACKAGE_NAME);
});

test('the SDK identity is the immutable outer Box image plus the library, and nothing else', () => {
    assert.deepEqual(mcpSdkIdentity(OUTER_IMAGE_ID_FIXTURE), {
        kind: 'image', library: 'mcp-sdk', supplyingImageId: OUTER_IMAGE_ID_FIXTURE,
    });
    for (const bad of ['docker.io/assistos/ploinky-box:latest', 'b2'.repeat(32), '', undefined, null]) {
        assert.throws(() => mcpSdkIdentity(bad), { code: 'PLOINKY_AGENTLIB_IMAGE_INVALID' }, String(bad));
    }
});
