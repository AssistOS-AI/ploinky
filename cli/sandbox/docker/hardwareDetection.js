import { execFileSync, spawnSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';

const DEFAULT_PROBE_TIMEOUT_MS = 1500;

function normalizeArch(rawArch) {
    const arch = String(rawArch || '').toLowerCase().trim();
    if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') return 'amd64';
    if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
    return arch || null;
}

function normalizePlatform(arch) {
    const normalized = normalizeArch(arch);
    if (normalized === 'amd64') return 'linux/amd64';
    if (normalized === 'arm64') return 'linux/arm64';
    return null;
}

function snippet(value, lines = 3, max = 256) {
    if (typeof value !== 'string') return '';
    return value.split('\n').slice(0, lines).join('\n').slice(0, max);
}

function runCommandProbe(probe, options = {}) {
    const timeout = Number(options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS);
    const result = spawnSync(probe.command, probe.args || [], {
        encoding: 'utf8',
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        ok: !result.error && result.status === 0,
        status: result.status ?? null,
        timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
        stdoutSnippet: snippet(result.stdout, 3, 256),
        stderrSnippet: snippet(result.stderr, 1, 200),
        error: result.error ? result.error.message : null,
    };
}

function runFileProbe(probe, options = {}) {
    const fsModule = options.fsModule || fs;
    try {
        fsModule.accessSync(probe.path, fsModule.constants.F_OK);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function inspectDockerDaemon(runtime, options = {}) {
    if (runtime !== 'docker') return null;
    try {
        const out = execFileSync(runtime, ['info', '--format', '{{ .Architecture }}|{{ .OSType }}'], {
            encoding: 'utf8',
            timeout: options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS,
        }).trim();
        const [arch, osType] = out.split('|').map((s) => s.trim());
        const normalizedArch = normalizeArch(arch);
        if (normalizedArch && (osType || 'linux') === 'linux') {
            return { platform: `linux/${normalizedArch}`, arch: normalizedArch, rawArch: arch, rawOsType: osType };
        }
    } catch (_) {}
    return null;
}

function inspectPodmanDaemon(runtime, options = {}) {
    if (runtime !== 'podman') return null;
    try {
        const out = execFileSync(runtime, ['info', '--format', 'json'], {
            encoding: 'utf8',
            timeout: options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS,
        });
        const parsed = JSON.parse(out);
        const arch = parsed?.host?.arch || parsed?.host?.Arch;
        const osType = parsed?.host?.os || parsed?.host?.OS || 'linux';
        const normalizedArch = normalizeArch(arch);
        if (normalizedArch && (String(osType).toLowerCase() === 'linux' || normalizedArch === 'amd64' || normalizedArch === 'arm64')) {
            return { platform: `linux/${normalizedArch}`, arch: normalizedArch, rawArch: arch, rawOsType: osType };
        }
    } catch (_) {}
    return null;
}

function defaultProbes() {
    return {
        nvidiaSmi: { kind: 'command', command: 'nvidia-smi', args: ['-L'] },
        nvidiaCdi: { kind: 'command', command: 'nvidia-ctk', args: ['cdi', 'list'] },
        kfdDevice: { kind: 'file', path: '/dev/kfd' },
        driDevice: { kind: 'file', path: '/dev/dri' },
        accelDevice: { kind: 'file', path: '/dev/accel' },
        rocmInfo: { kind: 'command', command: 'rocminfo', args: [] },
        amdSmi: { kind: 'command', command: 'amd-smi', args: ['version'] },
        intelPci: { kind: 'command', command: 'lspci', args: ['-nn'] },
        vulkanInfo: { kind: 'command', command: 'vulkaninfo', args: ['--summary'] },
    };
}

function runProbes(probeSet, options = {}) {
    const results = {};
    for (const [name, probe] of Object.entries(probeSet || {})) {
        if (!probe || typeof probe !== 'object') continue;
        if (probe.kind === 'file') {
            results[name] = runFileProbe(probe, options);
        } else if (probe.kind === 'command') {
            results[name] = runCommandProbe(probe, options);
        } else {
            results[name] = { ok: false, error: `unknown probe kind '${probe.kind}'` };
        }
    }
    return results;
}

function summarizeAcceleratorFamilies(probes) {
    const families = new Set(['cpu']);
    const probeOk = (name) => Boolean(probes?.[name]?.ok);
    const probeOutput = (name) => `${probes?.[name]?.stdoutSnippet || ''}\n${probes?.[name]?.stderrSnippet || ''}`;
    const vulkanHasRenderer = probeOk('vulkanInfo')
        && /(GPU|renderer|deviceName|VkPhysicalDevice|driverName)/i.test(probeOutput('vulkanInfo'));
    const intelConfirmed = probeOk('intelPci') && /(Intel|8086)/i.test(probeOutput('intelPci'));
    if (probes?.nvidiaSmi?.ok || probes?.nvidiaCdi?.ok) {
        families.add('nvidia-cuda');
    }
    if (probeOk('kfdDevice') && probeOk('driDevice') && (probeOk('rocmInfo') || probeOk('amdSmi'))) {
        families.add('amd-rocm');
    }
    if (probeOk('driDevice') && vulkanHasRenderer) {
        families.add('vulkan');
    }
    if ((probeOk('driDevice') || probeOk('accelDevice')) && intelConfirmed) {
        families.add('intel-openvino');
    }
    return Array.from(families);
}

function detectHardware(options = {}) {
    const runtime = options.runtime || null;
    const nodeArch = options.arch || os.arch();
    const probeSet = options.probes || defaultProbes();
    const probes = runProbes(probeSet, options);

    let daemonInspection = null;
    if (runtime === 'docker') {
        daemonInspection = options.dockerInspect ? options.dockerInspect() : inspectDockerDaemon('docker', options);
    } else if (runtime === 'podman') {
        daemonInspection = options.podmanInspect ? options.podmanInspect() : inspectPodmanDaemon('podman', options);
    }

    const normalizedHostArch = normalizeArch(nodeArch);
    const hostPlatform = normalizedHostArch === 'amd64' || normalizedHostArch === 'arm64'
        ? `linux/${normalizedHostArch}`
        : null;
    const ociPlatform = daemonInspection?.platform || hostPlatform || null;
    const acceleratorFamilies = summarizeAcceleratorFamilies(probes);

    return {
        runtime,
        nodeArch: normalizedHostArch,
        nodePlatform: hostPlatform,
        ociPlatform,
        daemon: daemonInspection,
        acceleratorFamilies,
        probes,
    };
}

export {
    DEFAULT_PROBE_TIMEOUT_MS,
    defaultProbes,
    detectHardware,
    inspectDockerDaemon,
    inspectPodmanDaemon,
    normalizeArch,
    normalizePlatform,
    runProbes,
    summarizeAcceleratorFamilies,
};
