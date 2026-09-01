import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    AGENT_DATA_POLICY_CODE,
    assertCanonicalAgentDataPath,
    assertManifestVolumeStoragePolicy,
    ensureAgentDataDirectory,
    resolveAgentDataPath,
    validateAgentDataKey,
} from '../../cli/utils/runtime/agentDataPathPolicy.js';
import {
    ensureLegacyAgentGuardSources,
    legacyAgentGuardTargets,
    prepareLegacyGuardMountpointCleanup,
} from '../../cli/utils/runtime/legacyAgentDataGuards.js';
import {
    ensureManifestVolumeHostPath,
    resolveManifestVolumeHostPath,
} from '../../cli/utils/runtime/manifestVolumePolicy.js';

function fixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-data-policy-')));
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function policyFailure(fn) {
    assert.throws(fn, error => error?.code === AGENT_DATA_POLICY_CODE);
}

test('agent data keys are one validated segment', () => {
    for (const value of ['', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b', '\0', ' name']) {
        policyFailure(() => validateAgentDataKey(value));
    }
    assert.equal(validateAgentDataKey('webAssist-1.0_ok'), 'webAssist-1.0_ok');
});

test('data paths reject sibling prefixes, symlinked roots, and child links', () => {
    const { root, cleanup } = fixture();
    try {
        fs.mkdirSync(path.join(root, '.data-other'), { recursive: true });
        policyFailure(() => assertCanonicalAgentDataPath(path.join(root, '.data-other', 'agent'), { workspaceRoot: root }));

        fs.symlinkSync(path.join(root, '.data-other'), path.join(root, '.data'));
        policyFailure(() => resolveAgentDataPath('agent', { workspaceRoot: root }));
        fs.unlinkSync(path.join(root, '.data'));

        fs.mkdirSync(path.join(root, '.data'), { recursive: true });
        fs.symlinkSync(path.join(root, '.data-other'), path.join(root, '.data', 'link'));
        policyFailure(() => assertCanonicalAgentDataPath(path.join(root, '.data', 'link', 'child'), { workspaceRoot: root }));
    } finally {
        cleanup();
    }
});

test('missing descendants are created only after repeated canonical validation', () => {
    const { root, cleanup } = fixture();
    try {
        const target = resolveAgentDataPath('agent', { workspaceRoot: root });
        assert.equal(fs.existsSync(target), false);
        ensureAgentDataDirectory(target, { workspaceRoot: root });
        assert.equal(fs.statSync(target).isDirectory(), true);
        assert.equal(target, path.join(root, '.data', 'agent'));
    } finally {
        cleanup();
    }
});

test('manifest data paths are revalidated after creation and before reuse after a swap', () => {
    const { root, cleanup } = fixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-data-external-'));
    try {
        const volume = resolveManifestVolumeHostPath('.data/agent-volume', root);
        ensureManifestVolumeHostPath(volume, '/data', {}, { workspaceRoot: root });
        assert.equal(fs.statSync(volume).isDirectory(), true);

        fs.rmdirSync(volume);
        fs.symlinkSync(external, volume, 'dir');
        policyFailure(() => ensureManifestVolumeHostPath(volume, '/data', {}, { workspaceRoot: root }));
        assert.deepEqual(fs.readdirSync(external), []);
    } finally {
        cleanup();
        fs.rmSync(external, { recursive: true, force: true });
    }
});

test('manifest policy rejects lexical, absolute, normalized, and symlinked legacy roots', () => {
    const { root, cleanup } = fixture();
    try {
        fs.mkdirSync(path.join(root, '.ploinky', 'data', 'secret'), { recursive: true });
        fs.mkdirSync(path.join(root, '.ploinky', 'shared'), { recursive: true });
        fs.symlinkSync(path.join(root, '.ploinky', 'data'), path.join(root, 'legacy-link'));
        for (const source of [
            '.ploinky/data',
            '.ploinky/other/../data/secret',
            path.join(root, '.ploinky', 'shared'),
            'legacy-link/secret',
        ]) {
            policyFailure(() => assertManifestVolumeStoragePolicy(source, { workspaceRoot: root }));
        }
        fs.symlinkSync(path.join(root, '.ploinky', 'missing-legacy'), path.join(root, 'dangling-link'));
        policyFailure(() => assertManifestVolumeStoragePolicy('dangling-link', { workspaceRoot: root }));
        assert.equal(
            assertManifestVolumeStoragePolicy('.ploinky/repos', { workspaceRoot: root }),
            path.join(root, '.ploinky', 'repos'),
        );
    } finally {
        cleanup();
    }
});

test('legacy guard targets are derived from broad mounts without creating legacy roots', () => {
    const { root, cleanup } = fixture();
    try {
        const targets = legacyAgentGuardTargets([
            { hostPath: root, runtimePath: '/workspace' },
        ], { workspaceRoot: root });
        assert.deepEqual(targets.map(entry => entry.target), [
            '/workspace/.ploinky/data',
            '/workspace/.ploinky/shared',
        ]);
        const sources = ensureLegacyAgentGuardSources({ workspaceRoot: root });
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'data')), false);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'shared')), false);
        for (const source of sources.values()) {
            assert.equal(fs.readdirSync(source).length, 0);
            assert.equal(fs.statSync(source).mode & 0o777, 0o555);
            assert.equal(source.startsWith(`${root}${path.sep}`), false);
            assert.equal(
                source.startsWith(`${fs.realpathSync.native(os.tmpdir())}${path.sep}ploinky-runtime-guards${path.sep}`),
                true,
            );
        }
    } finally {
        cleanup();
    }
});

