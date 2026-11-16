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
    fs.mkdirSync(path.join(root, '.ploinky-box'), { mode: 0o700 });
    return root;
}

test('host and in-Box launch preparation does not create a private root', t => {
    for (const inside of [false, true]) {
        const root = fixture(t);
        let hostCalls = 0;
        ensureHostLaunchSkeleton(root, { insideBox: () => inside, ensureSkeleton: () => { hostCalls += 1; } });
        assert.equal(fs.existsSync(path.join(root, '.data', '.private')), false);
        assert.equal(hostCalls, inside ? 0 : 1);
    }
});

test('workspace data is masked in Podman and Bwrap plans without making the workspace read-only', t => {
    for (const runtime of ['podman', 'bwrap']) {
        const root = fixture(t);
        const args = runtime === 'podman' ? ['-v', `${root}:/workspace`] : ['--bind', root, '/workspace'];
        if (runtime === 'podman') podmanGuards(args, runtime, { workspaceRoot: root });
        else bwrapGuards(args, { workspaceRoot: root });
        const bindings = [{ hostPath: root, runtimePath: '/workspace', readOnly: false }];
        const targets = controllerGuardTargets(bindings, { workspaceRoot: root });
        const privateTarget = targets.find(entry => entry.target === '/workspace/.data');
        assert.ok(privateTarget, runtime);
        const mounts = controllerGuardMounts(targets, { workspaceRoot: root, bindings });
        assert.ok(mounts.some(entry => entry.target === privateTarget.target && entry.readOnly));
        assert.ok(!mounts.some(entry => entry.target === '/workspace' && entry.readOnly));
        assert.ok(args.some(value => value.includes('/workspace/.data')));
    }
});

test('missing workspace data root is an error rather than a read-only parent fallback', t => {
    const root = fixture(t);
    assert.ok(protectedControllerStateRoots(root).some(entry => entry.hostPath === path.join(root, '.data')));
    assert.throws(() => controllerGuardTargets([{ hostPath: root, runtimePath: '/workspace' }], { workspaceRoot: root }),
        /workspace data.*missing/);
});

test('Seatbelt denies reading and writing workspace data through a workspace grant', t => {
    const root = fixture(t);
    const profile = buildSeatbeltProfile({
        workspaceRoot: root,
        agentCodePath: path.join(root, 'code'),
        agentLibPath: path.join(root, 'Agent'),
        nodeModulesDir: path.join(root, 'node_modules'),
        sharedDir: path.join(root, '.data', 'agents', 'shared'),
        cwd: root,
        codeReadOnly: true,
        skillsReadOnly: true,
        agentLibGrant: { sourceDir: path.join(root, 'agentlib') },
    });
    for (const operation of ['file-read*', 'file-write*']) {
        const denial = profile.split(`(deny ${operation}`).slice(1);
        assert.ok(denial.some(block => block.split('\n)')[0].includes(`(subpath "${root}/.data")`)));
    }
});

test('explicit robots storage is admitted and stays unmasked at /data', t => {
    const root = fixture(t);
    ensureHostLaunchSkeleton(root, { insideBox: () => true });
    const own = path.join(root, '.data', 'robots');
    const options = { workspaceRoot: root, agentName: 'demo' };
    assert.equal(assertManifestVolumeStoragePolicy(own, options), own);
    assert.equal(resolveManifestVolumeHostPath(own, root, { agentName: 'demo' }), own);
    ensureManifestVolumeHostPath(own, '/data', {}, options);
    const bindings = [{ hostPath: root, runtimePath: '/workspace' }, { hostPath: own, runtimePath: '/data' }];
    const targets = controllerGuardTargets(bindings, options);
    assert.ok(targets.some(entry => entry.target === '/workspace/.data'));
    assert.ok(!targets.some(entry => entry.target === '/data'));
    for (const runtime of ['podman', 'bwrap']) {
        const args = runtime === 'podman'
            ? ['-v', `${root}:/workspace`, '-v', `${own}:/data`]
            : ['--bind', root, '/workspace', '--bind', own, '/data'];
        if (runtime === 'podman') podmanGuards(args, runtime, options);
        else bwrapGuards(args, options);
        assert.ok(args.some(value => value.includes('/workspace/.data')));
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
    assert.equal(assertManifestVolumeStoragePolicy('alias', options), path.join(root, 'alias'));
});

test('workspace data guard rejects symlinks and files', t => {
    const root = fixture(t);
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const dataRoot = path.join(root, '.data');
    fs.symlinkSync(elsewhere, dataRoot);
    const bindings = [{ hostPath: root, runtimePath: '/workspace' }];
    assert.throws(() => controllerGuardTargets(bindings, { workspaceRoot: root }), /symlink/);
    fs.unlinkSync(dataRoot);
    fs.writeFileSync(dataRoot, 'file');
    assert.throws(() => controllerGuardTargets(bindings, { workspaceRoot: root }), /real directory/);
});
