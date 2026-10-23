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
            '.ploinky/data/.secrets',
            '.ploinky/data/master-key',
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
        fs.mkdirSync(path.join(root, '.ploinky-box'));
        const targets = controllerGuardTargets([
            { hostPath: root, runtimePath: '/workspace' },
        ], { workspaceRoot: root });
        const byKey = Object.fromEntries(targets.map(entry => [entry.key, entry]));
        assert.deepEqual(Object.keys(byKey).sort(), ['data', 'host']);
        assert.equal(byKey.data.target, '/workspace/.ploinky/data');
        assert.equal(byKey.data.parentTarget, '/workspace/.ploinky');
        assert.equal(byKey.data.protectedParentHostPath, path.join(root, '.ploinky'));
        assert.equal(byKey.host.target, '/workspace/.ploinky-box');
        assert.equal(byKey.host.parentTarget, '/workspace');
        assert.equal(byKey.host.protectedParentHostPath, root);
        const sources = ensureControllerGuardSources({ workspaceRoot: root });
        assert.deepEqual(Array.from(sources.keys()), ['data', 'host']);
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
        fs.mkdirSync(path.join(root, '.ploinky-box'));
        const targets = controllerGuardTargets([{ hostPath: root, runtimePath: '/workspace' }], { workspaceRoot: root });
        const mounts = controllerGuardMounts(targets, { workspaceRoot: root });
        // The host state directory always exists and is always masked.
        assert.deepEqual(mounts.map(mount => mount.target), ['/workspace/.ploinky', '/workspace/.ploinky-box']);
        for (const mount of mounts) assert.deepEqual(fs.readdirSync(mount.source), [], mount.target);
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
        fs.mkdirSync(path.join(root, '.ploinky-box'));
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
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky-box'));
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
                fs.mkdirSync(path.join(physicalWorkspace, '.ploinky-box'));
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
                const dataTargets = targets.filter(guard => guard.key === 'data');
                assert.deepEqual(dataTargets.map(guard => guard.target), [
                    '/home/project/.state/data', '/workspace/.state/data',
                ]);
                assert.deepEqual(targets.filter(guard => guard.key === 'host').map(guard => guard.target).sort(), [
                    '/home/project/.ploinky-box', '/workspace/.ploinky-box',
                ]);
                const mounts = controllerGuardMounts(targets, { workspaceRoot, bindings });
                assert.deepEqual(mounts.filter(mount => mount.parent).map(mount => [mount.target, mount.readOnly]), [
                    ['/home/project', false], ['/workspace/.state', true], ['/home/project/.state', true],
                ]);
                assert.deepEqual(mounts.filter(mount => !mount.parent && !mount.target.endsWith('/.ploinky-box'))
                    .map(mount => [mount.target, mount.readOnly]),
                existingChildren ? dataTargets.map(guard => [guard.target, true]) : []);
                assert.deepEqual(mounts.filter(mount => mount.target.endsWith('/.ploinky-box'))
                    .map(mount => [mount.target, mount.readOnly]).sort(),
                [['/home/project/.ploinky-box', true], ['/workspace/.ploinky-box', true]]);
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

test('manifest volumes may not resolve into the Box host state directory of any workspace', async () => {
    const { isManagedManifestVolumeSource } = await import('../../cli/sandbox/runtimeCapabilities.js');
    const { root, cleanup } = fixture();
    try {
        fs.mkdirSync(path.join(root, '.ploinky-box', 'hardware-limits'), { recursive: true });
        fs.mkdirSync(path.join(root, 'other', '.ploinky-box'), { recursive: true });
        fs.mkdirSync(path.join(root, 'models'));
        fs.symlinkSync(path.join(root, '.ploinky-box'), path.join(root, 'state-alias'));
        for (const source of [
            '.ploinky-box',
            '.ploinky-box/hardware-limits',
            '.PLOINKY-BOX/hardware-limits',
            '.ploinKy-box',
            '.ploinky-box./x',
            'other/.ploinky-box',
            'state-alias',
            'state-alias/hardware-limits',
            path.join(root, '.ploinky-box'),
        ]) {
            policyFailure(() => assertManifestVolumeStoragePolicy(source, { workspaceRoot: root }));
            if (!path.isAbsolute(source)) {
                assert.equal(isManagedManifestVolumeSource(source, { workspaceRoot: root }), false, source);
            }
        }
        assert.equal(assertManifestVolumeStoragePolicy('models', { workspaceRoot: root }), path.join(root, 'models'));
        assert.equal(isManagedManifestVolumeSource('models', { workspaceRoot: root }), true);
        assert.equal(isManagedManifestVolumeSource('.ploinky-boxes', { workspaceRoot: root }), true, 'only the exact folded name');
    } finally {
        cleanup();
    }
});

