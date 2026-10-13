import { performance } from 'node:perf_hooks';
import { requireTransport } from './liveProcess.mjs';
import { blocked, jsonDigest } from './liveCommon.mjs';

export const LINUX_HOST_LIMITS = Object.freeze({ intervalMs: 2000, minAvailableBytes: 2147483648,
    availableFraction: 0.1, psiFull: 10, swapGrowthBytes: 1073741824, samples: 1800 });

// Serialized into the selected host's pinned Node. No arbitrary paths or raw
// procfs, argv, environment, hostnames or user identities leave this reader.
export function readLinuxHostSample(fs, os, pin) {
    const bounded = file => { const value = fs.readFileSync(file, 'utf8'); if (value.length > 65536) throw Error('Host sample oversized'); return value; };
    if (!/^\/dev\/dri\/renderD[0-9]+$/.test(pin.render.path)) throw Error('Invalid render path');
    const memory = bounded('/proc/meminfo');
    const bytes = key => { const rows = [...memory.matchAll(new RegExp('^' + key + ':\\s+(\\d+) kB$', 'gm'))];
        if (rows.length !== 1) throw Error('Host memory unreadable'); const n = Number(rows[0][1]) * 1024;
        if (!Number.isSafeInteger(n) || n < 0) throw Error('Host memory invalid'); return n; };
    const pressure = [...bounded('/proc/pressure/memory').matchAll(/^full avg10=([0-9.]+) avg60=[0-9.]+ avg300=[0-9.]+ total=[0-9]+$/gm)];
    if (pressure.length !== 1 || !Number.isFinite(Number(pressure[0][1]))) throw Error('Host PSI unreadable');
    const root = '/sys/class/drm/' + pin.render.path.split('/').at(-1) + '/device/';
    const count = name => { const raw = bounded(root + name).trim(); if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw Error('AMD counter invalid'); return Number(raw); };
    const optional = name => { try { return count(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    const pci = Object.fromEntries([['vendor', 'vendor'], ['device', 'device'], ['revision', 'revision'],
        ['subsystemVendor', 'subsystem_vendor'], ['subsystemDevice', 'subsystem_device']].map(([key, file]) => [key, bounded(root + file).trim()]));
    const stat = fs.lstatSync(pin.render.path);
    if (!stat.isCharacterDevice() || stat.isSymbolicLink()) throw Error('AMD render device changed');
    const driver = fs.realpathSync(root + 'driver').split('/').at(-1);
    const identity = { pci, render: { path: pin.render.path, major: (stat.rdev >>> 8) & 4095,
        minor: (stat.rdev & 255) | ((stat.rdev >>> 12) & 0xfffff00), mode: '0' + (stat.mode & 511).toString(8).padStart(3, '0'), driver },
        kernel: os.release(), os: (() => { const release = bounded('/etc/os-release'); return ['ID', 'VERSION_ID'].map(key => {
            const row = new RegExp('^' + key + '="?([A-Za-z0-9_.-]+)"?$', 'm').exec(release);
            if (!row) throw Error('OS identity unavailable'); return row[1];
        }).join(' '); })(), memTotalBytes: bytes('MemTotal'),
        memory: { vramTotalBytes: count('mem_info_vram_total'), gttTotalBytes: count('mem_info_gtt_total') } };
    // Only one amdgpu node is eligible for this qualification cohort.
    const nodes = fs.readdirSync('/sys/class/drm').filter(name => /^renderD[0-9]+$/.test(name));
    const amdNodes = nodes.filter(name => { try { return fs.realpathSync('/sys/class/drm/' + name + '/device/driver').split('/').at(-1) === 'amdgpu'; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
    if (amdNodes.length !== 1) throw Error('AMD node inventory ambiguous');
    return { identity, totalBytes: bytes('MemTotal'), availableBytes: bytes('MemAvailable'), swapTotalBytes: bytes('SwapTotal'),
        swapUsedBytes: bytes('SwapTotal') - bytes('SwapFree'), psiFull: Number(pressure[0][1]), busyPercent: optional('gpu_busy_percent'),
        vramUsedBytes: optional('mem_info_vram_used'), gttUsedBytes: optional('mem_info_gtt_used') };
}

export const LINUX_HOST_SAMPLE = `try { process.stdout.write(JSON.stringify((${readLinuxHostSample.toString()})(require('node:fs'),require('node:os'),JSON.parse(process.argv[1])))); } catch { process.stderr.write('Linux host observation unavailable'); process.exitCode=1; }`;

export function assertLinuxIdentity(sample, pin) {
    const expected = { pci: pin.pci, render: pin.render, kernel: pin.host.kernel, os: pin.host.os,
        memTotalBytes: pin.host.memTotalBytes, memory: pin.memory };
    if (jsonDigest(sample?.identity) !== jsonDigest(expected)) throw blocked('AMD host identity differs from pins');
}

export function assertLinuxHostSample(sample, baseline = sample) {
    for (const key of ['totalBytes', 'availableBytes', 'swapTotalBytes', 'swapUsedBytes']) {
        if (!Number.isSafeInteger(sample?.[key]) || sample[key] < 0) throw blocked('Linux host memory sample unreadable');
    }
    if (!Number.isFinite(sample.psiFull) || sample.psiFull < 0 || sample.psiFull > 100
        || !sample.totalBytes || sample.availableBytes > sample.totalBytes || sample.swapUsedBytes > sample.swapTotalBytes
        || sample.totalBytes !== baseline?.totalBytes || !Number.isSafeInteger(baseline?.swapUsedBytes)) throw blocked('Linux host sample ambiguous');
    if (sample.availableBytes < Math.max(LINUX_HOST_LIMITS.minAvailableBytes, Math.ceil(sample.totalBytes * LINUX_HOST_LIMITS.availableFraction))
        || sample.psiFull >= LINUX_HOST_LIMITS.psiFull || sample.swapUsedBytes - baseline.swapUsedBytes > LINUX_HOST_LIMITS.swapGrowthBytes) {
        throw blocked('Linux host guard threshold breached');
    }
}

export function createLinuxHostGuard({ sample, write, baseline = null, intervalMs = 2000, clock = () => performance.now() }) {
    const history = []; let tripped = false;
    const snapshot = () => ({ schema: 1, thresholds: LINUX_HOST_LIMITS, baseline, samples: [...history], tripped });
    async function check() {
        try {
            const at = clock();
            if (!Number.isFinite(at) || at < 0 || history.length && at < history.at(-1).monotonicMs) throw blocked('Linux host clock invalid');
            const value = await sample();
            assertLinuxHostSample(value, baseline || value);
            if (history.length >= LINUX_HOST_LIMITS.samples) throw blocked('Linux host observation bound exceeded');
            baseline ||= value; history.push({ monotonicMs: at, ...value }); write(snapshot()); return value;
        } catch (error) { tripped = true; write(snapshot()); throw error.code === 'LIVE_PREREQUISITE_MISSING' ? error : blocked('Linux host observation unreadable'); }
    }
    async function monitor(work) {
        await check();
        const controller = new AbortController(); let stopped = false; let failure; let timer; let wake;
        const watcher = (async () => {
            while (!stopped) {
                await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, intervalMs); });
                if (stopped) break;
                try { await check(); } catch (error) { failure = error; controller.abort(error); break; }
            }
        })();
        try { const result = await work(controller.signal); if (failure) throw failure; await check(); return result; }
        finally { stopped = true; clearTimeout(timer); wake?.(); await watcher; if (failure) throw failure; }
    }
    return { check, monitor, snapshot };
}

export function linuxHostSampler({ profile, processProvider, signal }) {
    return async () => {
        const result = await processProvider(profile.node.path, ['-e', LINUX_HOST_SAMPLE, JSON.stringify(profile.model.amd)],
            { cwd: profile.host.home, env: { PATH: '/usr/bin:/bin', HOME: profile.host.home }, signal, deadlineMs: 10000, maxBytes: 16384 });
        requireTransport(result);
        const value = JSON.parse(result.stdout);
        assertLinuxIdentity(value, profile.model.amd);
        return value;
    };
}
