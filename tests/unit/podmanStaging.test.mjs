import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    appendLegacyAgentDataGuards,
    assertPodmanCodeMountAllowed,
    buildPodmanStagedTargetMounts,
    codeRelativeMountPath,
    collectManifestVolumeEntries,
    ensurePodmanStagedCodeDir,
    ensureManifestVolumeHostPath,
    manifestVolumeMountSuffix,
    mergeNodeOptions,
    podmanManifestVolumeMountSuffix,
    podmanMountSuffix,
    resolveReusablePodmanStagedMounts,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import { AGENTS_DATA_DIR, PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../../cli/utils/config.js';
import {
    assertManifestStorageAdmission,
    resolveManifestVolumeHostPath,
} from '../../cli/utils/runtime/manifestVolumePolicy.js';
import { prepareLegacyGuardMountpointCleanup } from '../../cli/utils/runtime/legacyAgentDataGuards.js';
import { buildInteractiveAgentCreateCommand } from '../../cli/sandbox/docker/interactive.js';
import {
    prepareFreshRuntimeRoot,
    pruneStaleRuntimeEntries,
} from '../../cli/utils/runtime/runtimeStaging.js';

function tempDir(prefix = 'podman-staging-') {
    return path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function hasLocalPodmanBusybox() {
    const podman = spawnSync('podman', ['--version'], { stdio: 'ignore' });
    if (podman.status !== 0) return false;
    const image = spawnSync('podman', ['image', 'exists', 'docker.io/library/busybox:1.36'], { stdio: 'ignore' });
    return image.status === 0;
}

function hasLocalDockerBusybox() {
    const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
    if (docker.status !== 0) return false;
    const image = spawnSync('docker', ['image', 'inspect', 'docker.io/library/busybox:1.36'], { stdio: 'ignore' });
    return image.status === 0;
}

test('codeRelativeMountPath recognizes mounts below /code only', () => {
    assert.equal(codeRelativeMountPath('/code/livekit.yaml'), 'livekit.yaml');
    assert.equal(codeRelativeMountPath('/code/config/runtime.json'), 'config/runtime.json');
    assert.equal(codeRelativeMountPath('/data'), null);
    assert.equal(codeRelativeMountPath('/code'), null);
});

test('ensurePodmanStagedCodeDir stages source tree with dependency and /code volume symlinks', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, 'agent');
        const cacheNodeModules = path.join(root, 'cache', 'node_modules');
        const runtimeConfig = path.join(root, 'generated', 'runtime.json');
        const topLevelConfig = path.join(root, 'generated', 'top.txt');
        fs.mkdirSync(path.join(agentCodePath, 'config'), { recursive: true });
        fs.mkdirSync(cacheNodeModules, { recursive: true });
        fs.mkdirSync(path.dirname(runtimeConfig), { recursive: true });
        fs.writeFileSync(path.join(agentCodePath, 'package.json'), '{"type":"module"}\n');
        fs.writeFileSync(path.join(agentCodePath, 'config', 'default.json'), '{}\n');
        fs.writeFileSync(path.join(agentCodePath, 'top.txt'), 'source\n');
        fs.writeFileSync(runtimeConfig, '{"generated":true}\n');
        fs.writeFileSync(topLevelConfig, 'generated\n');

        const stagedCodePath = ensurePodmanStagedCodeDir('demo', agentCodePath, cacheNodeModules, new Map([
            ['config/runtime.json', runtimeConfig],
            ['top.txt', topLevelConfig],
        ]), { runtimeRoot: path.join(root, 'runtime') });

        assert.equal(fs.realpathSync(path.join(stagedCodePath, 'package.json')), fs.realpathSync(path.join(agentCodePath, 'package.json')));
        assert.equal(fs.realpathSync(path.join(stagedCodePath, 'node_modules')), fs.realpathSync(cacheNodeModules));
        assert.equal(fs.realpathSync(path.join(stagedCodePath, 'config', 'default.json')), fs.realpathSync(path.join(agentCodePath, 'config', 'default.json')));
        assert.equal(fs.realpathSync(path.join(stagedCodePath, 'config', 'runtime.json')), fs.realpathSync(runtimeConfig));
        assert.equal(fs.realpathSync(path.join(stagedCodePath, 'top.txt')), fs.realpathSync(topLevelConfig));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ensurePodmanStagedCodeDir rejects manifest overrides below /code/node_modules', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, 'agent');
        const cacheNodeModules = path.join(root, 'cache', 'node_modules');
        const replacement = path.join(root, 'replacement');
        fs.mkdirSync(agentCodePath, { recursive: true });
        fs.mkdirSync(cacheNodeModules, { recursive: true });
        fs.mkdirSync(replacement, { recursive: true });

        assert.throws(
            () => ensurePodmanStagedCodeDir('demo', agentCodePath, cacheNodeModules, new Map([
                ['node_modules/minimatch', replacement],
            ]), { runtimeRoot: path.join(root, 'runtime') }),
            /reserved \/code\/node_modules/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolveReusablePodmanStagedMounts preserves exact managed Agent and code directories', () => {
    const root = tempDir();
    try {
        const runtimeRoot = path.join(root, 'container-runtime', 'demo');
        const agentSource = path.join(runtimeRoot, 'Agent-123-456');
        const codeSource = path.join(runtimeRoot, 'code-123-457');
        fs.mkdirSync(agentSource, { recursive: true });
        fs.mkdirSync(codeSource, { recursive: true });

        assert.deepEqual(resolveReusablePodmanStagedMounts({
            config: {
                binds: [
                    { source: agentSource, target: '/Agent', ro: true },
                    { source: codeSource, target: '/code', ro: false },
                ],
            },
        }, runtimeRoot), { agentLibMountPath: agentSource, codeMountPath: codeSource });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolveReusablePodmanStagedMounts rejects duplicate and escaping staged sources', () => {
    const root = tempDir();
    try {
        const runtimeRoot = path.join(root, 'container-runtime', 'demo');
        const agentSource = path.join(runtimeRoot, 'Agent-123-456');
        const codeSource = path.join(runtimeRoot, 'code-123-457');
        const outside = path.join(root, 'Agent-999-999');
        fs.mkdirSync(agentSource, { recursive: true });
        fs.mkdirSync(codeSource, { recursive: true });
        fs.mkdirSync(outside, { recursive: true });

        assert.equal(resolveReusablePodmanStagedMounts({
            config: { binds: [
                { source: outside, target: '/Agent' },
                { source: codeSource, target: '/code' },
            ] },
        }, runtimeRoot), null);
        assert.equal(resolveReusablePodmanStagedMounts({
            config: { binds: [
                { source: agentSource, target: '/Agent' },
                { source: agentSource, target: '/Agent' },
                { source: codeSource, target: '/code' },
            ] },
        }, runtimeRoot), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('buildPodmanStagedTargetMounts protects source and dependency targets while exposing explicit code links', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, 'workspace', 'agent');
        const cacheNodeModules = path.join(root, 'workspace', '.ploinky', 'deps', 'node_modules');
        const outOfWorkspaceVolume = path.join(root, 'outside', 'runtime.json');
        const skillsPath = path.join(root, 'workspace', 'skills', 'demo');
        fs.mkdirSync(agentCodePath, { recursive: true });
        fs.mkdirSync(cacheNodeModules, { recursive: true });
        fs.mkdirSync(path.dirname(outOfWorkspaceVolume), { recursive: true });
        fs.writeFileSync(outOfWorkspaceVolume, '{}\n');
        fs.mkdirSync(skillsPath, { recursive: true });

        const mounts = buildPodmanStagedTargetMounts({
            agentCodePath,
            nodeModulesDir: cacheNodeModules,
            codeReadOnly: true,
            codeLinks: new Map([
                ['config/runtime.json', { hostPath: outOfWorkspaceVolume, readOnly: false }],
                ['skills', { hostPath: skillsPath, readOnly: true }],
            ]),
        });

        assert.deepEqual(mounts, [
            { source: agentCodePath, target: agentCodePath, ro: true },
            { source: outOfWorkspaceVolume, target: outOfWorkspaceVolume, ro: false },
            { source: skillsPath, target: skillsPath, ro: true },
            { source: cacheNodeModules, target: cacheNodeModules, ro: true },
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('assertPodmanCodeMountAllowed reports reserved dependency cache mounts', () => {
    assert.doesNotThrow(() => assertPodmanCodeMountAllowed('config/runtime.json', '/code/config/runtime.json'));
    assert.throws(
        () => assertPodmanCodeMountAllowed('node_modules', '/code/node_modules'),
        /reserved \/code\/node_modules/,
    );
    assert.throws(
        () => assertPodmanCodeMountAllowed('node_modules/minimatch', '/code/node_modules/minimatch'),
        /reserved \/code\/node_modules/,
    );
});

test('runtime staging helper replaces only managed current roots', () => {
    const root = tempDir();
    try {
        const parent = path.join(root, 'container-runtime');
        const runtimeRoot = path.join(parent, 'demo');
        fs.mkdirSync(path.join(runtimeRoot, 'old'), { recursive: true });

        prepareFreshRuntimeRoot(runtimeRoot, parent);
        assert.ok(fs.existsSync(runtimeRoot));
        assert.deepEqual(fs.readdirSync(runtimeRoot), []);

        assert.throws(
            () => prepareFreshRuntimeRoot(parent, parent),
            /Refusing to remove unmanaged runtime path/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('pruneStaleRuntimeEntries removes only entries whose pid is no longer alive', () => {
    const root = tempDir();
    try {
        const runtimeRoot = path.join(root, 'seatbelt-runtime', 'demo');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const liveEntry = `Agent-${process.pid}-1`;
        const stalePid = 999999; // unlikely to be assigned to a live process
        const staleEntry = `Agent-${stalePid}-2`;
        const staleCodeEntry = `code-${stalePid}-3`;
        const unrelatedEntry = 'README.txt';
        fs.mkdirSync(path.join(runtimeRoot, liveEntry), { recursive: true });
        fs.mkdirSync(path.join(runtimeRoot, staleEntry), { recursive: true });
        fs.mkdirSync(path.join(runtimeRoot, staleCodeEntry), { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, unrelatedEntry), 'hi\n');

        const removed = pruneStaleRuntimeEntries(runtimeRoot);
        const remaining = fs.readdirSync(runtimeRoot).sort();

        assert.deepEqual(removed.sort(), [staleEntry, staleCodeEntry].sort());
        assert.deepEqual(remaining, [liveEntry, unrelatedEntry].sort());
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('pruneStaleRuntimeEntries preserves explicit keep paths even with stale pid', () => {
    const root = tempDir();
    try {
        const runtimeRoot = path.join(root, 'seatbelt-runtime', 'demo');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const stalePid = 999999;
        const keptEntry = `Agent-${stalePid}-1`;
        const removedEntry = `Agent-${stalePid}-2`;
        fs.mkdirSync(path.join(runtimeRoot, keptEntry), { recursive: true });
        fs.mkdirSync(path.join(runtimeRoot, removedEntry), { recursive: true });

        const removed = pruneStaleRuntimeEntries(runtimeRoot, {
            keepPaths: [path.join(runtimeRoot, keptEntry)]
        });
        const remaining = fs.readdirSync(runtimeRoot).sort();

        assert.deepEqual(removed, [removedEntry]);
        assert.deepEqual(remaining, [keptEntry]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('pruneStaleRuntimeEntries returns empty list when runtimeRoot is missing', () => {
    const root = tempDir();
    try {
        const removed = pruneStaleRuntimeEntries(path.join(root, 'does-not-exist'));
        assert.deepEqual(removed, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('mergeNodeOptions appends podman symlink flags without duplicating existing options', () => {
    assert.equal(
        mergeNodeOptions('--trace-warnings --preserve-symlinks', ['--preserve-symlinks', '--preserve-symlinks-main']),
        '--trace-warnings --preserve-symlinks --preserve-symlinks-main',
    );
});

test('podmanMountSuffix places z before ro for absolute self-mount targets', () => {
    assert.equal(podmanMountSuffix(true), ':z,ro');
    assert.equal(podmanMountSuffix(false), ':z');
});

test('profile manifest volumes are collected with profile volume options', () => {
    const entries = collectManifestVolumeEntries({
        volumes: {
            '.data/root-state': '/root-state',
        },
        volumeOptions: {
            '/root-state': { readOnly: true },
            '/data': { podmanChown: false },
        },
    }, {
        volumes: {
            '.data/example-service': '/data',
        },
        volumeOptions: {
            '/data': { podmanChown: true },
        },
    });

    assert.deepEqual(entries, [
        {
            hostPath: '.data/root-state',
            containerPath: '/root-state',
            resolvedHostPath: path.join(AGENTS_DATA_DIR, 'root-state'),
            options: { readOnly: true },
        },
        {
            hostPath: '.data/example-service',
            containerPath: '/data',
            resolvedHostPath: path.join(AGENTS_DATA_DIR, 'example-service'),
            options: { podmanChown: true },
        },
    ]);
});

test('podman manifest data volumes chown only managed writable data mounts by default', () => {
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(AGENTS_DATA_DIR, 'example-service'), {}),
        ':z,U',
    );
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(PLOINKY_WORKSPACE_ROOT, 'workspace-data'), {}),
        ':z',
    );
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(AGENTS_DATA_DIR, 'readonly'), { readOnly: true }),
        ':z,ro',
    );
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(AGENTS_DATA_DIR, 'optout'), { podmanChown: false }),
        ':z',
    );
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(os.tmpdir(), 'explicit-podman-volume'), { podmanChown: true }),
        ':z,U',
    );
});

test('read-only manifest volumes are enforced across container runtimes', () => {
    const hostPath = path.join(AGENTS_DATA_DIR, 'readonly');
    assert.equal(manifestVolumeMountSuffix('podman', hostPath, { readOnly: true }), ':z,ro');
    assert.equal(manifestVolumeMountSuffix('docker', hostPath, { readOnly: true }), ':ro');
    assert.equal(manifestVolumeMountSuffix('docker', hostPath, {}), '');
});

test('manifest volume host paths accept canonical data and external sources but reject legacy storage', () => {
    assert.equal(
        resolveManifestVolumeHostPath('.data/demo/state'),
        path.join(AGENTS_DATA_DIR, 'demo', 'state'),
    );
    assert.equal(
        resolveManifestVolumeHostPath('demo/state'),
        path.join(PLOINKY_WORKSPACE_ROOT, 'demo', 'state'),
    );

    const absoluteVolume = path.join(os.tmpdir(), 'ploinky-absolute-volume');
    assert.equal(
        resolveManifestVolumeHostPath(absoluteVolume),
        path.resolve(absoluteVolume),
    );
    for (const legacy of ['.ploinky/data/demo/state', '.ploinky/shared/file']) {
        assert.throws(() => resolveManifestVolumeHostPath(legacy), error => {
            assert.equal(error.code, 'PLOINKY_AGENT_DATA_POLICY_VIOLATION');
            return true;
        });
    }
});

test('manifest admission validates both root and selected profile volumes', () => {
    assert.equal(assertManifestStorageAdmission({
        volumes: { '.data/root-owned': '/root-owned' },
    }, {
        volumes: { '.data/profile-owned': '/profile-owned' },
    }), true);
    for (const [manifest, profile] of [
        [{ volumes: { '.ploinky/data/root-owned': '/data' } }, null],
        [{}, { volumes: { '.ploinky/shared/profile-owned': '/shared-old' } }],
    ]) {
        assert.throws(() => assertManifestStorageAdmission(manifest, profile), error => {
            assert.equal(error.code, 'PLOINKY_AGENT_DATA_POLICY_VIOLATION');
            return true;
        });
    }
});

test('generated required manifest volumes must be produced by hooks', () => {
    const root = tempDir();
    try {
        const generatedFile = path.join(root, 'runtime', 'livekit.yaml');
        assert.throws(
            () => ensureManifestVolumeHostPath(generatedFile, '/code/livekit.yaml', {
                generated: true,
                required: true,
            }),
            /Missing or empty required generated volume/,
        );
        // The required-and-missing branch must not pre-create directories on
        // the host before throwing (avoids leaving stray scaffolding behind).
        assert.equal(fs.existsSync(path.dirname(generatedFile)), false);
        assert.equal(fs.existsSync(generatedFile), false);

        fs.mkdirSync(path.dirname(generatedFile), { recursive: true });
        fs.writeFileSync(generatedFile, '');
        assert.throws(
            () => ensureManifestVolumeHostPath(generatedFile, '/code/livekit.yaml', {
                generated: true,
                required: true,
            }),
            /Missing or empty required generated volume/,
        );

        fs.writeFileSync(generatedFile, 'keys:\n  devkey: devsecret\n');
        assert.doesNotThrow(
            () => ensureManifestVolumeHostPath(generatedFile, '/code/livekit.yaml', {
                generated: true,
                required: true,
            }),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('generated required no-extension files are rejected when empty', () => {
    const root = tempDir();
    try {
        const generatedFile = path.join(root, 'runtime', 'TOKEN');
        fs.mkdirSync(path.dirname(generatedFile), { recursive: true });
        fs.writeFileSync(generatedFile, '');

        assert.throws(
            () => ensureManifestVolumeHostPath(generatedFile, '/code/TOKEN', {
                generated: true,
                required: true,
            }),
            /Missing or empty required generated volume/,
        );

        fs.writeFileSync(generatedFile, 'present\n');
        assert.doesNotThrow(
            () => ensureManifestVolumeHostPath(generatedFile, '/code/TOKEN', {
                generated: true,
                required: true,
            }),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('generated required directory volumes are rejected when empty', () => {
    const root = tempDir();
    try {
        const generatedDir = path.join(root, 'runtime', 'configs');
        fs.mkdirSync(generatedDir, { recursive: true });

        assert.throws(
            () => ensureManifestVolumeHostPath(generatedDir, '/code/configs', {
                generated: true,
                required: true,
            }),
            /Missing or empty required generated volume/,
        );

        fs.writeFileSync(path.join(generatedDir, 'livekit.yaml'), 'keys:\n  devkey: devsecret\n');
        assert.doesNotThrow(
            () => ensureManifestVolumeHostPath(generatedDir, '/code/configs', {
                generated: true,
                required: true,
            }),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('generated non-required manifest volumes pre-create the parent slot', () => {
    const root = tempDir();
    try {
        const generatedFile = path.join(root, 'runtime', 'optional.yaml');
        assert.doesNotThrow(
            () => ensureManifestVolumeHostPath(generatedFile, '/code/optional.yaml', {
                generated: true,
                required: false,
            }),
        );
        assert.equal(fs.existsSync(path.dirname(generatedFile)), true);
        assert.equal(fs.existsSync(generatedFile), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('real podman run keeps staged symlink code and dependency targets read-only', { skip: !hasLocalPodmanBusybox() }, () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, 'workspace', 'agent');
        const agentWorkDir = path.join(root, 'workspace', '.ploinky', 'agents', 'demo');
        const cacheNodeModules = path.join(root, 'workspace', '.ploinky', 'deps', 'demo', 'node_modules');
        const stagedCodePath = path.join(root, 'staged-code');
        fs.mkdirSync(agentCodePath, { recursive: true });
        fs.mkdirSync(agentWorkDir, { recursive: true });
        fs.mkdirSync(path.join(cacheNodeModules, 'pkg'), { recursive: true });
        fs.mkdirSync(stagedCodePath, { recursive: true });
        fs.writeFileSync(path.join(agentCodePath, 'file.txt'), 'source\n');
        fs.writeFileSync(path.join(cacheNodeModules, 'pkg', 'file.txt'), 'dep\n');
        fs.symlinkSync(path.join(agentCodePath, 'file.txt'), path.join(stagedCodePath, 'file.txt'), 'file');
        fs.symlinkSync(cacheNodeModules, path.join(stagedCodePath, 'node_modules'), 'dir');

        const script = [
            'set -eu',
            'cat /code/file.txt >/dev/null',
            'cat /code/node_modules/pkg/file.txt >/dev/null',
            'if sh -c "echo bad >/code/file.txt" 2>/dev/null; then echo CODE_WRITE_SUCCEEDED; exit 10; fi',
            'if sh -c "echo bad >/code/node_modules/pkg/file.txt" 2>/dev/null; then echo DEPS_WRITE_SUCCEEDED; exit 11; fi',
            'echo RO_OK',
        ].join('; ');

        const result = spawnSync('podman', [
            'run',
            '--rm',
            '-v', `${stagedCodePath}:/code${podmanMountSuffix(true)}`,
            '-v', `${agentWorkDir}:${agentWorkDir}:z`,
            '-v', `${agentCodePath}:${agentCodePath}${podmanMountSuffix(true)}`,
            '-v', `${cacheNodeModules}:${cacheNodeModules}${podmanMountSuffix(true)}`,
            'docker.io/library/busybox:1.36',
            'sh',
            '-lc',
            script,
        ], { encoding: 'utf8' });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /RO_OK/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('real podman run with rw code keeps dependency cache read-only (dev profile)', { skip: !hasLocalPodmanBusybox() }, () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, 'workspace', 'agent');
        const agentWorkDir = path.join(root, 'workspace', '.ploinky', 'agents', 'demo');
        const cacheNodeModules = path.join(root, 'workspace', '.ploinky', 'deps', 'demo', 'node_modules');
        const stagedCodePath = path.join(root, 'staged-code');
        fs.mkdirSync(agentCodePath, { recursive: true });
        fs.mkdirSync(agentWorkDir, { recursive: true });
        fs.mkdirSync(path.join(cacheNodeModules, 'pkg'), { recursive: true });
        fs.mkdirSync(stagedCodePath, { recursive: true });
        fs.writeFileSync(path.join(agentCodePath, 'file.txt'), 'source\n');
        fs.writeFileSync(path.join(cacheNodeModules, 'pkg', 'file.txt'), 'dep\n');
        fs.symlinkSync(path.join(agentCodePath, 'file.txt'), path.join(stagedCodePath, 'file.txt'), 'file');
        fs.symlinkSync(cacheNodeModules, path.join(stagedCodePath, 'node_modules'), 'dir');

        // Dev profile: /code rw, but the dependency cache must still be ro.
        const script = [
            'cat /code/file.txt >/dev/null',
            'cat /code/node_modules/pkg/file.txt >/dev/null',
            'if ! sh -c "echo updated >/code/file.txt" 2>/dev/null; then echo CODE_WRITE_BLOCKED; exit 20; fi',
            'if sh -c "echo bad >/code/node_modules/pkg/file.txt" 2>/dev/null; then echo DEPS_WRITE_SUCCEEDED; exit 21; fi',
            'echo DEV_OK',
        ].join('; ');

        const result = spawnSync('podman', [
            'run',
            '--rm',
            '-v', `${stagedCodePath}:/code${podmanMountSuffix(false)}`,
            '-v', `${agentWorkDir}:${agentWorkDir}:z`,
            '-v', `${agentCodePath}:${agentCodePath}${podmanMountSuffix(false)}`,
            '-v', `${cacheNodeModules}:${cacheNodeModules}${podmanMountSuffix(true)}`,
            'docker.io/library/busybox:1.36',
            'sh',
            '-lc',
            script,
        ], { encoding: 'utf8' });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /DEV_OK/);
        // Sanity: code write should have succeeded, so the file content changed.
        assert.equal(fs.readFileSync(path.join(agentCodePath, 'file.txt'), 'utf8').trim(), 'updated');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('real podman run keeps controller legacy trees opaque while controller writes remain possible', { skip: !hasLocalPodmanBusybox() }, () => {
    const root = tempDir('podman-legacy-guard-');
    try {
        const protectedTrees = [
            path.join(root, '.ploinky', 'data', 'edge-routing'),
            path.join(root, '.ploinky', 'data', 'edge-publication'),
            path.join(root, '.ploinky', 'data', 'router-security'),
            path.join(root, '.ploinky', 'shared'),
        ];
        for (const directory of protectedTrees) {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'sentinel'), 'controller');
        }
        const runtimeArgs = ['run', '--rm', '-v', `${root}:/workspace:z`];
        const guards = appendLegacyAgentDataGuards(runtimeArgs, 'podman', { workspaceRoot: root });
        assert.deepEqual(guards.map(guard => guard.target), [
            '/workspace/.ploinky/data',
            '/workspace/.ploinky/shared',
        ]);
        const script = [
            'test -z "$(ls -A /workspace/.ploinky/data)"',
            'test -z "$(ls -A /workspace/.ploinky/shared)"',
            'if cat /workspace/.ploinky/data/edge-routing/sentinel 2>/dev/null; then exit 31; fi',
            'if cat /workspace/.ploinky/shared/sentinel 2>/dev/null; then exit 32; fi',
            'if touch /workspace/.ploinky/data/exposed 2>/dev/null; then exit 33; fi',
            'if touch /workspace/.ploinky/shared/exposed 2>/dev/null; then exit 34; fi',
            'if mkdir /workspace/.ploinky/data/exposed-dir 2>/dev/null; then exit 35; fi',
            'if mkdir /workspace/.ploinky/shared/exposed-dir 2>/dev/null; then exit 36; fi',
            'if mv /workspace/.ploinky /workspace/moved 2>/dev/null; then exit 37; fi',
            'if rm -rf /workspace/.ploinky 2>/dev/null; then exit 38; fi',
            'if ln -sfn /workspace/replacement /workspace/.ploinky 2>/dev/null; then exit 39; fi',
            'touch /workspace/project-write',
            'echo OPAQUE_OK',
        ].join('; ');
        const result = spawnSync('podman', [
            ...runtimeArgs,
            'docker.io/library/busybox:1.36',
            'sh', '-lc', script,
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /OPAQUE_OK/);
        for (const directory of protectedTrees) {
            assert.equal(fs.readFileSync(path.join(directory, 'sentinel'), 'utf8'), 'controller');
            fs.writeFileSync(path.join(directory, 'controller-after'), 'updated');
            assert.equal(fs.readFileSync(path.join(directory, 'controller-after'), 'utf8'), 'updated');
        }
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'data', 'exposed')), false);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'shared', 'exposed')), false);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'data', 'exposed-dir')), false);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'shared', 'exposed-dir')), false);
        assert.equal(fs.existsSync(path.join(root, 'moved')), false);
        assert.equal(fs.existsSync(path.join(root, 'project-write')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('real podman create keeps an absent shared root absent and uncreatable after mountpoint cleanup', { skip: !hasLocalPodmanBusybox() }, () => {
    const root = tempDir('podman-missing-legacy-guard-');
    const containerName = `ploinky_missing_legacy_guard_${process.pid}_${Date.now()}`;
    try {
        const controllerData = path.join(root, '.ploinky', 'data', 'edge-routing');
        fs.mkdirSync(controllerData, { recursive: true });
        fs.writeFileSync(path.join(controllerData, 'sentinel'), 'controller');
        fs.chmodSync(path.join(root, '.ploinky'), 0o777);

        const runtimeArgs = [
            'create', '--name', containerName, '--user', '1000:1000',
            '-v', `${root}:/workspace:z`,
        ];
        appendLegacyAgentDataGuards(runtimeArgs, 'podman', { workspaceRoot: root });
        const mounts = runtimeArgs.filter((_value, index) => runtimeArgs[index - 1] === '-v');
        assert.ok(mounts.includes(`${fs.realpathSync(path.join(root, '.ploinky'))}:/workspace/.ploinky:z,ro`));
        assert.equal(mounts.some(value => value.includes(':/workspace/.ploinky/shared:')), false);

        const cleanupMountpoints = prepareLegacyGuardMountpointCleanup({ workspaceRoot: root });
        const created = spawnSync('podman', [
            ...runtimeArgs,
            'docker.io/library/busybox:1.36', 'sh', '-lc', 'sleep 30',
        ], { encoding: 'utf8' });
        assert.equal(created.status, 0, created.stderr || created.stdout);
        cleanupMountpoints();
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'shared')), false);

        const started = spawnSync('podman', ['start', containerName], { encoding: 'utf8' });
        assert.equal(started.status, 0, started.stderr || started.stdout);
        const probe = spawnSync('podman', [
            'exec', containerName, 'sh', '-lc', [
                'test ! -e /workspace/.ploinky/shared',
                'if mkdir /workspace/.ploinky/shared 2>/tmp/shared-error; then exit 41; fi',
                'grep -qi "read-only" /tmp/shared-error',
                'test -z "$(ls -A /workspace/.ploinky/data)"',
                'if mkdir /workspace/.ploinky/data/exposed 2>/dev/null; then exit 42; fi',
                'echo MISSING_LEGACY_OPAQUE_OK',
            ].join('; '),
        ], { encoding: 'utf8' });
        assert.equal(probe.status, 0, probe.stderr || probe.stdout);
        assert.match(probe.stdout, /MISSING_LEGACY_OPAQUE_OK/);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'shared')), false);
    } finally {
        spawnSync('podman', ['rm', '-f', containerName], { stdio: 'ignore' });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('real podman guards ancestor renames while leaving project and data writes available', { skip: !hasLocalPodmanBusybox() }, () => {
    const root = fs.realpathSync(tempDir('podman-ancestor-guard-'));
    try {
        const workspaceRoot = path.join(root, 'projects', 'current');
        const controllerData = path.join(workspaceRoot, '.ploinky', 'data');
        fs.mkdirSync(controllerData, { recursive: true });
        fs.mkdirSync(path.join(workspaceRoot, '.data', 'demo'), { recursive: true });
        fs.writeFileSync(path.join(controllerData, 'sentinel'), 'controller');
        const args = ['run', '--rm', '-v', `${root}:/home:z`];
        appendLegacyAgentDataGuards(args, 'podman', { workspaceRoot });
        const result = spawnSync('podman', [...args, 'docker.io/library/busybox:1.36', 'sh', '-c', [
            'set -eu',
            'if mv /home/projects /home/moved; then exit 81; fi',
            'if mv /home/projects/current /home/projects/moved; then exit 82; fi',
            'if mv /home/projects/current/.ploinky /home/projects/current/moved; then exit 83; fi',
            'if mkdir /home/projects/current/.ploinky/shared; then exit 84; fi',
            'touch /home/projects/current/project-write /home/projects/current/.data/demo/persisted',
            'echo ANCESTOR_GUARD_OK',
        ].join('; ')], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /ANCESTOR_GUARD_OK/);
        assert.equal(fs.readFileSync(path.join(controllerData, 'sentinel'), 'utf8'), 'controller');
        assert.equal(fs.existsSync(path.join(workspaceRoot, '.ploinky', 'shared')), false);
        assert.equal(fs.existsSync(path.join(workspaceRoot, 'project-write')), true);
        assert.equal(fs.existsSync(path.join(workspaceRoot, '.data', 'demo', 'persisted')), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const parentTarget of ['/framework', '/framework/', '/framework/.', '/framework/././']) {
test(`real podman keeps legacy aliases opaque and coalesces parent bind ${parentTarget}`, { skip: !hasLocalPodmanBusybox() }, () => {
    const root = fs.realpathSync(tempDir('podman-legacy-alias-'));
    try {
        const code = path.join(root, 'code');
        fs.mkdirSync(path.join(code, 'legacy-data'), { recursive: true });
        fs.mkdirSync(path.join(root, '.ploinky'));
        fs.symlinkSync('../code/legacy-data', path.join(root, '.ploinky', 'data'));
        fs.writeFileSync(path.join(code, 'source'), 'source');
        fs.writeFileSync(path.join(code, 'legacy-data', 'sentinel'), 'controller');
        const args = [
            'run', '--rm', '-v', `${root}:/workspace:z`,
            '-v', `${path.join(root, '.ploinky')}:${parentTarget}:z`,
            '-v', `${code}:/code:z,ro`,
        ];
        appendLegacyAgentDataGuards(args, 'podman', { workspaceRoot: root });
        const mounts = args.filter((_value, index) => args[index - 1] === '-v');
        assert.equal(mounts.filter(value => value.includes(':/code:')).length, 1);
        assert.equal(mounts.filter(value => value.includes(':/framework:')).length, 1);
        assert.ok(mounts.includes(`${path.join(root, '.ploinky')}:/framework:z,ro`));
        const result = spawnSync('podman', [...args, 'docker.io/library/busybox:1.36', 'sh', '-c', [
            'set -eu',
            'test "$(cat /code/source)" = source',
            'test -z "$(ls -A /code/legacy-data)"',
            'test -z "$(ls -A /workspace/.ploinky/data)"',
            'if cat /code/legacy-data/sentinel; then exit 85; fi',
            'if touch /code/source; then exit 86; fi',
            'if mv /workspace/code /workspace/moved; then exit 87; fi',
            'if mv /workspace/.ploinky /workspace/moved; then exit 88; fi',
            'if rm /workspace/.ploinky/data; then exit 89; fi',
            'if mkdir /framework/shared; then exit 90; fi',
            'touch /workspace/project-write',
            'echo ALIAS_GUARD_OK',
        ].join('; ')], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /ALIAS_GUARD_OK/);
        assert.equal(fs.readFileSync(path.join(code, 'legacy-data', 'sentinel'), 'utf8'), 'controller');
        assert.equal(fs.lstatSync(path.join(root, '.ploinky', 'data')).isSymbolicLink(), true);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'shared')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
}

test('real docker run uses production final guards for both legacy roots', { skip: !hasLocalDockerBusybox() }, () => {
    const root = tempDir('docker-legacy-guard-');
    try {
        for (const relative of ['.ploinky/data', '.ploinky/shared']) {
            const directory = path.join(root, relative);
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'sentinel'), 'controller');
        }
        const runtimeArgs = ['run', '--rm', '-v', `${root}:/workspace`];
        appendLegacyAgentDataGuards(runtimeArgs, 'docker', { workspaceRoot: root });
        const probe = [
            'test -z "$(ls -A /workspace/.ploinky/data)"',
            'test -z "$(ls -A /workspace/.ploinky/shared)"',
            'if cat /workspace/.ploinky/data/sentinel 2>/dev/null; then exit 51; fi',
            'if cat /workspace/.ploinky/shared/sentinel 2>/dev/null; then exit 52; fi',
            'if touch /workspace/.ploinky/data/file 2>/dev/null; then exit 53; fi',
            'if touch /workspace/.ploinky/shared/file 2>/dev/null; then exit 54; fi',
            'if mkdir /workspace/.ploinky/data/dir 2>/dev/null; then exit 55; fi',
            'if mkdir /workspace/.ploinky/shared/dir 2>/dev/null; then exit 56; fi',
            'if mv /workspace/.ploinky /workspace/moved 2>/dev/null; then exit 57; fi',
            'if rm -rf /workspace/.ploinky 2>/dev/null; then exit 58; fi',
            'echo DOCKER_OPAQUE_OK',
        ].join('; ');
        const result = spawnSync('docker', [
            ...runtimeArgs,
            'docker.io/library/busybox:1.36', 'sh', '-lc', probe,
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /DOCKER_OPAQUE_OK/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

for (const projectIsControllerParent of [false, true]) {
test(`real interactive podman protects absent shared with ${projectIsControllerParent ? 'noncanonical controller-parent' : 'workspace'} bind`, { skip: !hasLocalPodmanBusybox() }, () => {
    const root = fs.realpathSync(tempDir('podman-interactive-legacy-'));
    const containerName = `ploinky_interactive_guard_${process.pid}_${Date.now()}`;
    try {
        const controllerData = path.join(root, '.ploinky', 'data');
        const homeDir = path.join(root, '.data', 'demo');
        const sharedDir = path.join(root, '.data', 'shared');
        const agentLibPath = path.join(root, 'Agent');
        const absAgentPath = path.join(root, 'agent-code');
        const grantSource = path.join(root, 'achillesAgentLib');
        for (const dir of [controllerData, homeDir, sharedDir, agentLibPath, absAgentPath, grantSource]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(path.join(controllerData, 'sentinel'), 'controller');
        const command = buildInteractiveAgentCreateCommand({
            runtime: 'podman', containerName, envHash: 'test', workspaceRoot: root,
            projectDir: projectIsControllerParent ? `${root}/.ploinky/././` : root,
            homeDir, sharedDir, agentLibPath, absAgentPath,
            volumeSuffix: ':z', readOnlySuffix: ':z,ro',
            containerImage: 'docker.io/library/busybox:1.36',
            agentLibGrant: {
                sourceDir: grantSource, runtimePath: '/opt/ploinky-agentlib',
                mode: 'local', fingerprint: 'a1'.repeat(32), commit: '',
                sourceIdHash: 'b2'.repeat(32), namespaced: true,
            },
        });
        const created = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
        assert.equal(created.status, 0, created.stderr || created.stdout);
        const started = spawnSync('podman', ['start', containerName], { encoding: 'utf8' });
        assert.equal(started.status, 0, started.stderr || started.stdout);
        const probe = spawnSync('podman', ['exec', containerName, 'sh', '-lc', [
            'set -eu',
            'test ! -e "$1/.ploinky/shared"',
            'if mkdir "$1/.ploinky/shared" 2>/dev/null; then exit 71; fi',
            'if cat "$1/.ploinky/data/sentinel" 2>/dev/null; then exit 72; fi',
            'if touch "$1/.ploinky/data/escaped" 2>/dev/null; then exit 73; fi',
            'if mv "$1/.ploinky" "$1/moved" 2>/dev/null; then exit 74; fi',
            'if rm -rf "$1/.ploinky" 2>/dev/null; then exit 75; fi',
            'touch /root/persisted',
            'echo INTERACTIVE_GUARD_OK',
        ].join('; '), 'probe', root], { encoding: 'utf8' });
        assert.equal(probe.status, 0, probe.stderr || probe.stdout);
        assert.match(probe.stdout, /INTERACTIVE_GUARD_OK/);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'shared')), false);
        assert.equal(fs.existsSync(path.join(homeDir, 'persisted')), true);
        assert.equal(fs.readFileSync(path.join(controllerData, 'sentinel'), 'utf8'), 'controller');
    } finally {
        spawnSync('podman', ['rm', '-f', '--time', '0', containerName], { stdio: 'ignore' });
        fs.rmSync(root, { recursive: true, force: true });
    }
});
}

test('persistent runtime production wiring appends guards after all writable mount families', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    assert.match(
        source,
        /for \(const \{ resolvedHostPath[\s\S]*resourcePlan\.persistentStorage[\s\S]*appendLegacyAgentDataGuards\(args, runtime\);[\s\S]*const envStrings/,
    );
});

test('real podman numeric user writes manifest :U and plain resource :z but not read-only storage', { skip: !hasLocalPodmanBusybox() }, () => {
    const root = tempDir('podman-storage-owner-');
    try {
        const manifestDir = path.join(root, 'manifest');
        const resourceDir = path.join(root, 'resource');
        const readOnlyDir = path.join(root, 'readonly');
        fs.mkdirSync(manifestDir, { mode: 0o700 });
        fs.mkdirSync(resourceDir, { mode: 0o777 });
        fs.mkdirSync(readOnlyDir, { mode: 0o777 });
        const result = spawnSync('podman', [
            'run', '--rm', '--user', '10001:10001',
            '-v', `${manifestDir}:/manifest:z,U`,
            '-v', `${resourceDir}:/resource:z`,
            '-v', `${readOnlyDir}:/readonly:z,ro`,
            'docker.io/library/busybox:1.36',
            'sh', '-lc', [
                'touch /manifest/owned',
                'touch /resource/plain',
                'if touch /readonly/blocked 2>/dev/null; then exit 41; fi',
                'echo STORAGE_OK',
            ].join('; '),
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /STORAGE_OK/);
        assert.equal(fs.existsSync(path.join(manifestDir, 'owned')), true);
        assert.equal(fs.existsSync(path.join(resourceDir, 'plain')), true);
        assert.equal(fs.existsSync(path.join(readOnlyDir, 'blocked')), false);
    } finally {
        try { fs.chmodSync(root, 0o700); } catch (_) {}
        for (const directory of ['manifest', 'resource', 'readonly']) {
            try { fs.chmodSync(path.join(root, directory), 0o700); } catch (_) {}
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
