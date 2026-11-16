import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildBwrapArgs } from '../../cli/sandbox/bwrap/bwrapServiceManager.js';
import { AGENTLIB_STABLE_MOUNT_PATH } from '../../agentlib/contract.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';
import {
    CODE_DIR, DEPS_DIR, PLOINKY_DIR, PROFILE_FILE, ROUTING_FILE, SERVERS_CONFIG_FILE,
} from '../../cli/utils/config.js';

function hasUsableBwrap() {
    const probe = spawnSync('bwrap', [
        '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '/bin/true',
    ], { stdio: 'ignore' });
    return probe.status === 0;
}

function grantFor(root) {
    const contract = agentLibFixture(root);
    return {
        sourceDir: contract.sourceDir,
        runtimePath: AGENTLIB_STABLE_MOUNT_PATH,
        mode: contract.mode,
        fingerprint: contract.fingerprint,
        commit: '',
        sourceIdHash: contract.sourceIdHash,
        namespaced: true,
    };
}

function mounts(args) {
    const found = [];
    for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === '--bind' || args[index] === '--ro-bind') {
            found.push({ index, readOnly: args[index] === '--ro-bind', source: args[index + 1], target: args[index + 2] });
            index += 2;
        }
    }
    return found;
}

function setenvValues(args, name) {
    const values = [];
    for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === '--setenv' && args[index + 1] === name) values.push(args[index + 2]);
    }
    return values;
}

function fixture(prefix) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    const agentCodePath = path.join(root, '.ploinky', 'repos', 'repo', 'agent');
    const nodeModulesDir = path.join(root, '.ploinky', 'deps', 'store', 'objects', '11111111-2222-4333-8444-555555555555', 'payload', 'node_modules');
    const sharedDir = path.join(root, '.data', 'agents', 'shared');
    const agentLibPath = path.join(root, 'Agent');
    const agentHomeDir = path.join(root, '.data', 'agents', 'lifecycle');
    for (const dir of [
        agentCodePath, nodeModulesDir, sharedDir, path.join(agentLibPath, 'node_modules'),
        agentHomeDir, path.join(root, '.ploinky', 'data'),
    ]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(root, '.ploinky', 'controller-sentinel'), 'controller');
    fs.writeFileSync(path.join(root, '.ploinky', 'data', 'sentinel'), 'controller');
    fs.writeFileSync(path.join(root, 'workspace-marker'), 'workspace');
    fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), 'routing');
    return { root, agentCodePath, nodeModulesDir, sharedDir, agentLibPath, agentHomeDir };
}

function argsFor(layout, overrides = {}) {
    return buildBwrapArgs({
        workspaceRoot: layout.root,
        agentCodePath: layout.agentCodePath,
        agentLibGrant: grantFor(layout.root),
        agentLibPath: layout.agentLibPath,
        nodeModulesDir: layout.nodeModulesDir,
        sharedDir: layout.sharedDir,
        skillsPath: null,
        envMap: {},
        codeReadOnly: true,
        skillsReadOnly: true,
        volumes: {},
        ...overrides,
    });
}

test('static workspace keeps its host path and private HOME at /root', () => {
    const layout = fixture('bwrap-static-home-');
    try {
        const args = argsFor(layout, { cwd: layout.root, cwdMountTarget: '/root', agentHomeDir: layout.agentHomeDir });
        const all = mounts(args);
        assert.deepEqual(all.filter(m => m.target === '/root').map(m => [m.source, m.readOnly]), [[layout.agentHomeDir, false]]);
        assert.deepEqual(all.filter(m => m.target === layout.root).map(m => [m.source, m.readOnly]), [[layout.root, false]]);
        assert.deepEqual(setenvValues(args, 'HOME'), ['/root']);
    } finally { fs.rmSync(layout.root, { recursive: true, force: true }); }
});

