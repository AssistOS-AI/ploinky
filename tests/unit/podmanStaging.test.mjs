import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
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
} from '../../cli/services/docker/agentServiceManager.js';
import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../../cli/services/config.js';
import { resolveManifestVolumeHostPath } from '../../cli/services/manifestVolumePolicy.js';
import {
    prepareFreshRuntimeRoot,
    pruneStaleRuntimeEntries,
} from '../../cli/services/runtimeStaging.js';

function tempDir(prefix = 'podman-staging-') {
    return path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function hasLocalPodmanBusybox() {
    const podman = spawnSync('podman', ['--version'], { stdio: 'ignore' });
    if (podman.status !== 0) return false;
    const image = spawnSync('podman', ['image', 'exists', 'docker.io/library/busybox:1.36'], { stdio: 'ignore' });
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
            '.ploinky/data/root-state': '/root-state',
        },
        volumeOptions: {
            '/root-state': { readOnly: true },
            '/data': { podmanChown: false },
        },
    }, {
        volumes: {
            '.ploinky/data/web-publishing': '/data',
        },
        volumeOptions: {
            '/data': { podmanChown: true },
        },
    });

    assert.deepEqual(entries, [
        {
            hostPath: '.ploinky/data/root-state',
            containerPath: '/root-state',
            resolvedHostPath: path.join(PLOINKY_DIR, 'data', 'root-state'),
            options: { readOnly: true },
        },
        {
            hostPath: '.ploinky/data/web-publishing',
            containerPath: '/data',
            resolvedHostPath: path.join(PLOINKY_DIR, 'data', 'web-publishing'),
            options: { podmanChown: true },
        },
    ]);
});

test('podman manifest data volumes chown only managed writable data mounts by default', () => {
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(PLOINKY_DIR, 'data', 'web-publishing'), {}),
        ':z,U',
    );
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(PLOINKY_WORKSPACE_ROOT, 'workspace-data'), {}),
        ':z',
    );
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(PLOINKY_DIR, 'data', 'readonly'), { readOnly: true }),
        ':z,ro',
    );
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(PLOINKY_DIR, 'data', 'optout'), { podmanChown: false }),
        ':z',
    );
    assert.equal(
        podmanManifestVolumeMountSuffix(path.join(os.tmpdir(), 'explicit-podman-volume'), { podmanChown: true }),
        ':z,U',
    );
});

test('read-only manifest volumes are enforced across container runtimes', () => {
    const hostPath = path.join(PLOINKY_DIR, 'data', 'readonly');
    assert.equal(manifestVolumeMountSuffix('podman', hostPath, { readOnly: true }), ':z,ro');
    assert.equal(manifestVolumeMountSuffix('docker', hostPath, { readOnly: true }), ':ro');
    assert.equal(manifestVolumeMountSuffix('docker', hostPath, {}), '');
});

test('manifest volume host paths may resolve outside workspace .ploinky', () => {
    assert.equal(
        resolveManifestVolumeHostPath('.ploinky/data/demo/state'),
        path.join(PLOINKY_DIR, 'data', 'demo', 'state'),
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
