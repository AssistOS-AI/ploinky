import fs from 'fs';
import path from 'path';

import { PLOINKY_WORKSPACE_ROOT } from '../config.js';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';
import { isManagedManifestVolumeSource } from '../../sandbox/runtimeCapabilities.js';
import {
    assertCanonicalAgentDataPath,
    assertManifestVolumeStoragePolicy,
    ensureAgentDataDirectory,
    isPathWithin,
} from './agentDataPathPolicy.js';

export function readManifestVolumeOptions(manifest) {
    return manifest?.volumeOptions && typeof manifest.volumeOptions === 'object'
        ? manifest.volumeOptions
        : {};
}

export function resolveManifestVolumeHostPath(hostPath, workspaceRoot = PLOINKY_WORKSPACE_ROOT) {
    const resolved = assertManifestVolumeStoragePolicy(hostPath, { workspaceRoot });
    if (isInsideBox() && !isManagedManifestVolumeSource(String(hostPath), { workspaceRoot })) {
        const error = new Error(`manifest volume source '${hostPath}' is outside the managed Ploinky workspace`);
        error.code = 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED';
        error.status = 422;
        throw error;
    }
    const dataRoot = path.join(path.resolve(workspaceRoot), '.data');
    if (isPathWithin(resolved, dataRoot)) {
        assertCanonicalAgentDataPath(resolved, { workspaceRoot });
    }
    return resolved;
}

export function ensureManifestVolumeHostPath(resolvedHostPath, _containerPath, options = {}, {
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    if (!resolvedHostPath) return;
    const dataRoot = path.join(path.resolve(workspaceRoot), '.data');
    const dataBacked = isPathWithin(resolvedHostPath, dataRoot);
    const revalidate = () => {
        assertManifestVolumeStoragePolicy(resolvedHostPath, { workspaceRoot });
        if (dataBacked) assertCanonicalAgentDataPath(resolvedHostPath, { workspaceRoot });
    };
    const ensureDirectory = (directory) => {
        if (dataBacked) {
            ensureAgentDataDirectory(directory, { workspaceRoot });
        } else {
            fs.mkdirSync(directory, { recursive: true });
        }
    };
    revalidate();
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
            ensureDirectory(parentDir);
            revalidate();
            return;
        }
        if (shouldCreateFile) {
            ensureDirectory(path.dirname(resolvedHostPath));
            revalidate();
            fs.writeFileSync(resolvedHostPath, '');
        } else {
            ensureDirectory(resolvedHostPath);
        }
        revalidate();
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
                    if (dataBacked) ensureAgentDataDirectory(subDir, { workspaceRoot });
                    else fs.mkdirSync(subDir, { recursive: true });
                    fs.chmodSync(subDir, options.chmod);
                } catch (error) {
                    if (error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION') throw error;
                }
            }
        }
    }
    revalidate();
}

export function normalizeManifestVolumeHostPaths(volumes, options = {}) {
    if (!volumes || typeof volumes !== 'object') return [];
    const workspaceRoot = options.workspaceRoot || PLOINKY_WORKSPACE_ROOT;
    const paths = [];
    for (const hostPath of Object.keys(volumes)) {
        const resolvedHostPath = resolveManifestVolumeHostPath(hostPath, workspaceRoot);
        paths.push(resolvedHostPath);
    }
    return Array.from(new Set(paths));
}

export function assertManifestStorageAdmission(manifest, profileConfig = null, {
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    const rootVolumes = manifest?.volumes && typeof manifest.volumes === 'object'
        ? manifest.volumes
        : {};
    const profileVolumes = profileConfig?.volumes && typeof profileConfig.volumes === 'object'
        ? profileConfig.volumes
        : {};
    for (const source of [...Object.keys(rootVolumes), ...Object.keys(profileVolumes)]) {
        resolveManifestVolumeHostPath(source, workspaceRoot);
    }
    return true;
}
