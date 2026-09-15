import assert from 'node:assert/strict';
import test from 'node:test';

import { collectHostDiagnostics } from '../../ploinky-box/diagnose/host.mjs';

function fixture() {
    const files = new Map([
        ['/etc/os-release', 'ID=ubuntu\n'],
        ['/proc/sys/user/max_user_namespaces', '65536\n'],
        ['/proc/sys/kernel/unprivileged_userns_clone', '1\n'],
        ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1\n'],
        ['/sys/module/apparmor/parameters/enabled', 'Y\n'],
        ['/sys/kernel/security/apparmor/profiles', 'pasta (enforce)\nfusermount3 (enforce)\n'],
        ['/etc/apparmor.d/usr.bin.pasta', 'profile pasta /usr/bin/pasta {\n @{run}/netns/ r,\n @{run}/netns/netns-* r,\n}\n'],
        ['/etc/apparmor.d/fusermount3', 'profile fusermount3 /usr/bin/fusermount3 {\n umount /data/podman/storage/overlay/*/merged/,\n}\n'],
    ]);
    const binaries = new Set(['newuidmap', 'newgidmap', 'conmon', 'crun', 'netavark', 'pasta'].map((name) => `/usr/bin/${name}`));
    const devices = new Set(['/dev/fuse', '/dev/net/tun']);
    const info = {
        host: {
            os: 'linux', serviceIsRemote: false,
            security: { rootless: true, seccompEnabled: true, apparmorEnabled: false, selinuxEnabled: false, seccompProfilePath: '/usr/share/containers/seccomp.json' },
            cgroupManager: 'cgroupfs', cgroupVersion: 'v1', cgroupControllers: [],
            conmon: { path: '/usr/bin/conmon' }, ociRuntime: { path: '/usr/bin/crun' },
            networkBackend: 'netavark', networkBackendInfo: { path: '/usr/bin/netavark' },
            rootlessNetworkCmd: 'pasta', pasta: { executable: '/usr/bin/pasta' },
        },
        store: { graphDriverName: 'overlay', graphRoot: '/home/test/storage', runRoot: '/run/user/1000/containers', configFile: '/home/test/.config/containers/storage.conf', graphOptions: {}, graphStatus: { 'Native Overlay Diff': 'true' } },
    };
    const calls = [];
    const responses = new Map();
    const options = {
        platform: 'linux', uid: 1000, nodeVersion: 'v24.21.0', execPath: '/usr/bin/node', env: { PATH: '/usr/bin' },
        fsApi: {
            readFileSync(filename) {
                if (files.has(filename)) return files.get(filename);
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            },
            statSync(filename) { return { isFile: () => binaries.has(filename), isCharacterDevice: () => devices.has(filename) }; },
            accessSync(filename) { if (!binaries.has(filename) && !devices.has(filename)) throw new Error('denied'); },
        },
        runner: {
            query(file, args, opts) {
                assert.equal(opts.timeoutMs, 5_000);
                const key = [file, ...args].join(' ');
                calls.push(key);
                if (responses.has(key)) return responses.get(key);
                if (key === 'node --version') return { ok: true, status: 0, stdout: 'v24.21.0\n' };
                if (key === 'podman --version') return { ok: true, status: 0, stdout: 'podman version 5.7.0\n' };
                if (key === 'podman info --format json') return { ok: true, status: 0, stdout: JSON.stringify(info) };
                if (/^podman unshare cat \/proc\/self\/(uid|gid)_map$/.test(key)) return { ok: true, status: 0, stdout: '0 1000 1\n1 100000 65536\n' };
                throw new Error(`Unexpected command: ${key}`);
            },
        },
    };
    const run = () => collectHostDiagnostics(options);
    return { files, binaries, devices, info, calls, responses, options, run };
}

function check(result, id) {
    const found = result.checks.find((item) => item.id === id);
    assert.ok(found, id);
    return found;
}

test('host diagnostics use bounded read-only commands and retain driver, configuration and helper selections', () => {
    const state = fixture();
    const result = state.run();
    assert.equal(result.engineUsable, true);
    assert.equal(result.checks.some((item) => item.status === 'fail'), false);
    assert.match(check(result, 'host.storage').detail, /driver=overlay.*graphRoot=\/home\/test\/storage.*storage\.conf/);
    assert.match(check(result, 'host.helper.rootlessNetwork').detail, /\/usr\/bin\/pasta/);
    assert.match(check(result, 'host.cgroup').detail, /cgroupfs.*version=v1.*not cgroup-delegation prerequisites/);
    assert.deepEqual(state.calls, ['node --version', 'podman --version', 'podman info --format json', 'podman unshare cat /proc/self/uid_map', 'podman unshare cat /proc/self/gid_map']);
});

