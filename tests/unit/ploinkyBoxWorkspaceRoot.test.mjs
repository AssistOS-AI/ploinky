import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EDGE_TOPOLOGY_CONTAINER_DIR } from '../../cli/sandbox/edgeGeneration.js';
import { PROBE_CONTROL_CONTAINER_ROOT } from '../../cli/sandbox/docker/healthProbes.js';
import { AGENTLIB_STABLE_MOUNT_PATH } from '../../agentlib/contract.mjs';
import { PloinkyBoxError } from '../../ploinky-box/errors.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    BOX_RESERVED_PARENTS,
    BOX_RESERVED_SUBTREES,
    BOX_WORKSPACE_ROOT_ENV,
    BOX_WORKSPACE_ROOT_MAX_BYTES,
    assertBoxWorkspaceRoot,
    boxWorkspaceEnvironment,
    boxWorkspaceExecOptions,
    boxWorkspaceMount,
    boxWorkspacePath,
    boxWorkspaceRootProblem,
    boxWorkspaceVolume,
    readBoxWorkspaceRoot,
    relativeBoxWorkspacePath,
} from '../../ploinky-box/contract/workspace-root.mjs';

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-workspace-root-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function assertRejected(value, pattern) {
    assert.throws(() => assertBoxWorkspaceRoot(value), (error) => {
        assert.ok(error instanceof PloinkyBoxError);
        assert.equal(error.code, 'PLOINKY_BOX_WORKSPACE_ROOT_INVALID');
        assert.match(error.message, pattern);
        return true;
    }, `expected ${JSON.stringify(value)} to be rejected`);
}

test('ordinary host workspace paths are admitted unchanged', () => {
    for (const root of [
        '/home/skutner/work/project',
        '/workspace',
        '/tmp/ploinky-fixture-abc123',
        '/var/tmp/project',
        '/var/home/user/project',
        '/run/media/user/disk/project',
        '/home/podman/work/project',
        '/home/podman/.local/share/other-project',
        '/opt/project',
        '/opt/ploinky-work',
        '/opt/ploinky-agentlib-work',
        '/tmp/storage-run-10000',
        '/etcetera/project',
        '/srv/project',
        '/mnt/data/project',
    ]) {
        assert.equal(boxWorkspaceRootProblem(root), null, root);
        assert.equal(assertBoxWorkspaceRoot(root), root);
    }
});

test('spaces, Unicode, and shell metacharacters are carried as literal path text', () => {
    for (const root of [
        '/home/user/my project',
        '/home/user/proiect-ăîș/文档',
        "/home/user/$(touch pwned);'\"&|*?[]{}<>!#~`=",
        '/home/user/project,comma',
        '/home/user/tab-free leading and inner  spaces',
    ]) {
        assert.equal(assertBoxWorkspaceRoot(root), root);
        assert.deepEqual(boxWorkspaceMount(root), { source: root, destination: root, rw: true });
        assert.equal(boxWorkspaceVolume(root), `${root}:${root}`);
        assert.deepEqual(boxWorkspaceExecOptions(root), ['--workdir', root]);
        assert.deepEqual(boxWorkspaceEnvironment(root), { [BOX_WORKSPACE_ROOT_ENV]: root });
    }
});

test('malformed, unclean, and unmountable spellings fail with a precise diagnostic', () => {
    assertRejected('', /path is empty/);
    assertRejected(undefined, /path is empty/);
    assertRejected(42, /path is empty/);
    assertRejected('home/user/project', /not absolute/);
    assertRejected('./project', /not absolute/);
    assertRejected('/', /replace the Box root filesystem/);
    assertRejected('/home/user/project/', /clean absolute form/);
    assertRejected('//home/user/project', /clean absolute form/);
    assertRejected('/home/./user/project', /clean absolute form/);
    assertRejected('/home/user/../other/project', /clean absolute form/);
    assertRejected('/home/user/project ', /ends with whitespace/);
    assertRejected('/home/user/pro:ject', /contains ':'/);
    assertRejected('/home/user/back\\slash', /contains a backslash/);
    assertRejected('/home/user/pro\nject', /control character/);
    assertRejected('/home/user/pro\tject', /control character/);
    assertRejected('/home/user/pro\u007fject', /control character/);
    assertRejected('/home/user/pro\0ject', /control character/);
    assertRejected('/home/user/\uD800project', /well-formed Unicode/);
    assertRejected(`/${'a'.repeat(BOX_WORKSPACE_ROOT_MAX_BYTES)}`, /longer than 4095 bytes/);
    assert.throws(() => assertBoxWorkspaceRoot('/home/user/pro:ject'),
        /"\/home\/user\/pro:ject".*select a workspace directory/);
});

