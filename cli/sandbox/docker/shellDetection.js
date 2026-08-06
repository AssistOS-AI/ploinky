import { spawnSync } from 'child_process';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { getRuntime } from './common.js';
import { buildManagedProbeRunArgs } from './probeOwnership.js';

const SHELL_PROBE_PATHS = ['/bin/bash', '/bin/sh', '/bin/ash', '/bin/dash', '/bin/zsh', '/bin/fish', '/bin/ksh'];
const SHELL_FALLBACK_DIRECT = Symbol('no-shell');
const shellDetectionCache = new Map();

function normalizeMountPath(raw) {
    const lines = String(raw || '').trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return '';
    const last = lines[lines.length - 1];
    const colonIdx = last.indexOf(':');
    if (colonIdx > 0 && !last.startsWith('/')) {
        return last.slice(colonIdx + 1).trim();
    }
    return last.trim();
}

function findShellInMount(mountPath) {
    for (const shellPath of SHELL_PROBE_PATHS) {
        const relPath = shellPath.replace(/^\/+/, '');
        const candidate = path.join(mountPath, relPath);
        try {
            const stats = fs.statSync(candidate);
            if (stats.isFile() && (stats.mode & 0o111)) {
                return shellPath;
            }
        } catch (_) {}
    }
    return '';
}

function detectShellViaImageMount(image, runtime) {
    if (runtime !== 'podman') return '';
    let mountPoint = '';
    try {
        const mountRes = spawnSync(runtime, ['image', 'mount', image], { stdio: ['ignore', 'pipe', 'pipe'] });
        if (mountRes.status !== 0) return '';
        mountPoint = normalizeMountPath(mountRes.stdout || mountRes.stderr);
        if (!mountPoint) return '';
        const shellPath = findShellInMount(mountPoint);
        return shellPath;
    } finally {
        if (mountPoint) {
            try { spawnSync(runtime, ['image', 'unmount', mountPoint], { stdio: 'ignore' }); } catch (_) {}
        }
    }
}

function buildShellDetectionRunArgs(image, shellPath, probeOwnership) {
    return [
        'run',
        '--rm',
        ...buildManagedProbeRunArgs({
            ...probeOwnership,
            purpose: 'shell-detection',
            imageId: image,
        }),
        '--entrypoint',
        'test',
        image,
        '-x',
        shellPath,
    ];
}

function detectShellViaContainerRun(image, runtime, probeOwnership) {
    for (const shellPath of SHELL_PROBE_PATHS) {
        // Use --entrypoint to bypass any custom ENTRYPOINT (e.g. Keycloak's
        // kc.sh) that would intercept the probe command.
        const res = spawnSync(
            runtime,
            buildShellDetectionRunArgs(image, shellPath, probeOwnership),
            { stdio: 'ignore' },
        );
        if (res.status === 0) {
            return shellPath;
        }
    }
    return '';
}

function exactLocalImageId(image, runtime) {
    const result = spawnSync(runtime, ['image', 'inspect', '--format', '{{.Id}}', image], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const imageId = String(result.stdout || '').trim().replace(/^sha256:/, '');
    return !result.error && result.status === 0 && /^[a-f0-9]{64}$/.test(imageId)
        ? imageId
        : '';
}

function detectShellForImage(agentName, image, runtime = null, {
    probeOwnership = null,
} = {}) {
    if (!agentName || !image) {
        throw new Error('[start] Missing agent or image for shell detection.');
    }
    const resolvedRuntime = runtime || getRuntime();
    const imageId = exactLocalImageId(image, resolvedRuntime);
    if (!imageId) {
        throw new Error(`[start] ${agentName}: image must resolve to one exact local immutable ID for shell detection.`);
    }
    const exactProbeOwnership = probeOwnership || {
        owner: String(agentName),
        releaseGeneration: crypto.createHash('sha256')
            .update(`unreleased-probe\0${imageId}`)
            .digest('hex'),
    };
    const cacheKey = `${resolvedRuntime}:${imageId}`;
    if (shellDetectionCache.has(cacheKey)) {
        return shellDetectionCache.get(cacheKey);
    }
    const fromMount = detectShellViaImageMount(imageId, resolvedRuntime);
    const shellPath = fromMount
        || detectShellViaContainerRun(imageId, resolvedRuntime, exactProbeOwnership);
    const finalShell = shellPath || SHELL_FALLBACK_DIRECT;
    shellDetectionCache.set(cacheKey, finalShell);
    return finalShell;
}

export {
    SHELL_FALLBACK_DIRECT,
    buildShellDetectionRunArgs,
    detectShellForImage
};