test('independent failures are collected even when old Podman or missing devices are detected', () => {
    const state = fixture();
    state.responses.set('node --version', { ok: true, stdout: 'v18.0.0', status: 0 });
    state.responses.set('podman --version', { ok: true, stdout: 'podman version 4.9.3', status: 0 });
    state.binaries.delete('/usr/bin/newgidmap');
    state.devices.delete('/dev/fuse');
    state.files.set('/proc/sys/user/max_user_namespaces', '0');
    const result = state.run();
    for (const id of ['host.node.path', 'host.podman.version', 'host.helper.newgidmap', 'host.device.fuse', 'host.sysctl.max_user_namespaces']) assert.equal(check(result, id).status, 'fail', id);
    assert.equal(check(result, 'host.podman.info').status, 'pass');
    assert.equal(check(result, 'host.mapping.uid').status, 'pass');
    assert.equal(result.engineUsable, false);
    assert.match(check(result, 'host.helper.newgidmap').next, /apt-get install uidmap/);
});

test('missing Podman or malformed info skip engine-dependent checks but still inspect host policy', () => {
    for (const missing of [true, false]) {
        const state = fixture();
        state.responses.set(missing ? 'podman --version' : 'podman info --format json', missing
            ? { ok: false, status: 1, error: { code: 'ENOENT' } }
            : { ok: true, status: 0, stdout: '{}' });
        const result = state.run();
        assert.equal(result.engineUsable, false);
        assert.equal(result.engineInfo, null);
        assert.equal(check(result, 'host.mapping').status, 'skip');
        assert.equal(check(result, 'host.apparmor.pasta').status, 'pass');
        assert.equal(state.calls.some((item) => item.includes('unshare')), false);
    }
});

test('root and remote endpoint overrides prevent engine queries without exposing endpoint credentials', () => {
    for (const root of [true, false]) {
        const state = fixture();
        if (root) state.options.uid = 0;
        else state.options.env.CONTAINER_HOST = 'ssh://secret-user:secret-password@private-machine';
        const result = state.run();
        assert.equal(result.engineUsable, false);
        assert.equal(check(result, root ? 'host.user' : 'host.endpoint').status, 'fail');
        assert.deepEqual(state.calls, ['node --version', 'podman --version']);
        assert.doesNotMatch(JSON.stringify(result.checks), /secret-password|private-machine/);
    }
});

test('selected helper paths outside PATH are validated and overlay helper is conditional', () => {
    const state = fixture();
    state.info.host.ociRuntime.path = '/opt/runtime/crun';
    state.binaries.add('/opt/runtime/crun');
    assert.equal(check(state.run(), 'host.helper.oci').status, 'pass');
    assert.equal(check(state.run(), 'host.helper.overlay').status, 'skip');
    state.info.store.graphOptions['overlay.mount_program'] = { Executable: '/opt/storage/fuse-overlayfs' };
    assert.equal(check(state.run(), 'host.helper.overlay').status, 'fail');
    state.binaries.add('/opt/storage/fuse-overlayfs');
    assert.equal(check(state.run(), 'host.helper.overlay').status, 'pass');
});

test('AppArmor helper profiles remain visible when Podman container AppArmor is disabled', () => {
    const state = fixture();
    state.files.delete('/sys/kernel/security/apparmor/profiles');
    const result = state.run();
    assert.match(check(result, 'host.apparmor').detail, /Kernel AppArmor: Y.*container AppArmor: disabled/);
    assert.equal(check(result, 'host.apparmor.loaded').status, 'warn');
    assert.equal(check(result, 'host.apparmor.pasta').status, 'pass');
    assert.match(check(result, 'host.apparmor.pasta').detail, /does not prove/);
    assert.equal(result.engineUsable, true);
});

test('comments and owner-only namespace rules do not masquerade as the nested-root pasta fix', () => {
    const state = fixture();
    state.files.set('/etc/apparmor.d/usr.bin.pasta', '# @{run}/netns/ r,\n owner @{run}/netns/ r,\n owner @{run}/netns/netns-* r,\n');
    state.files.set('/etc/apparmor.d/fusermount3', '# umount /data/podman/storage/overlay/*/merged/,\n');
    const result = state.run();
    assert.equal(check(result, 'host.apparmor.pasta').status, 'warn');
    assert.equal(check(result, 'host.apparmor.fusermount').status, 'warn');
    assert.match(check(result, 'host.apparmor.pasta').next, /If the networking probe reports pasta/);
    assert.doesNotMatch(JSON.stringify(result.checks), /unconfined|privileged=true|sysctl -w/);
});

