import fs from 'fs';
import path from 'path';

import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from './config.js';

function isPathInsideRoot(candidate, root) {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function readManifestVolumeOptions(manifest) {
    return manifest?.volumeOptions && typeof manifest.volumeOptions === 'object'
        ? manifest.volumeOptions
        : {};
}

export function resolveManifestVolumeHostPath(hostPath, workspaceRoot = PLOINKY_WORKSPACE_ROOT) {
    return path.isAbsolute(hostPath)
        ? path.resolve(hostPath)
        : path.resolve(workspaceRoot, hostPath);
}

export function assertManifestVolumeHostPathUnderPloinky(resolvedHostPath, containerPath = '', ploinkyDir = PLOINKY_DIR) {
    if (!isPathInsideRoot(resolvedHostPath, ploinkyDir)) {
        throw new Error(
            `[volume] Manifest volume '${containerPath || resolvedHostPath}' uses host path '${resolvedHostPath}'. `
            + `Extra manifest volumes must live under '${ploinkyDir}'. `
            + 'Use .ploinky/data/<agent>/... for durable data or .ploinky/agents/<agent>/... for generated runtime files.'
        );
    }
}

export function ensureManifestVolumeHostPath(resolvedHostPath, _containerPath, options = {}) {
    if (!resolvedHostPath) return;
    const containerPath = typeof _containerPath === 'string' ? _containerPath.trim() : '';
    const hostLooksLikeFile = path.extname(resolvedHostPath) !== '';
    const containerLooksLikeFile = path.extname(containerPath) !== '';
    const shouldCreateFile = hostLooksLikeFile || containerLooksLikeFile;
    if (!fs.existsSync(resolvedHostPath)) {
        if (options?.generated === true) {
            if (options.required === true) {
                throw new Error(
                    `[volume] Missing or empty required generated volume '${containerPath || resolvedHostPath}': ${resolvedHostPath}`
                );
            }
            const parentDir = shouldCreateFile ? path.dirname(resolvedHostPath) : resolvedHostPath;
            fs.mkdirSync(parentDir, { recursive: true });
            return;
        }
        if (shouldCreateFile) {
            fs.mkdirSync(path.dirname(resolvedHostPath), { recursive: true });
            fs.writeFileSync(resolvedHostPath, '');
        } else {
            fs.mkdirSync(resolvedHostPath, { recursive: true });
        }
    }
    if (options?.generated === true && options.required === true) {
        try {
            const stat = fs.statSync(resolvedHostPath);
            if (stat.isFile() && stat.size === 0) {
                throw new Error(
                    `[volume] Missing or empty required generated volume '${containerPath || resolvedHostPath}': ${resolvedHostPath}`
                );
            }
            if (stat.isDirectory() && fs.readdirSync(resolvedHostPath).length === 0) {
                throw new Error(
                    `[volume] Missing or empty required generated volume '${containerPath || resolvedHostPath}': ${resolvedHostPath}`
                );
            }
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                throw new Error(
                    `[volume] Missing or empty required generated volume '${containerPath || resolvedHostPath}': ${resolvedHostPath}`
                );
            }
            throw err;
        }
    }
    if (options && typeof options.chmod === 'number') {
        try { fs.chmodSync(resolvedHostPath, options.chmod); } catch (_) {}
        if (options.makeWorldWritableSubdirs && Array.isArray(options.makeWorldWritableSubdirs)) {
            for (const sub of options.makeWorldWritableSubdirs) {
                const subDir = path.join(resolvedHostPath, String(sub));
                try {
                    fs.mkdirSync(subDir, { recursive: true });
                    fs.chmodSync(subDir, options.chmod);
                } catch (_) {}
            }
        }
    }
}

export function normalizeManifestVolumeHostPaths(volumes, options = {}) {
    if (!volumes || typeof volumes !== 'object') return [];
    const workspaceRoot = options.workspaceRoot || PLOINKY_WORKSPACE_ROOT;
    const ploinkyDir = options.ploinkyDir || path.join(workspaceRoot, '.ploinky');
    const paths = [];
    for (const [hostPath, containerPath] of Object.entries(volumes)) {
        const resolvedHostPath = resolveManifestVolumeHostPath(hostPath, workspaceRoot);
        assertManifestVolumeHostPathUnderPloinky(resolvedHostPath, containerPath, ploinkyDir);
        paths.push(resolvedHostPath);
    }
    return Array.from(new Set(paths));
}
