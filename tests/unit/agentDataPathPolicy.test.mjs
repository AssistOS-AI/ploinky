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
    ensureControllerGuardSources,
    controllerGuardMounts,
    controllerGuardTargets,
    normalizeRuntimeMountTarget,
    prepareControllerGuardMountpointCleanup,
} from '../../cli/utils/runtime/controllerStateGuards.js';
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

test('runtime mount targets use one absolute POSIX identity', () => {
    for (const spelling of ['/framework', '/framework/', '/framework/.', '/framework/././', '/framework/child/../']) {
        assert.equal(normalizeRuntimeMountTarget(spelling), '/framework');
    }
    for (const invalid of ['', undefined, null, 'framework', '../framework', '/framework\0']) {
        policyFailure(() => normalizeRuntimeMountTarget(invalid));
    }
});

test('equivalent guard-parent targets tighten every bind and reject conflicting sources', () => {
    const { root, cleanup } = fixture();
    try {
        const controllerDir = path.join(root, '.ploinky');
        fs.mkdirSync(path.join(controllerDir, 'data'), { recursive: true });
        const bindings = [
            { hostPath: controllerDir, runtimePath: '/framework/', readOnly: true },
            { hostPath: controllerDir, runtimePath: '/framework/././', readOnly: false },
        ];
        const targets = controllerGuardTargets(bindings, { workspaceRoot: root });
        const mounts = controllerGuardMounts(targets, { workspaceRoot: root, bindings });
        const parent = mounts.find(mount => mount.target === '/framework');
        assert.equal(parent.readOnly, true);
        assert.equal(parent.replaceExisting, true);
        assert.equal(mounts.filter(mount => mount.target === '/framework').length, 1);
        policyFailure(() => controllerGuardMounts(targets, {
            workspaceRoot: root,
            bindings: [...bindings, { hostPath: root, runtimePath: '/framework/.' }],
        }));
    } finally { cleanup(); }
});

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

test('manifest policy rejects every lexical, absolute, normalized, and symlinked controller-root source', () => {
    const { root, cleanup } = fixture();
    try {
        fs.mkdirSync(path.join(root, '.ploinky', 'data', 'secret'), { recursive: true });
        fs.mkdirSync(path.join(root, '.ploinky', 'deps', 'store', 'objects'), { recursive: true });
        fs.writeFileSync(path.join(root, '.ploinky', '.secrets'), 'SECRET=value\n');
        fs.symlinkSync(path.join(root, '.ploinky', 'data'), path.join(root, 'state-link'));
        fs.symlinkSync(path.join(root, '.ploinky', 'deps'), path.join(root, 'deps-link'));
        for (const source of [
            '.ploinky',
            '.ploinky/',
            '.ploinky/data',
            '.ploinky/other/../data/secret',
            path.join(root, '.ploinky', 'data', 'router-security'),
            '.ploinky/deps/store',
            '.ploinky/deps/store/objects',
            '.ploinky/.secrets',
            '.ploinky/agents',
            '.ploinky/repos',
            '.ploinky/running',
            'state-link/secret',
            'deps-link/store',
        ]) {
            policyFailure(() => assertManifestVolumeStoragePolicy(source, { workspaceRoot: root }));
        }
        fs.symlinkSync(path.join(root, '.ploinky', 'data', 'missing-state'), path.join(root, 'dangling-link'));
        policyFailure(() => assertManifestVolumeStoragePolicy('dangling-link', { workspaceRoot: root }));
        assert.equal(
            assertManifestVolumeStoragePolicy('.data/demo/state', { workspaceRoot: root }),
            path.join(root, '.data', 'demo', 'state'),
        );
        assert.equal(assertManifestVolumeStoragePolicy('.', { workspaceRoot: root }), root,
            'a broad workspace volume reaches the controller root only through the read-only guards');
    } finally {
        cleanup();
    }
});

test('controller guard targets are derived from broad mounts without creating the state root', () => {
    const { root, cleanup } = fixture();
    try {
        const targets = controllerGuardTargets([
            { hostPath: root, runtimePath: '/workspace' },
        ], { workspaceRoot: root });
        assert.deepEqual(targets.map(entry => entry.target), ['/workspace/.ploinky/data']);
        assert.deepEqual(targets.map(entry => entry.parentTarget), ['/workspace/.ploinky']);
        assert.deepEqual(targets.map(entry => entry.protectedParentHostPath), [path.join(root, '.ploinky')]);
        const sources = ensureControllerGuardSources({ workspaceRoot: root });
        assert.deepEqual(Array.from(sources.keys()), ['data']);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'data')), false);
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