test('roots that replace, contain, or sit inside Box-owned locations are rejected', () => {
    for (const reserved of BOX_RESERVED_SUBTREES) {
        assertRejected(reserved, /overlaps the Box-owned location/);
        assertRejected(`${reserved}/project`, /overlaps the Box-owned location/);
        assertRejected(path.posix.dirname(reserved), /overlaps the Box-owned location|replace or contain|replace the Box root/);
    }
    for (const reserved of BOX_RESERVED_PARENTS) {
        assertRejected(reserved, /replace or contain the Box-owned directory|overlaps the Box-owned location/);
    }
    for (const root of [
        '/usr/src/project',
        '/opt/ploinky/node_modules/cache',
        '/opt/ploinky-agentlib',
        '/proc/self',
        '/dev/shm/project',
        '/etc/project',
        '/run/ploinky',
        '/tmp/podman-run-1000/project',
        '/home/podman/.local/share/ploinky-images/project',
        '/home/podman/.local/share/containers/storage',
        '/home/podman/.config/containers',
        '/home/podman/.config',
        '/home/podman',
        '/home',
        '/opt',
        '/run',
        '/tmp',
        '/var',
        '/var/tmp',
    ]) {
        assert.notEqual(boxWorkspaceRootProblem(root), null, root);
    }
});

test('the reserved set covers the Box mounts and runtime paths it must protect', () => {
    for (const location of [
        '/opt/ploinky',
        '/opt/ploinky/node_modules',
        '/opt/ploinky-agentlib',
        '/home/podman/.local/share/ploinky-images',
        '/home/podman/.local/share/containers/storage',
        '/home/podman/.config/containers/storage.conf',
        '/home/podman/.config/containers/containers.conf',
        '/run/ploinky/box-transport.json',
        '/run/ploinky/router-health.sock',
        '/etc/ploinky-box',
        '/usr/local/bin/ploinky-box-entrypoint',
        '/tmp/storage-run-1000',
        '/tmp/podman-run-1000',
    ]) {
        assert.ok(BOX_RESERVED_SUBTREES.some((reserved) => (
            location === reserved || location.startsWith(`${reserved}/`)
        )), location);
    }
    assert.ok(BOX_RESERVED_PARENTS.includes('/tmp'));
});

test('nested agent grants that receive the same-path workspace are protected from it', () => {
    const covered = (location) => BOX_RESERVED_SUBTREES.some((reserved) => (
        location === reserved || location.startsWith(`${reserved}/`)
    ));
    for (const location of [
        '/Agent',
        '/Agent/node_modules',
        '/Agent/linked/Library',
        '/Agent/llm-runtime',
        '/code',
        '/code/node_modules',
        '/code/mcp-config.json',
        '/shared',
        '/models',
        '/runtime',
        '/root',
        '/home/agent',
        PROBE_CONTROL_CONTAINER_ROOT,
        EDGE_TOPOLOGY_CONTAINER_DIR,
        AGENTLIB_STABLE_MOUNT_PATH,
    ]) {
        assert.ok(covered(location), location);
    }
    for (const root of ['/Agent/lib', '/code/project', '/shared', '/root/project', '/home/agent/work', '/models/cache']) {
        assert.match(boxWorkspaceRootProblem(root), /Box-owned location/, root);
    }
    for (const root of ['/Agents/project', '/codebase/project', '/home/agent-work/project', '/run/media/user/project']) {
        assert.equal(boxWorkspaceRootProblem(root), null, root);
    }
});

