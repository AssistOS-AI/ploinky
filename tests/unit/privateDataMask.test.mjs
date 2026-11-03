import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureHostLaunchSkeleton } from '../../cli/sandbox/hostLaunchExclusion.js';
import { appendControllerStateGuards as podmanGuards } from '../../cli/sandbox/docker/agentServiceManager.js';
import { appendControllerStateGuards as bwrapGuards } from '../../cli/sandbox/bwrap/bwrapServiceManager.js';
import { protectedControllerStateRoots, controllerGuardTargets, controllerGuardMounts } from '../../cli/utils/runtime/controllerStateGuards.js';
import { assertManifestVolumeStoragePolicy } from '../../cli/utils/runtime/agentDataPathPolicy.js';
import { resolveManifestVolumeHostPath, ensureManifestVolumeHostPath } from '../../cli/utils/runtime/manifestVolumePolicy.js';
import { buildSeatbeltProfile } from '../../cli/sandbox/seatbelt/seatbeltProfile.js';

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'private-data-mask-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky-box'));
    return root;
}

test('host and in-Box launch preparation creates the private root with mode 0700', t => {
    for (const inside of [false, true]) {
        const root = fixture(t);
        let hostCalls = 0;
        ensureHostLaunchSkeleton(root, { insideBox: () => inside, ensureSkeleton: () => { hostCalls += 1; } });
        const stat = fs.lstatSync(path.join(root, '.data', '.private'));
        assert.ok(stat.isDirectory());
        assert.equal(stat.mode & 0o777, 0o700);
        assert.equal(hostCalls, inside ? 0 : 1);
        ensureHostLaunchSkeleton(root, { insideBox: () => inside, ensureSkeleton: () => {} });
        assert.equal(fs.statSync(path.join(root, '.data', '.private')).ino, stat.ino);
    }
});

test('private root is masked in Podman and Bwrap plans without making .data read-only', t => {
    for (const runtime of ['podman', 'bwrap']) {
        const root = fixture(t);
        const args = runtime === 'podman' ? ['-v', `${root}:/workspace`] : ['--bind', root, '/workspace'];
        if (runtime === 'podman') podmanGuards(args, runtime, { workspaceRoot: root });
        else bwrapGuards(args, { workspaceRoot: root });
        const bindings = [{ hostPath: root, runtimePath: '/workspace', readOnly: false }];
        const targets = controllerGuardTargets(bindings, { workspaceRoot: root });
        const privateTarget = targets.find(entry => entry.target === '/workspace/.data/.private');
        assert.ok(privateTarget, runtime);
        const mounts = controllerGuardMounts(targets, { workspaceRoot: root, bindings });
        assert.ok(mounts.some(entry => entry.target === privateTarget.target && entry.readOnly));
        assert.ok(!mounts.some(entry => entry.target === '/workspace/.data' && entry.readOnly));
        assert.ok(args.some(value => value.includes('/workspace/.data/.private')));
    }
});

test('missing private root is an error rather than a read-only parent fallback', t => {
    const root = fixture(t);
    assert.ok(protectedControllerStateRoots(root).some(entry => entry.hostPath === path.join(root, '.data', '.private')));
    assert.throws(() => controllerGuardTargets([{ hostPath: root, runtimePath: '/workspace' }], { workspaceRoot: root }),
        /private.*missing|missing.*private/);
});

test('Seatbelt denies reading and writing private data through a workspace grant', t => {
    const root = fixture(t);
    const profile = buildSeatbeltProfile({
        workspaceRoot: root,
        agentCodePath: path.join(root, 'code'),
        agentLibPath: path.join(root, 'Agent'),
        nodeModulesDir: path.join(root, 'node_modules'),
        sharedDir: path.join(root, '.data', 'shared'),
        cwd: root,
        codeReadOnly: true,
        skillsReadOnly: true,
        agentLibGrant: { sourceDir: path.join(root, 'agentlib') },
    });
    for (const operation of ['file-read*', 'file-write*']) {
        const denial = profile.split(`(deny ${operation}`).slice(1);
        assert.ok(denial.some(block => block.split('\n)')[0].includes(`(subpath "${root}/.data/.private")`)));
    }
});

test('only the exact owning agent directory is admitted and stays unmasked at /data', t => {
    const root = fixture(t);
    ensureHostLaunchSkeleton(root, { insideBox: () => true });
    const own = path.join(root, '.data', '.private', 'demo');
    const options = { workspaceRoot: root, agentName: 'demo' };
    assert.equal(assertManifestVolumeStoragePolicy(own, options), own);
    assert.equal(resolveManifestVolumeHostPath(own, root, { agentName: 'demo' }), own);
    ensureManifestVolumeHostPath(own, '/data', {}, options);
    for (const source of [path.dirname(own), `${own}/nested`, path.join(path.dirname(own), 'other')]) {
        assert.throws(() => assertManifestVolumeStoragePolicy(source, options));
        assert.throws(() => controllerGuardTargets([{ hostPath: source, runtimePath: '/data' }], options));
    }
    assert.throws(() => assertManifestVolumeStoragePolicy(own, { workspaceRoot: root }));
    const bindings = [{ hostPath: root, runtimePath: '/workspace' }, { hostPath: own, runtimePath: '/data' }];
    const targets = controllerGuardTargets(bindings, options);
    assert.ok(targets.some(entry => entry.target === '/workspace/.data/.private'));
    assert.ok(!targets.some(entry => entry.target === '/data'));
    for (const runtime of ['podman', 'bwrap']) {
        const args = runtime === 'podman'
            ? ['-v', `${root}:/workspace`, '-v', `${own}:/data`]
            : ['--bind', root, '/workspace', '--bind', own, '/data'];
        if (runtime === 'podman') podmanGuards(args, runtime, options);
        else bwrapGuards(args, options);
        assert.ok(args.some(value => value.includes('/workspace/.data/.private')));
        if (runtime === 'podman') {
            assert.equal(args.filter(value => value.startsWith(`${own}:/data`)).length, 1);
            assert.ok(!args.some(value => value.includes('runtime-guards') && value.endsWith(':/data:z,ro')));
        } else {
            const index = args.indexOf('/data');
            assert.equal(args[index - 1], own);
            assert.equal(args[index - 2], '--bind');
        }
    }
    fs.symlinkSync(own, path.join(root, 'alias'));
    assert.throws(() => assertManifestVolumeStoragePolicy('alias', options));
});

test('private root preparation rejects a symlink and guard planning rejects a file', t => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, '.data'));
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const privateRoot = path.join(root, '.data', '.private');
    fs.symlinkSync(elsewhere, privateRoot);
    assert.throws(() => ensureHostLaunchSkeleton(root, { insideBox: () => true }), /symlink/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.unlinkSync(privateRoot);
    fs.writeFileSync(privateRoot, 'file');
    assert.throws(() => controllerGuardTargets([{ hostPath: root, runtimePath: '/workspace' }], { workspaceRoot: root }),
        /real directory/);
});
