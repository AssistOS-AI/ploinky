import path from 'node:path';
import { resolveManifestVolumeHostPath } from '../../utils/runtime/manifestVolumePolicy.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';

export function manifestHomeDirectory(volumes = {}, fallback, workspaceRoot = PLOINKY_WORKSPACE_ROOT) {
    const entries = Object.entries(volumes).filter(([, target]) => path.posix.resolve('/', target) === '/root');
    if (entries.length > 1) throw new Error('Multiple manifest volumes target /root');
    return entries.length ? resolveManifestVolumeHostPath(entries[0][0], workspaceRoot) : fallback;
}

import { normalizeRuntimeMountTarget } from '../../utils/runtime/controllerStateGuards.js';

export function resolveAgentHomeLayout({ cwd, cwdMountTarget, agentHomeDir, volumes = {}, workspaceRoot }) {
    const projectSource = path.resolve(cwd);
    const homeSource = path.resolve(manifestHomeDirectory(volumes, agentHomeDir, workspaceRoot));
    const requestedTarget = normalizeRuntimeMountTarget(cwdMountTarget);
    const explicitHome = Object.values(volumes).some(target => path.posix.resolve('/', target) === '/root');
    const projectTarget = requestedTarget === '/root' && projectSource !== path.resolve(agentHomeDir)
        ? projectSource : requestedTarget;
    const containerHome = '/root';
    return {
        containerHome,
        binds: [
            ...(explicitHome && projectTarget === '/root' ? [] : [{ source: projectSource, target: projectTarget }]),
            ...(!explicitHome && projectSource === homeSource && projectTarget === containerHome ? [] : [
                { source: homeSource, target: containerHome },
            ]),
        ],
    };
}

export function hasExactAgentHomeLayout(record, layout) {
    const homes = (record?.Config?.Env || []).filter(value => String(value).startsWith('HOME='));
    if (homes.length !== 1 || homes[0] !== `HOME=${layout.containerHome}`) return false;
    const mounts = Array.isArray(record?.Mounts) ? record.Mounts : [];
    return layout.binds.every(({ source, target }) => {
        const matching = mounts.filter(mount => mount.Destination === target);
        return matching.length === 1 && matching[0].Type === 'bind'
            && matching[0].RW === true && path.resolve(matching[0].Source || '/') === source;
    });
}
