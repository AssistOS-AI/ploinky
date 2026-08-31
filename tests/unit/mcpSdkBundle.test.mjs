import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    MCP_SDK_BUNDLE_METADATA_NAME,
    MCP_SDK_BUNDLE_SCHEMA,
    prepareMcpSdkBundle,
    validateMcpSdkBundle,
} from '../../ploinky-box/mcp-sdk-bundle.mjs';

const MCP_COMMIT = '7efe9d17f52a625743e411089d3a6879f6f89156';
const AGENTLIB_COMMIT = '838a64bf9c5faa9f1c21935686bcfea642a42fa4';
const MCP_REPOSITORY = {
    url: 'https://github.com/AssistOS-AI/MCPSDK.git',
    commit: MCP_COMMIT,
};

function fixture(t, packageOverrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mcp-sdk-bundle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, 'mcp-sdk');
    fs.mkdirSync(path.join(sourceRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, '.git', 'config'), 'credential = must-not-survive\n');
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({
        name: '@modelcontextprotocol/sdk',
        version: '1.19.1',
        type: 'module',
        exports: { '.': './index.mjs' },
        ...packageOverrides,
    }));
    fs.writeFileSync(path.join(sourceRoot, 'index.mjs'), 'export const value = 42;\n');
    const lockPath = path.join(root, 'dependencies.lock.json');
    fs.writeFileSync(lockPath, JSON.stringify({
        repositories: {
            'mcp-sdk': MCP_REPOSITORY,
            achillesAgentLib: {
                url: 'https://github.com/AssistOS-AI/AchillesAgentLib.git',
                commit: AGENTLIB_COMMIT,
            },
        },
    }));
    return { root, sourceRoot, lockPath };
}

function gitStub({ head = MCP_COMMIT, dirty = '' } = {}) {
    return (args) => {
        if (args.includes('rev-parse')) return head;
        if (args.includes('status')) return dirty;
        throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    };
}

test('prepare seals a clean pinned checkout and strips all Git metadata', (t) => {
    const state = fixture(t);
    const result = prepareMcpSdkBundle({ ...state, git: gitStub() });
    assert.equal(result.schema, MCP_SDK_BUNDLE_SCHEMA);
    assert.deepEqual(result.repository, MCP_REPOSITORY);
    assert.equal(result.package.name, '@modelcontextprotocol/sdk');
    assert.match(result.contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(state.sourceRoot, '.git')), false);
    assert.equal(
        fs.existsSync(path.join(state.sourceRoot, MCP_SDK_BUNDLE_METADATA_NAME)),
        true,
    );
    assert.doesNotThrow(() => validateMcpSdkBundle({
        sourceRoot: state.sourceRoot,
        expectedRepository: MCP_REPOSITORY,
    }));
});

test('prepare rejects the wrong revision, a dirty checkout, and runtime dependencies', (t) => {
    const wrongHead = fixture(t);
    assert.throws(
        () => prepareMcpSdkBundle({ ...wrongHead, git: gitStub({ head: '0'.repeat(40) }) }),
        /expected 7efe9d17/,
    );

    const dirty = fixture(t);
    assert.throws(
        () => prepareMcpSdkBundle({ ...dirty, git: gitStub({ dirty: ' M index.mjs' }) }),
        /not clean/,
    );

    const dependencies = fixture(t, { dependencies: { zod: '^4.0.0' } });
    assert.throws(
        () => prepareMcpSdkBundle({ ...dependencies, git: gitStub() }),
        /declares dependencies/,
    );
    assert.equal(fs.existsSync(path.join(dependencies.sourceRoot, '.git')), true);
});

test('verification rejects content tampering, symlinks, and lock drift', (t) => {
    const tampered = fixture(t);
    prepareMcpSdkBundle({ ...tampered, git: gitStub() });
    fs.appendFileSync(path.join(tampered.sourceRoot, 'index.mjs'), '// changed\n');
    assert.throws(
        () => validateMcpSdkBundle({
            sourceRoot: tampered.sourceRoot,
            expectedRepository: MCP_REPOSITORY,
        }),
        /fingerprint/,
    );

    const linked = fixture(t);
    prepareMcpSdkBundle({ ...linked, git: gitStub() });
    fs.symlinkSync('index.mjs', path.join(linked.sourceRoot, 'linked.mjs'));
    assert.throws(
        () => validateMcpSdkBundle({ sourceRoot: linked.sourceRoot }),
        /must not contain symlinks/,
    );

    const drifted = fixture(t);
    prepareMcpSdkBundle({ ...drifted, git: gitStub() });
    assert.throws(
        () => validateMcpSdkBundle({
            sourceRoot: drifted.sourceRoot,
            expectedRepository: { ...MCP_REPOSITORY, commit: 'f'.repeat(40) },
        }),
        /does not match the Ploinky dependency lock/,
    );
});