test('bounded profile includes recognize local overrides without following paths outside AppArmor', () => {
    const state = fixture();
    state.files.set('/etc/apparmor.d/usr.bin.pasta', 'include if exists <local/pasta>\ninclude <../../private-policy>');
    state.files.set('/etc/apparmor.d/local/pasta', 'include <local/pasta>\n/run/netns/ rw,\n/run/netns/netns-* r,\n');
    const read = state.options.fsApi.readFileSync;
    state.options.fsApi.readFileSync = (filename, ...args) => {
        assert.notEqual(filename, '/private-policy');
        return read(filename, ...args);
    };
    assert.equal(check(state.run(), 'host.apparmor.pasta').status, 'pass');
});

test('namespace command failures keep precise command and exit status but redact sensitive output', () => {
    const state = fixture();
    state.options.env.API_TOKEN = 'environment-canary';
    state.responses.set('podman unshare cat /proc/self/gid_map', {
        ok: false, status: 125, stderr: 'Permission denied token=credential-canary environment-canary ' + 'detail '.repeat(1000),
    });
    const result = state.run();
    const failed = check(result, 'host.mapping.gid');
    assert.equal(failed.status, 'fail');
    assert.equal(failed.exitCode, 125);
    assert.deepEqual(failed.command, { file: 'podman', args: ['unshare', 'cat', '/proc/self/gid_map'] });
    assert.match(failed.detail, /Permission denied/);
    assert.doesNotMatch(failed.detail, /credential-canary|environment-canary/);
    assert.ok(failed.detail.length <= 2000);
});

test('unprivileged namespace policy restrictions are context rather than automatic failure', () => {
    const state = fixture();
    const result = state.run();
    assert.equal(check(result, 'host.sysctl.apparmor_restrict_unprivileged_userns').status, 'pass');
    assert.equal(result.engineUsable, true);
    state.responses.set('podman unshare cat /proc/self/uid_map', { ok: true, stdout: '0 1000 1\n' });
    assert.equal(check(state.run(), 'host.mapping.uid').status, 'fail');
});

test('macOS checks the default Machine connection and skips Linux paths and unshare', () => {
    const state = fixture();
    state.options.platform = 'darwin';
    state.info.host.serviceIsRemote = true;
    state.binaries.clear();
    state.devices.clear();
    state.responses.set('podman system connection list --format json', { ok: true, stdout: JSON.stringify([{ Name: 'podman-machine-default', Default: true, IsMachine: true, URI: 'ssh://user:secret@localhost' }]) });
    state.responses.set('podman machine list --format json', { ok: true, stdout: '[{"Name":"podman-machine-default","Running":true}]' });
    const result = state.run();
    assert.equal(result.engineUsable, true);
    assert.equal(check(result, 'host.machine').status, 'pass');
    assert.equal(check(result, 'host.machine.state').status, 'pass');
    assert.equal(check(result, 'host.helpers').status, 'skip');
    assert.equal(check(result, 'host.mapping.uid').status, 'skip');
    assert.equal(state.calls.some((item) => item.includes('unshare')), false);
    assert.doesNotMatch(JSON.stringify(result.checks), /user:secret/);
    state.responses.set('podman system connection list --format json', { ok: true, stdout: '[{"Default":true,"IsMachine":false}]' });
    assert.equal(check(state.run(), 'host.machine').status, 'fail');
});

test('stopped Podman Machine is reported even when podman info cannot connect', () => {
    const state = fixture();
    state.options.platform = 'darwin';
    state.responses.set('podman system connection list --format json', { ok: true, stdout: '[{"Name":"qa-machine","Default":true,"IsMachine":true}]' });
    state.responses.set('podman machine list --format json', { ok: true, stdout: '[{"Name":"qa-machine","Running":false}]' });
    state.responses.set('podman info --format json', { ok: false, status: 125, stderr: 'connection refused' });
    const result = state.run();
    assert.equal(check(result, 'host.machine.state').status, 'fail');
    assert.match(check(result, 'host.machine.state').detail, /qa-machine: not running/);
    assert.equal(check(result, 'host.podman.info').status, 'fail');
});

test('Windows reports its unsupported host boundary without pretending local files describe its Linux VM', () => {
    const state = fixture();
    state.options.platform = 'win32';
    const result = state.run();
    assert.equal(check(result, 'host.platform').status, 'fail');
    assert.equal(check(result, 'host.linux.prerequisites').status, 'skip');
    assert.equal(result.engineUsable, false);
    assert.equal(state.calls.includes('podman info --format json'), false);
});