test('static isolated bwrap agent keeps the controller guards under the /root workspace bind', () => {
    const layout = fixture('bwrap-static-guards-');
    try {
        const args = argsFor(layout, {
            cwd: layout.root,
            cwdMountTarget: '/root',
            agentHomeDir: layout.agentHomeDir,
        });
        const all = mounts(args);
        const controller = all.filter(mount => mount.target === `${layout.root}/.ploinky`);
        assert.equal(controller.length, 1);
        assert.deepEqual([controller[0].readOnly, controller[0].source], [true, path.join(layout.root, '.ploinky')]);

        const state = all.filter(mount => mount.target === `${layout.root}/.ploinky/data`);
        assert.equal(state.length, 1);
        assert.equal(state[0].readOnly, true);
        assert.notEqual(state[0].source, path.join(layout.root, '.ploinky', 'data'),
            'controller state is masked by an empty guard, not exposed');
        assert.ok(state[0].index > controller[0].index, 'the state mask follows the controller parent pin');
        assert.ok(state[0].index > all.find(mount => mount.target === layout.root).index,
            'the guards follow the workspace bind');

        assert.equal(all.some(mount => mount.target.startsWith('/home/agent/.ploinky')), false);
        // The selected AgentLib source lives inside the workspace; its writable
        // alias under /root must be shadowed read-only after the workspace bind.
        const grant = grantFor(layout.root);
        const shadow = all.find(mount => mount.target === `${layout.root}/achillesAgentLib`);
        assert.ok(shadow, 'the AgentLib alias under /root is shadowed');
        assert.deepEqual([shadow.readOnly, shadow.source], [true, grant.sourceDir]);
        assert.ok(shadow.index > all.find(mount => mount.target === layout.root).index);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('normal isolated bwrap agent keeps one /root home bind and HOME=/root', () => {
    const layout = fixture('bwrap-isolated-home-');
    try {
        const args = argsFor(layout, {
            cwd: layout.agentHomeDir,
            cwdMountTarget: '/root',
            agentHomeDir: layout.agentHomeDir,
            envMap: { HOME: '/root' },
        });
        const all = mounts(args);
        const atRoot = all.filter(mount => mount.target === '/root');
        assert.equal(atRoot.length, 1);
        assert.deepEqual([atRoot[0].readOnly, atRoot[0].source], [false, layout.agentHomeDir]);
        assert.equal(all.some(mount => mount.target === '/home/agent'), false);
        assert.equal(args.includes('/home/agent'), false);
        assert.deepEqual(setenvValues(args, 'HOME'), ['/root']);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('global bwrap agent keeps its host-path project bind and the /root home bind', () => {
    const layout = fixture('bwrap-global-home-');
    try {
        const args = argsFor(layout, {
            cwd: layout.root,
            agentHomeDir: layout.agentHomeDir,
            envMap: { HOME: '/root' },
        });
        const all = mounts(args);
        assert.deepEqual(all.filter(mount => mount.target === layout.root).map(mount => mount.source), [layout.root]);
        assert.deepEqual(all.filter(mount => mount.target === '/root').map(mount => mount.source), [layout.agentHomeDir]);
        assert.equal(all.some(mount => mount.target === '/home/agent'), false);
        assert.deepEqual(setenvValues(args, 'HOME'), ['/root']);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('real bwrap static layout shows the workspace at /root and a writable HOME', { skip: !hasUsableBwrap() }, () => {
    const layout = fixture('bwrap-static-live-');
    try {
        const args = argsFor(layout, {
            cwd: layout.root,
            cwdMountTarget: '/root',
            agentHomeDir: layout.agentHomeDir,
        });
        const probe = [
            'set -eu',
            'test "$HOME" = /root',
            `test "$(cat ${layout.root}/workspace-marker)" = workspace`,
            `test "$(cat ${layout.root}/.ploinky/controller-sentinel)" = controller`,
            `test -z "$(ls -A ${layout.root}/.ploinky/data)"`,
            `if touch ${layout.root}/.ploinky/escaped 2>/dev/null; then exit 74; fi`,
            `if touch ${layout.root}/.ploinky/data/escaped 2>/dev/null; then exit 75; fi`,
            `if echo changed > ${layout.root}/.ploinky/routing.json 2>/dev/null; then exit 76; fi`,
            `if rm -f ${layout.root}/.ploinky/routing.json 2>/dev/null; then exit 77; fi`,
            `test "$(cat ${layout.root}/.ploinky/routing.json)" = routing`,
            'touch "$HOME/persisted"',
            `test -f ${layout.root}/.data/agents/lifecycle/persisted`,
            `touch ${layout.root}/project-write`,
            'echo BWRAP_STATIC_HOME_OK',
        ].join('; ');
        const result = spawnSync('bwrap', [...args, '/bin/sh', '-c', probe], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /BWRAP_STATIC_HOME_OK/);
        assert.equal(fs.existsSync(path.join(layout.agentHomeDir, 'persisted')), true);
        assert.equal(fs.existsSync(path.join(layout.root, 'project-write')), true);
        assert.equal(fs.existsSync(path.join(layout.root, '.ploinky', 'escaped')), false);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('an isolated agent whose project is another instance\'s data is refused', () => {
    const layout = fixture('bwrap-foreign-home-');
    try {
        const foreign = path.join(layout.root, '.data', 'agents', 'lifecycle2');
        fs.mkdirSync(foreign, { recursive: true });
        assert.throws(() => argsFor(layout, {
            cwd: foreign, cwdMountTarget: '/root', agentHomeDir: layout.agentHomeDir,
        }), /neither the agent home .* nor the workspace root/);
        // Its own home, and the workspace for the static agent, stay valid.
        argsFor(layout, { cwd: layout.agentHomeDir, cwdMountTarget: '/root', agentHomeDir: layout.agentHomeDir });
        argsFor(layout, { cwd: layout.root, cwdMountTarget: '/root', agentHomeDir: layout.agentHomeDir });
        // Non-isolated agents keep their own project directory at its host path.
        argsFor(layout, { cwd: foreign, agentHomeDir: layout.agentHomeDir });
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

// The static agent sees the workspace at /root, so a protective overlay must
// be placed at the in-sandbox path. A host-absolute destination protects
// nothing there and is created as a stray entry (through the writable /root
// bind when the host workspace itself lives below /root).
test('static agent overlays protect the /root paths, never host-absolute destinations', () => {
    const layout = fixture('bwrap-static-overlays-');
    try {
        // Source outside .ploinky: only an in-sandbox overlay can protect it.
        const localCode = path.join(layout.root, 'agents', 'local', 'code');
        fs.mkdirSync(localCode, { recursive: true });
        const args = argsFor(layout, {
            cwd: layout.root, cwdMountTarget: '/root', agentHomeDir: layout.agentHomeDir, agentCodePath: localCode,
        });
        const all = mounts(args);
        assert.ok(all.some(mount => mount.target === layout.root), 'workspace stays at its host path');
        const overlay = all.find(mount => mount.source === localCode && mount.target !== '/code');
        assert.deepEqual([overlay.readOnly, overlay.target], [true, `${layout.root}/agents/local/code`]);
        assert.ok(overlay.index > all.find(mount => mount.target === layout.root).index);
        // The dependency payload parent is covered the same way.
        const payload = path.dirname(layout.nodeModulesDir);
        const dependency = all.find(mount => mount.source === payload);
        assert.deepEqual([dependency.readOnly, dependency.target],
            [true, `${layout.root}/${path.relative(layout.root, payload).split(path.sep).join('/')}`]);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('global agent overlays keep their host-absolute destinations', () => {
    const layout = fixture('bwrap-global-overlays-');
    try {
        const args = argsFor(layout, { cwd: layout.root, agentHomeDir: layout.agentHomeDir });
        const payload = path.dirname(layout.nodeModulesDir);
        const overlay = mounts(args).find(mount => mount.source === payload && mount.target === payload);
        assert.equal(overlay.readOnly, true);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

// Every fixed overlay path is controller state below .ploinky, which the
// static layout already pins read-only at /root/.ploinky.
test('the fixed protected workspace paths all live under the pinned controller root', () => {
    for (const protectedPath of [DEPS_DIR, CODE_DIR, PROFILE_FILE, ROUTING_FILE, SERVERS_CONFIG_FILE,
        path.join(PLOINKY_DIR, 'seatbelt-runtime')]) {
        assert.ok(protectedPath.startsWith(`${PLOINKY_DIR}${path.sep}`), `${protectedPath} is under ${PLOINKY_DIR}`);
    }
});

// For a start-only agent the dependency fallback lives in the home directory,
// so the "parent of node_modules" overlay is the home itself. Remapped to the
// project target it must not turn the agent's writable /root read-only.
test('an isolated start-only agent keeps a writable /root home', () => {
    const layout = fixture('bwrap-startonly-home-');
    try {
        const nodeModulesDir = path.join(layout.agentHomeDir, 'node_modules');
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        const args = argsFor(layout, {
            cwd: layout.agentHomeDir, cwdMountTarget: '/root', agentHomeDir: layout.agentHomeDir, nodeModulesDir,
        });
        const atRoot = mounts(args).filter(mount => mount.target === '/root');
        assert.deepEqual(atRoot.map(({ readOnly, source }) => [readOnly, source]), [[false, layout.agentHomeDir]]);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('explicit /root volume replaces the implicit home and grants the data root only at its declared target', { skip: !hasUsableBwrap() }, () => {
    const layout = fixture('bwrap-home-override-');
    try {
        const store = path.join(layout.root, '.data/dpu-data');
        fs.mkdirSync(store);
        fs.writeFileSync(path.join(store, 'marker'), 'dedicated');
        const args = argsFor(layout, {
            cwd: layout.root, agentHomeDir: layout.agentHomeDir,
            volumes: { [store]: '/root', [path.join(layout.root, '.data')]: '/workspace-data' },
        });
        const homeMounts = mounts(args).filter(mount => mount.target === '/root');
        assert.equal(homeMounts.length, 1);
        assert.equal(homeMounts[0].source, store);
        const probe = spawnSync('bwrap', [...args, 'sh', '-c', 'test "$HOME" = /root && test "$(cat /root/marker)" = dedicated && test "$(cat /workspace-data/dpu-data/marker)" = dedicated'], { encoding: 'utf8' });
        assert.equal(probe.status, 0, probe.stderr);
    } finally { fs.rmSync(layout.root, { recursive: true, force: true }); }
});
