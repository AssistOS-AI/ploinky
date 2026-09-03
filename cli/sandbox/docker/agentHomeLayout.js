import path from 'node:path';
import { normalizeRuntimeMountTarget } from '../../utils/runtime/legacyAgentDataGuards.js';

export function resolveAgentHomeLayout({ cwd, cwdMountTarget, agentHomeDir }) {
    const projectSource = path.resolve(cwd);
    const homeSource = path.resolve(agentHomeDir);
    const projectTarget = normalizeRuntimeMountTarget(cwdMountTarget);
    // Static agents project the workspace at /root. Keep their project CWD and
    // output paths while giving HOME its own persistent per-instance directory.
    const containerHome = projectTarget === '/root' && projectSource !== homeSource
        ? '/home/agent'
        : '/root';
    return {
        containerHome,
        binds: [
            { source: projectSource, target: projectTarget },
            ...(projectSource === homeSource && projectTarget === containerHome ? [] : [
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
