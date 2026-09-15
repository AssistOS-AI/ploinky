import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { assertLinuxHostPrerequisites } from '../../ploinky-box/hostPrerequisites.mjs';

function fixture() {
    const files = new Map([
        ['/etc/os-release', 'ID=ubuntu\nID_LIKE=debian\n'],
        ['/proc/sys/user/max_user_namespaces', '65536\n'],
        ['/proc/sys/kernel/unprivileged_userns_clone', '1\n'],
    ]);
    const binaries = new Set(['git', 'newuidmap', 'newgidmap', 'conmon', 'crun', 'pasta', 'netavark'].map((name) => `/usr/bin/${name}`));
    const devices = new Set(['/dev/fuse', '/dev/net/tun']);
    const info = {
        host: {
            os: 'linux', serviceIsRemote: false,
            security: { rootless: true, seccompEnabled: true },
            cgroupVersion: 'v2', cgroupControllers: ['cpu', 'memory', 'pids'],
            conmon: { path: '/usr/bin/conmon' },
            ociRuntime: { path: '/usr/bin/crun' },
            networkBackend: 'netavark', networkBackendInfo: { path: '/usr/bin/netavark' },
            rootlessNetworkCmd: 'pasta', pasta: { executable: '/usr/bin/pasta' },
        },
        store: { graphOptions: {} },
    };
    const calls = [];
    const responses = new Map();
    const options = {
        platform: 'linux', uid: 1000, env: { PATH: '/usr/bin' },
        fsApi: {
            readFileSync(filename) {
                if (files.has(filename)) return files.get(filename);
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            },
            statSync(filename) {
                return { isFile: () => binaries.has(filename), isCharacterDevice: () => devices.has(filename) };
            },
            accessSync(filename) {
                if (!binaries.has(filename) && !devices.has(filename)) throw new Error('denied');
            },
        },
        runner: {
            query(command, args, probeOptions) {
                assert.equal(command, 'podman');
                assert.equal(probeOptions.timeoutMs, 5_000);
                const key = args.join(' ');
                calls.push(key);
                if (responses.has(key)) return responses.get(key);
                if (key === '--version') return { ok: true, stdout: 'podman version 5.4.2\n' };
                if (key === 'info --format json') return { ok: true, stdout: JSON.stringify(info) };
                if (/^unshare cat \/proc\/self\/(uid|gid)_map$/.test(key)) return { ok: true, stdout: '0 1000 1\n1 100000 65536\n' };
                throw new Error(`Unexpected mutation or probe: ${key}`);
            },
        },
    };
    return { files, binaries, devices, info, calls, responses, options, run: () => assertLinuxHostPrerequisites(options) };
}

test('a supported Linux host passes using bounded read-only capability probes', () => {
    const state = fixture();
    state.run();
    assert.deepEqual(state.calls, ['--version', 'info --format json', 'unshare cat /proc/self/uid_map', 'unshare cat /proc/self/gid_map']);
});

test('non-Linux hosts do not inspect local packages or run host probes', () => {
    const state = fixture();
    state.options.platform = 'darwin';
    state.options.uid = 0;
    state.binaries.clear();
    state.run();
    assert.deepEqual(state.calls, []);
});

test('missing and old Podman plus independent prerequisites are reported together before engine discovery', () => {
    for (const version of [{ ok: false, error: { code: 'ENOENT' } }, { ok: true, stdout: 'podman version 4.9.3' }]) {
        const state = fixture();
        state.responses.set('--version', version);
        state.binaries.delete('/usr/bin/newuidmap');
        state.devices.delete('/dev/fuse');
        assert.throws(state.run, (error) => {
            assert.equal(error.code, 'PLOINKY_BOX_HOST_PREREQUISITES_FAILED');
            assert.match(error.message, /5\.4\.0 or newer/);
            assert.match(error.message, /apt-get install podman catatonit/);
            assert.match(error.message, /apt-get install uidmap/);
            assert.match(error.message, /modprobe fuse/);
            assert.match(error.message, /then rerun/);
            return true;
        });
        assert.deepEqual(state.calls, ['--version']);
    }
});

test('vendor versions and newer majors pass while malformed versions fail closed', () => {
    for (const version of ['5.4.0', '5.4.2+ds1-2', '5.10.1', '6.0.0']) {
        const state = fixture();
        state.responses.set('--version', { ok: true, stdout: `podman version ${version}` });
        state.run();
    }
    const state = fixture();
    state.responses.set('--version', { ok: true, stdout: 'unexpected tool output' });
    assert.throws(state.run, /Version 5\.4\.0 or newer/);
});

test('configured network and OCI helpers are honored, including binaries outside PATH', () => {
    const state = fixture();
    state.binaries.delete('/usr/bin/crun');
    state.binaries.delete('/usr/bin/pasta');
    state.binaries.add('/opt/runtime/runc');
    state.binaries.add('/opt/network/slirp4netns');
    state.info.host.ociRuntime.path = '/opt/runtime/runc';
    state.info.host.rootlessNetworkCmd = 'slirp4netns';
    state.info.host.slirp4netns = { executable: '/opt/network/slirp4netns' };
    state.run();
    state.binaries.delete('/opt/network/slirp4netns');
    assert.throws(state.run, /Rootless network \(slirp4netns\).*\n.*apt-get install slirp4netns/);
});