// Plan D3: every agent runtime masks `<workspace>/.ploinky-box` read-only with
// an empty child bind while the workspace bind itself stays writable. The
// directory is never absent at planning time (host launches create the
// skeleton first; a Box always carries its own mask), so absence and any
// indirection are guard errors, never a read-only pin of the workspace.
test('the Box host state directory gets an empty read-only child mask and the workspace stays writable', () => {
    const { root, cleanup } = fixture();
    try {
        const hostState = path.join(root, '.ploinky-box');
        fs.mkdirSync(path.join(hostState, 'locks'), { recursive: true });
        fs.writeFileSync(path.join(hostState, 'workspace.json'), '{}');
        const bindings = [{ hostPath: root, runtimePath: '/workspace' }];
        const targets = controllerGuardTargets(bindings, { workspaceRoot: root });
        const mounts = controllerGuardMounts(targets, { workspaceRoot: root, bindings });
        const mask = mounts.find(mount => mount.target === '/workspace/.ploinky-box');
        assert.equal(mask.readOnly, true);
        assert.notEqual(mask.source, hostState);
        assert.deepEqual(fs.readdirSync(mask.source), []);
        assert.equal(mounts.some(mount => mount.target === '/workspace' && mount.readOnly), false,
            'the workspace bind is never pinned read-only for the host state directory');
        assert.deepEqual(fs.readdirSync(hostState).sort(), ['locks', 'workspace.json'], 'planning changes nothing there');
    } finally { cleanup(); }
});

test('a missing, symlinked or non-directory .ploinky-box is a guard error that creates nothing', () => {
    const { root, cleanup } = fixture();
    try {
        const hostState = path.join(root, '.ploinky-box');
        const elsewhere = path.join(root, 'elsewhere');
        fs.mkdirSync(elsewhere);
        const plan = () => {
            const bindings = [{ hostPath: root, runtimePath: '/workspace' }];
            return controllerGuardMounts(controllerGuardTargets(bindings, { workspaceRoot: root }), {
                workspaceRoot: root, bindings,
            });
        };
        const expectGuardError = (pattern) => assert.throws(plan, error => (
            error?.code === AGENT_DATA_POLICY_CODE && pattern.test(error.message)
        ));
        expectGuardError(/host state directory .* is missing/);
        assert.equal(fs.existsSync(hostState), false, 'the planner never creates the skeleton');

        fs.symlinkSync('elsewhere', hostState);
        expectGuardError(/must be a real directory/);
        fs.unlinkSync(hostState);
        fs.symlinkSync(os.tmpdir(), hostState);
        expectGuardError(/must be a real directory/);
        fs.unlinkSync(hostState);
        fs.writeFileSync(hostState, 'not a directory');
        expectGuardError(/must be a real directory/);
        assert.deepEqual(fs.readdirSync(elsewhere), []);
    } finally { cleanup(); }
});

test('a runtime bind source inside .ploinky-box, directly or through an alias, is refused', () => {
    const { root, cleanup } = fixture();
    try {
        const hostState = path.join(root, '.ploinky-box');
        fs.mkdirSync(path.join(hostState, 'hardware-limits'), { recursive: true });
        fs.symlinkSync(path.join(hostState, 'hardware-limits'), path.join(root, 'limits-alias'));
        for (const hostPath of [hostState, path.join(hostState, 'hardware-limits'), path.join(root, 'limits-alias')]) {
            assert.throws(() => controllerGuardTargets([{ hostPath, runtimePath: '/state' }], { workspaceRoot: root }),
                error => error?.code === AGENT_DATA_POLICY_CODE && /inside protected controller state/.test(error.message), hostPath);
        }
    } finally { cleanup(); }
});

