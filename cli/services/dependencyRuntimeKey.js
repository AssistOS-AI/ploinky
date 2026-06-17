import { spawnSync } from 'child_process';
import { getRuntime, getRuntimeForAgent, ensureImagePresent } from './docker/common.js';
import { resolveManifestImage } from './secretVars.js';

const SUPPORTED_FAMILIES = new Set(['bwrap', 'seatbelt', 'container']);

// The probe only starts a container and runs a tiny `node -e` script, so it
// should finish in seconds. Keep the timeout short (env-overridable) so it
// catches a genuinely hung runtime instead of silently absorbing a multi-minute
// image pull — pulling is handled separately by ensureImagePresent().
const DEFAULT_PROBE_TIMEOUT_MS = 90 * 1000;

function probeTimeoutMs() {
    const raw = Number(process.env.PLOINKY_RUNTIME_PROBE_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROBE_TIMEOUT_MS;
}

function normalizeRuntimeFamily(runtime) {
    if (runtime === 'bwrap' || runtime === 'seatbelt') return runtime;
    if (runtime === 'docker' || runtime === 'podman') return 'container';
    return runtime;
}

function nodeMajorFromVersion(version) {
    const raw = String(version || '').split('.')[0];
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function buildRuntimeKey({ family, platform, arch, nodeMajor, variant = '' }) {
    if (!SUPPORTED_FAMILIES.has(family)) {
        throw new Error(`Unsupported runtime family: ${family}`);
    }
    if (!platform || !arch || !nodeMajor) {
        throw new Error(`Incomplete runtime-key inputs: family=${family} platform=${platform} arch=${arch} nodeMajor=${nodeMajor}`);
    }
    const variantSuffix = variant ? `-${variant}` : '';
    return `${family}-${platform}-${arch}${variantSuffix}-node${nodeMajor}`;
}

export function detectHostRuntimeKey(runtimeFamily) {
    const family = normalizeRuntimeFamily(runtimeFamily);
    if (family === 'container') {
        throw new Error('detectHostRuntimeKey does not support container runtimes; use detectContainerRuntimeKey.');
    }
    return buildRuntimeKey({
        family,
        platform: process.platform,
        arch: process.arch,
        nodeMajor: nodeMajorFromVersion(process.versions.node),
    });
}

export function detectRuntimeKeyForAgent(manifest, repoName, agentName, profileConfig = null, image = '') {
    const runtime = getRuntimeForAgent(manifest);
    const family = normalizeRuntimeFamily(runtime);
    if (family === 'container') {
        return detectContainerRuntimeKey({ manifest, profileConfig, repoName, agentName, runtime, image });
    }
    return detectHostRuntimeKey(family);
}

export function parseContainerProbeOutput(raw) {
    const text = String(raw || '').trim();
    if (!text) {
        throw new Error('Container runtime-key probe returned no output.');
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`Container runtime-key probe returned invalid JSON: ${err.message}`);
    }
    const platform = String(parsed?.platform || '').trim();
    const arch = String(parsed?.arch || '').trim();
    const nodeMajor = Number.parseInt(parsed?.nodeMajor, 10);
    const libc = String(parsed?.libc || '').trim().toLowerCase();
    if (!platform || !arch || !Number.isFinite(nodeMajor) || nodeMajor <= 0) {
        throw new Error('Container runtime-key probe response is incomplete.');
    }
    const variant = platform === 'linux' && (libc === 'glibc' || libc === 'musl')
        ? libc
        : '';
    return { platform, arch, nodeMajor, variant };
}

function defaultContainerProbe({ image, runtime }) {
    const probeScript = [
        'const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;',
        'const header = report && report.header ? report.header : null;',
        'const libc = process.platform === "linux" ? (header && header.glibcVersionRuntime ? "glibc" : "musl") : "";',
        'process.stdout.write(JSON.stringify({',
        '  platform: process.platform,',
        '  arch: process.arch,',
        '  nodeMajor: parseInt(process.versions.node.split(".")[0], 10),',
        '  libc',
        '}));',
    ].join('');
    // --pull=never: the image must already be present locally (ensureImagePresent
    // pulls it as an explicit, progress-streamed step before we get here). This
    // keeps the probe fast and turns a missing image into an instant, clear error
    // instead of a silent multi-minute pull that trips the timeout.
    const args = ['run', '--rm', '--pull=never', '--entrypoint', 'node', image, '-e', probeScript];
    const timeoutMs = probeTimeoutMs();
    const res = spawnSync(runtime, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    if (res.error) {
        if (res.error.code === 'ETIMEDOUT') {
            throw new Error(`Container runtime-key probe timed out after ${Math.round(timeoutMs / 1000)}s for image '${image}'. `
                + `The image is present, so '${runtime} run' itself is not responding — check the container runtime.`);
        }
        throw new Error(`Container runtime-key probe failed: ${res.error.message}`);
    }
    if (res.status !== 0) {
        const stderr = String(res.stderr || '').trim();
        if (/image not known|no such image|unable to find image|image not present/i.test(stderr)) {
            throw new Error(`Container image '${image}' is not present locally (probe uses --pull=never). `
                + `Pull it first: '${runtime} pull ${image}'.`);
        }
        throw new Error(`Container runtime-key probe exited with code ${res.status}${stderr ? `: ${stderr}` : ''}`);
    }
    return String(res.stdout || '').trim();
}

function defaultEnsureImage({ image, runtime }) {
    ensureImagePresent(image, { runtime });
}

export function detectContainerRuntimeKey({
    manifest = null,
    profileConfig = null,
    repoName = '',
    agentName = '',
    runtime = null,
    image = '',
    execProbe = defaultContainerProbe,
    ensureImage = defaultEnsureImage,
} = {}) {
    const resolvedImage = String(image || (manifest ? resolveManifestImage(manifest, profileConfig, { repoName, agentName }) : '')).trim();
    if (!resolvedImage) {
        throw new Error(`Container runtime-key detection requires an image${repoName || agentName ? ` for ${repoName}/${agentName}` : ''}.`);
    }
    const resolvedRuntime = runtime || getRuntime();
    // Explicit pull step (streamed progress, generous timeout) BEFORE the probe,
    // so the probe can safely run with --pull=never under a short timeout.
    ensureImage({ image: resolvedImage, runtime: resolvedRuntime, manifest, repoName, agentName });
    const output = execProbe({ image: resolvedImage, runtime: resolvedRuntime, manifest, repoName, agentName });
    const probe = parseContainerProbeOutput(output);
    return buildRuntimeKey({
        family: 'container',
        platform: probe.platform,
        arch: probe.arch,
        nodeMajor: probe.nodeMajor,
        variant: probe.variant,
    });
}

export function parseRuntimeKey(runtimeKey) {
    const match = /^([a-z]+)-([a-z0-9]+)-([a-z0-9_]+)(?:-([a-z0-9_]+))?-node(\d+)$/.exec(String(runtimeKey || ''));
    if (!match) return null;
    return {
        family: match[1],
        platform: match[2],
        arch: match[3],
        variant: match[4] || '',
        nodeMajor: parseInt(match[5], 10),
    };
}

export { normalizeRuntimeFamily, buildRuntimeKey, SUPPORTED_FAMILIES };
