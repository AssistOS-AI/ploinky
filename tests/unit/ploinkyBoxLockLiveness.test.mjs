import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    DARWIN_PID_NAMESPACE,
    LIVENESS,
    createLockLiveness,
    parseDarwinLstart,
    parseDarwinPlatformUuid,
    parseLinuxProcStatStart,
} from '../../ploinky-box/lockLiveness.mjs';

const MACHINE = '0123456789abcdef0123456789abcdef';
const BOOT = '11111111-2222-4333-8444-555555555555';
const OTHER_BOOT = '99999999-2222-4333-8444-555555555555';
const NAMESPACE = 'pid:[4026531836]';

function procStat(pid, startTicks, command = 'node') {
    const rest = ['S', '1', '1', '1', '0', '-1', '4194560', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', String(startTicks), '0'];
    return `${pid} (${command}) ${rest.join(' ')}\n`;
}

// A Linux host with injectable files and process table.
function linuxProbe({ files = {}, processes = {}, killError = {}, machineId = MACHINE, bootId = BOOT, namespace = NAMESPACE } = {}) {
    const table = {
        '/etc/machine-id': machineId === null ? null : `${machineId}\n`,
        '/proc/sys/kernel/random/boot_id': `${bootId}\n`,
        ...Object.fromEntries(Object.entries(processes).map(([pid, ticks]) => [`/proc/${pid}/stat`, procStat(pid, ticks)])),
        ...files,
    };
    const fsApi = {
        readFileSync(file) {
            if (table[file] == null) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
            return table[file];
        },
        readlinkSync(file) {
            assert.equal(file, '/proc/self/ns/pid');
            return namespace;
        },
    };
    const kill = (pid) => {
        if (killError[pid]) throw Object.assign(new Error(killError[pid]), { code: killError[pid] });
        if (!(pid in processes)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    return createLockLiveness({ platform: 'linux', fsApi, kill, hostname: () => 'host-a', selfPid: 10 });
}

function owner(overrides = {}) {
    return { pid: 500, machineId: MACHINE, bootId: BOOT, pidNamespace: NAMESPACE, processStart: 'linux:7000', ...overrides };
}

test('Linux self fields come from machine-id, boot_id, the PID-namespace inode and /proc/<pid>/stat field 22', () => {
    const probe = linuxProbe({ processes: { 10: 4242 } });
    assert.deepEqual({ ...probe.selfFields() }, {
        hostname: 'host-a', machineId: MACHINE, bootId: BOOT, pidNamespace: NAMESPACE, pid: 10, processStart: 'linux:4242',
    });
});

test('N12 matrix: stale only on positive evidence, undetermined otherwise', () => {
    const cases = [
        ['ESRCH', linuxProbe(), owner(), LIVENESS.stale],
        ['reused pid with a different start token', linuxProbe({ processes: { 500: 8000 } }), owner(), LIVENESS.stale],
        ['EPERM pid with a different start token', linuxProbe({ processes: { 500: 8000 }, killError: { 500: 'EPERM' } }), owner(), LIVENESS.stale],
        ['changed bootId', linuxProbe({ processes: { 500: 7000 } }), owner({ bootId: OTHER_BOOT }), LIVENESS.stale],
        ['different machineId', linuxProbe(), owner({ machineId: 'f'.repeat(32) }), LIVENESS.undetermined],
        ['different pidNamespace', linuxProbe(), owner({ pidNamespace: 'pid:[4026532000]' }), LIVENESS.undetermined],
        ['the same live process', linuxProbe({ processes: { 500: 7000 } }), owner(), LIVENESS.live],
        ['EPERM pid with the same start token', linuxProbe({ processes: { 500: 7000 }, killError: { 500: 'EPERM' } }), owner(), LIVENESS.live],
        ['unreadable start token', linuxProbe({ processes: { 500: 7000 }, files: { '/proc/500/stat': 'garbage' } }), owner(), LIVENESS.undetermined],
        ['missing local machine-id', linuxProbe({ machineId: null }), owner(), LIVENESS.undetermined],
        ['owner without machineId', linuxProbe(), owner({ machineId: null }), LIVENESS.undetermined],
        ['owner without a start token', linuxProbe({ processes: { 500: 7000 } }), owner({ processStart: null }), LIVENESS.undetermined],
        ['unexpected kill error', linuxProbe({ processes: { 500: 7000 }, killError: { 500: 'EINVAL' } }), owner(), LIVENESS.undetermined],
        ['incomplete owner', linuxProbe(), { machineId: MACHINE }, LIVENESS.undetermined],
    ];
    for (const [name, probe, record, expected] of cases) {
        assert.equal(probe.classify(record).state, expected, name);
    }
});

test('the boot check precedes the process check, and a changed boot needs the same machine and namespace', () => {
    // pid 500 is alive with the recorded token, but the machine restarted.
    assert.equal(linuxProbe({ processes: { 500: 7000 } }).classify(owner({ bootId: OTHER_BOOT })).state, LIVENESS.stale);
    assert.equal(linuxProbe().classify(owner({ bootId: OTHER_BOOT, machineId: 'f'.repeat(32) })).state, LIVENESS.undetermined);
    assert.equal(linuxProbe().classify(owner({ bootId: OTHER_BOOT, pidNamespace: 'pid:[1]' })).state, LIVENESS.undetermined);
});

test('/proc/<pid>/stat is parsed after the last parenthesis', () => {
    assert.equal(parseLinuxProcStatStart(procStat(9, 123, 'a) b) c')), 'linux:123');
    assert.equal(parseLinuxProcStatStart('9 (node) S 1 2'), null);
    assert.equal(parseLinuxProcStatStart('no parenthesis'), null);
    assert.equal(parseLinuxProcStatStart(procStat(9, 'x')), null);
});

function darwinProbe({ outputs = {}, processes = {}, calls = [] } = {}) {
    const execFile = (file, args, options) => {
        calls.push({ file, args, env: options.env });
        const key = `${file} ${args.join(' ')}`;
        if (!(key in outputs)) throw Object.assign(new Error('failed'), { status: 1 });
        return outputs[key];
    };
    const kill = (pid) => {
        if (!(pid in processes)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    return createLockLiveness({ platform: 'darwin', execFile, kill, hostname: () => 'mac', selfPid: 77 });
}

const DARWIN_OUTPUTS = {
    '/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice': '  "IOPlatformUUID" = "C2CA121D-031C-4B66-9701-3FFC74308A08"\n',
    '/usr/sbin/sysctl -n kern.bootsessionuuid': `${BOOT}\n`,
    '/bin/ps -o lstart= -p 77': 'Wed Oct 21 13:43:54 2026    \n',
};

test('macOS uses ioreg, kern.bootsessionuuid and ps lstart under a fixed locale and zone', () => {
    const calls = [];
    const probe = darwinProbe({ outputs: DARWIN_OUTPUTS, calls });
    assert.deepEqual({ ...probe.selfFields() }, {
        hostname: 'mac',
        machineId: 'C2CA121D-031C-4B66-9701-3FFC74308A08',
        bootId: BOOT,
        pidNamespace: DARWIN_PID_NAMESPACE,
        pid: 77,
        processStart: 'darwin:Wed Oct 21 13:43:54 2026',
    });
    for (const call of calls) {
        assert.ok(call.file.startsWith('/'), 'absolute tool path');
        assert.equal(call.env.LC_ALL, 'C');
        assert.equal(call.env.TZ, 'UTC');
    }
});

test('macOS: unparseable ps output is undetermined; a different start token is stale', () => {
    const record = {
        pid: 500, machineId: 'C2CA121D-031C-4B66-9701-3FFC74308A08', bootId: BOOT,
        pidNamespace: DARWIN_PID_NAMESPACE, processStart: 'darwin:Wed Oct 21 13:43:54 2026',
    };
    const garbled = darwinProbe({ outputs: { ...DARWIN_OUTPUTS, '/bin/ps -o lstart= -p 500': 'mer 21 oct 13:43:54 2026\n' }, processes: { 500: true } });
    assert.equal(garbled.classify(record).state, LIVENESS.undetermined);
    const reused = darwinProbe({ outputs: { ...DARWIN_OUTPUTS, '/bin/ps -o lstart= -p 500': 'Thu Oct 22 09:00:00 2026\n' }, processes: { 500: true } });
    assert.equal(reused.classify(record).state, LIVENESS.stale);
    const same = darwinProbe({ outputs: { ...DARWIN_OUTPUTS, '/bin/ps -o lstart= -p 500': 'Wed Oct 21 13:43:54 2026\n' }, processes: { 500: true } });
    assert.equal(same.classify(record).state, LIVENESS.live);
    const noIoreg = darwinProbe({ outputs: { '/usr/sbin/sysctl -n kern.bootsessionuuid': `${BOOT}\n` } });
    assert.equal(noIoreg.classify(record).state, LIVENESS.undetermined, 'a failed machine probe is undetermined');
});

test('lstart and IOPlatformUUID parsers accept only the C-locale forms', () => {
    assert.equal(parseDarwinLstart('Tue Oct  1 01:02:03 2026'), 'darwin:Tue Oct 1 01:02:03 2026');
    assert.equal(parseDarwinLstart('Tue Oct 41 01:02:03 2026'), null);
    assert.equal(parseDarwinLstart('Tue Oct 1 25:02:03 2026'), null);
    assert.equal(parseDarwinLstart(''), null);
    assert.equal(parseDarwinPlatformUuid('"IOPlatformUUID" = "not-a-uuid"'), null);
});

test('this host: the probe reads its own tokens, sees itself live and an exited process stale', () => {
    if (!['linux', 'darwin'].includes(process.platform)) return;
    const probe = createLockLiveness();
    const self = probe.selfFields();
    assert.ok(self.machineId, 'machine id');
    assert.ok(self.bootId, 'boot id');
    assert.ok(self.pidNamespace, 'pid namespace');
    assert.ok(self.processStart, 'process start');
    assert.equal(probe.classify(self).state, LIVENESS.live);
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const gone = { ...self, pid: Number(exited.stdout) };
    assert.equal(probe.classify(gone).state, LIVENESS.stale);
});

test('a missing boot id on either side is never taken as a restart', () => {
    // The holder is alive with its recorded start token.
    assert.equal(linuxProbe({ processes: { 500: 7000 } }).classify(owner({ bootId: null })).state, LIVENESS.live);
    const noLocalBoot = linuxProbe({ processes: { 500: 7000 }, files: { '/proc/sys/kernel/random/boot_id': null } });
    assert.equal(noLocalBoot.localIdentity().bootId, null);
    assert.equal(noLocalBoot.classify(owner({ bootId: OTHER_BOOT })).state, LIVENESS.live);
    assert.notEqual(linuxProbe().classify(owner({ bootId: null })).state, LIVENESS.live, 'a dead holder is still stale by ESRCH');
});

test('a failed probe of this process is retried on the next classification, a successful one is kept', () => {
    const calls = [];
    let ioregFails = true;
    const execFile = (file, args) => {
        calls.push(file);
        if (file === '/usr/sbin/ioreg' && ioregFails) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        const key = `${file} ${args.join(' ')}`;
        if (key in DARWIN_OUTPUTS) return DARWIN_OUTPUTS[key];
        if (key === '/bin/ps -o lstart= -p 500') return 'Thu Oct 22 09:00:00 2026\n';
        throw Object.assign(new Error('failed'), { status: 1 });
    };
    const probe = createLockLiveness({ platform: 'darwin', execFile, kill: () => {}, hostname: () => 'mac', selfPid: 77 });
    const record = {
        pid: 500, machineId: 'C2CA121D-031C-4B66-9701-3FFC74308A08', bootId: BOOT,
        pidNamespace: DARWIN_PID_NAMESPACE, processStart: 'darwin:Wed Oct 21 13:43:54 2026',
    };
    assert.equal(probe.classify(record).state, LIVENESS.undetermined, 'a slow ioreg first');
    ioregFails = false;
    assert.equal(probe.classify(record).state, LIVENESS.stale, 'the next classification probes again');
    const ioregCalls = calls.filter((file) => file === '/usr/sbin/ioreg').length;
    probe.classify(record);
    assert.equal(calls.filter((file) => file === '/usr/sbin/ioreg').length, ioregCalls, 'a successful probe is not repeated');
});