test('controller guard mountpoint cleanup removes only an empty state root created after admission', () => {
    const { root, cleanup } = fixture();
    try {
        const controllerData = path.join(root, '.ploinky', 'data');
        fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
        const cleanupMountpoints = prepareControllerGuardMountpointCleanup({ workspaceRoot: root });
        fs.mkdirSync(controllerData, { recursive: true });
        cleanupMountpoints();
        assert.equal(fs.existsSync(controllerData), false);

        fs.mkdirSync(path.join(controllerData, 'edge-routing'), { recursive: true });
        const preserveExisting = prepareControllerGuardMountpointCleanup({ workspaceRoot: root });
        preserveExisting();
        assert.equal(fs.existsSync(path.join(controllerData, 'edge-routing')), true);

        fs.rmSync(controllerData, { recursive: true });
        const rejectUnexpectedData = prepareControllerGuardMountpointCleanup({ workspaceRoot: root });
        fs.mkdirSync(controllerData, { recursive: true });
        fs.writeFileSync(path.join(controllerData, 'unexpected'), 'data');
        assert.throws(rejectUnexpectedData, error => (
            error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION'
        ));
    } finally {
        cleanup();
    }
});

test('controller guard planning neither creates a missing controller parent nor mounts absent children', () => {
    const { root, cleanup } = fixture();
    try {
        const targets = controllerGuardTargets([{ hostPath: root, runtimePath: '/workspace' }], { workspaceRoot: root });
        const mounts = controllerGuardMounts(targets, { workspaceRoot: root });
        assert.deepEqual(mounts.map(mount => mount.target), ['/workspace/.ploinky']);
        assert.deepEqual(fs.readdirSync(mounts[0].source), []);
        assert.equal(fs.existsSync(path.join(root, '.ploinky')), false);
    } finally {
        cleanup();
    }
});

test('controller guard admission rejects protected-root child binds, including canonical aliases', () => {
    const { root, cleanup } = fixture();
    try {
        const protectedChild = path.join(root, '.ploinky', 'data', 'router-security');
        fs.mkdirSync(protectedChild, { recursive: true });
        const alias = path.join(root, 'router-security-alias');
        fs.symlinkSync(protectedChild, alias);

        for (const [hostPath, runtimePath] of [
            [protectedChild, '/lexical-project'],
            [alias, '/aliased-project'],
        ]) {
            assert.throws(
                () => controllerGuardTargets([{ hostPath, runtimePath }], { workspaceRoot: root }),
                error => error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION'
                    && /inside protected controller state/.test(error.message),
            );
        }
    } finally {
        cleanup();
    }
});

test('controller guard parents follow canonical aliases without replacing a read-only code grant', () => {
    const { root, cleanup } = fixture();
    try {
        const code = path.join(root, 'code');
        fs.mkdirSync(path.join(code, 'state-data'), { recursive: true });
        fs.mkdirSync(path.join(root, '.ploinky'));
        fs.symlinkSync('../code/state-data', path.join(root, '.ploinky', 'data'));
        const bindings = [
            { hostPath: root, runtimePath: '/workspace' },
            { hostPath: code, runtimePath: '/code', readOnly: true },
        ];
        const targets = controllerGuardTargets(bindings, { workspaceRoot: root });
        const aliased = targets.find(guard => guard.target === '/code/state-data');
        assert.equal(aliased.protectedParentHostPath, code);
        assert.equal(aliased.parentTarget, '/code');
        const mounts = controllerGuardMounts(targets, { workspaceRoot: root, bindings });
        assert.equal(mounts.some(mount => mount.target === '/code'), false);
        assert.ok(mounts.some(mount => mount.target === '/workspace/.ploinky' && mount.readOnly));
        assert.ok(mounts.some(mount => mount.target === '/workspace/code' && !mount.readOnly));
        assert.ok(mounts.some(mount => mount.target === '/code/state-data' && mount.readOnly));
    } finally { cleanup(); }
});