test('guard mountpoint cleanup never removes the host state skeleton', () => {
    const { root, cleanup } = fixture();
    try {
        const hostState = path.join(root, '.ploinky-box');
        fs.mkdirSync(path.join(root, '.ploinky'));
        const cleanupMountpoints = prepareControllerGuardMountpointCleanup({ workspaceRoot: root });
        fs.mkdirSync(hostState);
        cleanupMountpoints();
        assert.equal(fs.statSync(hostState).isDirectory(), true, 'an empty .ploinky-box created after admission stays');
        fs.mkdirSync(path.join(hostState, 'locks'));
        const again = prepareControllerGuardMountpointCleanup({ workspaceRoot: root });
        again();
        assert.deepEqual(fs.readdirSync(hostState), ['locks']);
    } finally { cleanup(); }
});

test('in a Box the inherited read-only mask is masked again and nothing is created', async () => {
    const { ensureHostLaunchSkeleton } = await import('../../cli/sandbox/hostLaunchExclusion.js');
    const { root, cleanup } = fixture();
    try {
        // The Box's view: an empty, read-only directory mounted over .ploinky-box.
        const hostState = path.join(root, '.ploinky-box');
        fs.mkdirSync(hostState, { mode: 0o555 });
        fs.chmodSync(hostState, 0o555);
        let ensured = 0;
        assert.equal(ensureHostLaunchSkeleton(root, { insideBox: () => true, ensureSkeleton: () => { ensured += 1; } }), null);
        assert.equal(ensured, 0, 'an in-Box launch never creates the skeleton');
        const bindings = [{ hostPath: root, runtimePath: root }];
        const mounts = controllerGuardMounts(controllerGuardTargets(bindings, { workspaceRoot: root }), {
            workspaceRoot: root, bindings,
        });
        assert.ok(mounts.some(mount => mount.target === hostState && mount.readOnly));
        assert.deepEqual(fs.readdirSync(hostState), []);
        assert.equal(fs.statSync(hostState).mode & 0o777, 0o555);
        fs.chmodSync(hostState, 0o700);
    } finally { cleanup(); }
});

test('a resolved host state target is checked again when its mask is planned', () => {
    const { root, cleanup } = fixture();
    try {
        // The container runtime's synthetic targets skip the bind walk.
        const hostState = path.join(root, '.ploinky-box');
        const target = [{ key: 'host', target: hostState, protectedHostPath: hostState }];
        policyFailure(() => controllerGuardMounts(target, { workspaceRoot: root }));
        fs.symlinkSync(os.tmpdir(), hostState);
        policyFailure(() => controllerGuardMounts(target, { workspaceRoot: root }));
        fs.unlinkSync(hostState);
        fs.mkdirSync(hostState);
        const mounts = controllerGuardMounts(target, { workspaceRoot: root });
        assert.deepEqual(mounts.map(mount => [mount.target, mount.readOnly]), [[hostState, true]]);
    } finally { cleanup(); }
});

test('the Box host-state name fold has one implementation, shared by the volume policy and the capability check', async () => {
    for (const file of ['cli/utils/runtime/agentDataPathPolicy.js', 'cli/sandbox/runtimeCapabilities.js']) {
        const source = fs.readFileSync(path.resolve(file), 'utf8');
        // The shared function is imported from its one module and called.
        assert.match(source, /^import \{[^}]*\bhasHostStateComponent\b[^}]*\} from '(?:\.\.\/)+ploinky-box\/hostState\/paths\.mjs';$/m, file);
        assert.match(source, /^(?!\s*\/\/).*\bhasHostStateComponent\(/m, file);
        assert.doesNotMatch(source, /NFKC/, `${file} keeps its own copy of the name fold`);
    }
    // Behavior parity at the shared function: both consumers refuse the folded forms.
    const { hasHostStateComponent } = await import('../../ploinky-box/hostState/paths.mjs');
    for (const name of ['.PLOINKY-BOX', '.ploinky-box.', 'Keep/.ploinky-box', 'a/.Ploinky-Box /b']) {
        assert.equal(hasHostStateComponent(name), true, name);
    }
    assert.equal(hasHostStateComponent('.ploinky-boxes'), false);
});