test('fuse-overlayfs is required only when the host storage configuration selects it', () => {
    const state = fixture();
    state.run();
    state.info.store.graphOptions['overlay.mount_program'] = { Executable: '/usr/bin/fuse-overlayfs' };
    assert.throws(state.run, /Overlay mount helper.*\n.*install fuse-overlayfs/);
    state.binaries.add('/usr/bin/fuse-overlayfs');
    state.run();
});

test('host Git is not required for a Box using its bundled AgentLib', () => {
    const state = fixture();
    state.binaries.delete('/usr/bin/git');
    state.run();
});

test('Box startup does not require host cgroup versions or delegated controllers', () => {
    for (const cgroups of [
        { cgroupVersion: 'v2', cgroupControllers: ['memory', 'pids'] },
        { cgroupVersion: 'v2', cgroupControllers: [] },
        { cgroupVersion: 'v1', cgroupControllers: [] },
        {},
    ]) {
        const state = fixture();
        delete state.info.host.cgroupVersion;
        delete state.info.host.cgroupControllers;
        Object.assign(state.info.host, cgroups);
        assert.doesNotThrow(state.run, JSON.stringify(cgroups));
    }
});

test('hosts without delegated controllers still require rootless Podman and seccomp', () => {
    const state = fixture();
    state.info.host.cgroupControllers = [];
    state.info.host.security.rootless = false;
    assert.throws(state.run, /Rootless Podman/);
    state.info.host.security.rootless = true;
    state.info.host.security.seccompEnabled = false;
    assert.throws(state.run, /Seccomp/);
});

test('insufficient and noncontiguous mappings give subordinate-ID recovery instructions', () => {
    for (const mapping of ['0 1000 1\n', '0 1000 1\n2 100000 65536\n', 'not a mapping']) {
        const state = fixture();
        state.responses.set('unshare cat /proc/self/uid_map', { ok: true, stdout: mapping });
        assert.throws(state.run, /Rootless UID mapping.*\n.*\/etc\/subuid.*podman system migrate/);
    }
});

test('namespace failures show redacted diagnostics and actionable configuration guidance', () => {
    const state = fixture();
    state.responses.set('unshare cat /proc/self/gid_map', { ok: false, status: 125, stderr: 'Error: permission denied token=credential-canary' });
    assert.throws(state.run, (error) => {
        assert.match(error.message, /permission denied/);
        assert.match(error.message, /\/etc\/subgid/);
        assert.doesNotMatch(error.message, /credential-canary/);
        return true;
    });
});

test('root and remote engines are rejected without performing namespace probes', () => {
    const state = fixture();
    state.options.uid = 0;
    assert.throws(state.run, /without sudo/);
    assert.deepEqual(state.calls, ['--version']);
    state.calls.length = 0;
    state.options.uid = 1000;
    state.options.env.CONTAINER_HOST = 'ssh://private-endpoint';
    assert.throws(state.run, /Unset CONTAINER_HOST and PODMAN_HOST/);
    assert.deepEqual(state.calls, []);
});

test('distribution instructions use native UID helper package names', () => {
    const state = fixture();
    state.files.set('/etc/os-release', 'ID=fedora\n');
    state.binaries.delete('/usr/bin/newgidmap');
    assert.throws(state.run, /sudo dnf install shadow-utils/);
});

test('unavailable and malformed engine data stop before probing container namespaces', () => {
    for (const response of [
        { ok: false, error: { code: 'ETIMEDOUT' }, stderr: 'connection timed out' },
        { ok: true, stdout: '{' },
        { ok: true, stdout: '{}' },
    ]) {
        const state = fixture();
        state.responses.set('info --format json', response);
        assert.throws(state.run, /Podman engine.*\n.*Next:/);
        assert.deepEqual(state.calls, ['--version', 'info --format json']);
    }
});

test('the public launcher explains missing and outdated Node before loading application modules', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-node-prerequisite-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const launcher = new URL('../../bin/ploinky', import.meta.url).pathname;
    const invoke = () => spawnSync('/bin/bash', [launcher, 'start', 'explorer'], {
        env: { PATH: root }, encoding: 'utf8', timeout: 5_000,
    });
    const missing = invoke();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Node.js 22 or newer.*node was not found/);
    assert.match(missing.stderr, /https:\/\/nodejs.org\/en\/download/);
    fs.writeFileSync(path.join(root, 'node'), '#!/bin/sh\necho v18.20.8\n', { mode: 0o755 });
    const old = invoke();
    assert.equal(old.status, 1);
    assert.match(old.stderr, /observed: v18\.20\.8/);
    assert.match(old.stderr, /then rerun ploinky/);
    assert.doesNotMatch(old.stderr, /readlink|dirname|ERR_MODULE|SyntaxError/);
});