test('controller guard ancestors remain pinned without making the project read-only', () => {
    const { root, cleanup } = fixture();
    try {
        const workspaceRoot = path.join(root, 'projects', 'current');
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky', 'data'), { recursive: true });
        const bindings = [{ hostPath: root, runtimePath: '/home' }];
        const targets = controllerGuardTargets(bindings, { workspaceRoot });
        const mounts = controllerGuardMounts(targets, { workspaceRoot, bindings });
        assert.deepEqual(mounts.filter(mount => mount.parent).map(mount => [mount.target, mount.readOnly]), [
            ['/home/projects', false],
            ['/home/projects/current', false],
            ['/home/projects/current/.ploinky', true],
        ]);
    } finally { cleanup(); }
});

for (const workspaceAlias of [false, true]) {
    for (const existingChildren of [false, true]) {
        test(`controller guards accept controller aliases with workspace alias=${workspaceAlias}, existing children=${existingChildren}`, () => {
            const { root, cleanup } = fixture();
            try {
                const physicalWorkspace = path.join(root, 'project');
                const framework = path.join(physicalWorkspace, '.state');
                const running = path.join(framework, '.running-state');
                fs.mkdirSync(running, { recursive: true });
                fs.symlinkSync('.state', path.join(physicalWorkspace, '.ploinky'));
                fs.symlinkSync('.running-state', path.join(framework, 'running'));
                const workspaceRoot = workspaceAlias ? path.join(root, 'workspace') : physicalWorkspace;
                if (workspaceAlias) fs.symlinkSync('project', workspaceRoot);
                for (const directory of [physicalWorkspace, framework, running]) fs.chmodSync(directory, 0o770);
                if (existingChildren) {
                    fs.mkdirSync(path.join(framework, 'data'));
                }
                const preservedPaths = [workspaceRoot, physicalWorkspace, framework, running,
                    path.join(physicalWorkspace, '.ploinky'), path.join(framework, 'running')];
                const identities = () => preservedPaths.map(file => {
                    const stat = fs.lstatSync(file);
                    return { file, mode: stat.mode, uid: stat.uid, gid: stat.gid, dev: stat.dev,
                        ino: stat.ino, link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null };
                });
                const before = identities();
                const bindings = [
                    { hostPath: root, runtimePath: '/home' },
                    { hostPath: workspaceRoot, runtimePath: '/workspace' },
                ];
                const targets = controllerGuardTargets(bindings, { workspaceRoot });
                assert.deepEqual(targets.map(guard => guard.target), [
                    '/home/project/.state/data', '/workspace/.state/data',
                ]);
                const mounts = controllerGuardMounts(targets, { workspaceRoot, bindings });
                assert.deepEqual(mounts.filter(mount => mount.parent).map(mount => [mount.target, mount.readOnly]), [
                    ['/home/project', false], ['/workspace/.state', true], ['/home/project/.state', true],
                ]);
                assert.deepEqual(mounts.filter(mount => !mount.parent).map(mount => [mount.target, mount.readOnly]),
                    existingChildren ? targets.map(guard => [guard.target, true]) : []);
                assert.equal(fs.existsSync(path.join(framework, 'data')), existingChildren);
                policyFailure(() => controllerGuardTargets([
                    { hostPath: path.join(workspaceRoot, '.ploinky', 'data', 'child'), runtimePath: '/leak' },
                ], { workspaceRoot }));
                assert.deepEqual(identities(), before);
            } finally { cleanup(); }
        });
    }
}

for (const frameworkAlias of [false, true]) {
    test(`controller guard admission rejects indirect writable aliases with controller alias=${frameworkAlias}`, () => {
        const { root, cleanup } = fixture();
        try {
            const framework = path.join(root, 'framework');
            fs.mkdirSync(path.join(framework, 'data'), { recursive: true });
            if (frameworkAlias) {
                fs.mkdirSync(path.join(root, '.state'));
                fs.symlinkSync('.state', path.join(root, '.ploinky'));
            } else fs.mkdirSync(path.join(root, '.ploinky'));
            fs.symlinkSync('framework', path.join(root, 'alias'));
            fs.symlinkSync('../alias/data', path.join(root, '.ploinky', 'data'));
            policyFailure(() => controllerGuardTargets([
                { hostPath: root, runtimePath: '/workspace' },
            ], { workspaceRoot: root }));
            assert.deepEqual(fs.readdirSync(path.join(framework, 'data')), []);
        } finally { cleanup(); }
    });
}