test('legacy guard mountpoint cleanup removes only empty roots created after admission', () => {
    const { root, cleanup } = fixture();
    try {
        const controllerData = path.join(root, '.ploinky', 'data');
        const legacyShared = path.join(root, '.ploinky', 'shared');
        fs.mkdirSync(path.join(controllerData, 'edge-routing'), { recursive: true });
        const cleanupMountpoints = prepareLegacyGuardMountpointCleanup({ workspaceRoot: root });
        fs.mkdirSync(legacyShared, { recursive: true });
        cleanupMountpoints();
        assert.equal(fs.existsSync(legacyShared), false);
        assert.equal(fs.existsSync(controllerData), true);

        fs.mkdirSync(legacyShared, { recursive: true });
        const preserveExisting = prepareLegacyGuardMountpointCleanup({ workspaceRoot: root });
        preserveExisting();
        assert.equal(fs.existsSync(legacyShared), true);

        fs.rmSync(legacyShared, { recursive: true });
        const rejectUnexpectedData = prepareLegacyGuardMountpointCleanup({ workspaceRoot: root });
        fs.mkdirSync(legacyShared, { recursive: true });
        fs.writeFileSync(path.join(legacyShared, 'unexpected'), 'data');
        assert.throws(rejectUnexpectedData, error => (
            error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION'
        ));
    } finally {
        cleanup();
    }
});

test('legacy guard admission rejects protected-root child binds, including canonical aliases', () => {
    const { root, cleanup } = fixture();
    try {
        const protectedChild = path.join(root, '.ploinky', 'data', 'legacy-agent');
        fs.mkdirSync(protectedChild, { recursive: true });
        const alias = path.join(root, 'legacy-agent-alias');
        fs.symlinkSync(protectedChild, alias);

        for (const [hostPath, runtimePath] of [
            [protectedChild, '/lexical-project'],
            [alias, '/aliased-project'],
        ]) {
            assert.throws(
                () => legacyAgentGuardTargets([{ hostPath, runtimePath }], { workspaceRoot: root }),
                error => error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION'
                    && /inside protected legacy agent data/.test(error.message),
            );
        }
    } finally {
        cleanup();
    }
});