test('in-Box readers require the exact reserved environment value', () => {
    assert.equal(readBoxWorkspaceRoot({ PLOINKY_WORKSPACE_ROOT: '/home/user/project' }), '/home/user/project');
    for (const env of [{}, { PLOINKY_WORKSPACE_ROOT: '' }, null, undefined]) {
        assert.throws(() => readBoxWorkspaceRoot(env ?? {}), (error) => (
            error.code === 'PLOINKY_BOX_WORKSPACE_ROOT_MISSING'
            && /PLOINKY_WORKSPACE_ROOT is not set/.test(error.message)
        ));
    }
    // A trailing space is never trimmed into a different directory.
    assert.throws(() => readBoxWorkspaceRoot({ PLOINKY_WORKSPACE_ROOT: '/home/user/project ' }),
        (error) => error.code === 'PLOINKY_BOX_WORKSPACE_ROOT_INVALID');
    assert.throws(() => readBoxWorkspaceRoot({ PLOINKY_WORKSPACE_ROOT: 'relative' }),
        /PLOINKY_WORKSPACE_ROOT "relative"/);
});

test('workspace-relative joins stay inside each independent root', () => {
    const first = '/home/user/project';
    const second = '/home/user/project-other';
    assert.equal(boxWorkspacePath(first), first);
    assert.equal(boxWorkspacePath(first, ''), first);
    assert.equal(boxWorkspacePath(first, 'repo with spaces/sub'), '/home/user/project/repo with spaces/sub');
    assert.equal(boxWorkspacePath(second, 'repo'), '/home/user/project-other/repo');
    assert.equal(relativeBoxWorkspacePath(first, first), '');
    assert.equal(relativeBoxWorkspacePath(first, '/home/user/project/repo/sub'), 'repo/sub');
    assert.equal(relativeBoxWorkspacePath(second, '/home/user/project-other/repo'), 'repo');
    for (const relative of ['..', '../project-other', 'repo/../../etc', '/etc', 'repo//sub', './repo', 'repo/.', 'repo/\0']) {
        assert.throws(() => boxWorkspacePath(first, relative), (error) => (
            error.code === 'PLOINKY_BOX_WORKSPACE_PATH_INVALID'
        ), relative);
    }
    for (const candidate of [
        '/home/user/project-other/repo',
        '/home/user/projectx',
        '/home/user',
        '/home/user/project/../project-other',
        '/home/user/project/repo/',
        'relative/path',
    ]) {
        assert.throws(() => relativeBoxWorkspacePath(first, candidate), (error) => (
            error.code === 'PLOINKY_BOX_WORKSPACE_PATH_INVALID'
        ), candidate);
    }
    assert.throws(() => boxWorkspacePath('/etc', 'x'), /overlaps the Box-owned location/);
});

test('a symlink-selected workspace keeps its selected spelling as the mount destination', (t) => {
    const root = fixture(t);
    const target = path.join(root, 'real project');
    const selected = path.join(root, 'selected link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, selected, 'dir');
    const identity = buildWorkspaceIdentity(selected);
    assert.equal(identity.workspaceRoot, selected);
    assert.notEqual(fs.realpathSync(selected), selected);
    assert.deepEqual(boxWorkspaceMount(identity.workspaceRoot), {
        source: selected,
        destination: selected,
        rw: true,
    });
    const other = buildWorkspaceIdentity(target);
    assert.notEqual(other.pathHash, identity.pathHash);
    assert.equal(boxWorkspaceMount(other.workspaceRoot).destination, target);
});

test('a temporary fixture directory is an ordinary admissible root', (t) => {
    const root = fixture(t);
    assert.equal(assertBoxWorkspaceRoot(root), root);
    assert.equal(boxWorkspacePath(root, 'nested'), path.join(root, 'nested'));
});

test('importing the contract has no filesystem or environment side effects', async () => {
    const before = { ...process.env };
    const module = await import(`../../ploinky-box/contract/workspace-root.mjs?fresh=${Date.now()}`);
    assert.equal(typeof module.assertBoxWorkspaceRoot, 'function');
    assert.equal(JSON.stringify({ ...process.env }), JSON.stringify(before));
});
