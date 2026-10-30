import path from 'path';

import { PLOINKY_WORKSPACE_ROOT } from '../config.js';
import { describeAgent } from '../agentRegistry.js';
import { readAgentRegistrySnapshot } from '../agentRegistrySnapshot.js';
import { sanitizeAgentDataName } from '../workspaceStructure.js';
import {
    AGENT_DATA_POLICY_CODE,
    assertCanonicalAgentDataPath,
    ensureAgentDataDirectory,
    validateAgentDataKey,
} from './agentDataPathPolicy.js';

/**
 * The private data directories the agent registry declares: for every
 * registered agent instance its home (`.data/<instance>`) and the storage key
 * of its manifest's `runtime.resources.persistentStorage` (`.data/<key>`).
 * Manifest volumes under `.data` are not read here; they are covered when the
 * directory already exists, because the guard also masks every existing
 * first-level `.data` directory.
 *
 * With `create`, each declared directory is created through the agent data
 * policy first. A peer that is registered but has not started yet then already
 * has the directory a mask needs. This holds only for agents that already have
 * a registry record when this one launches (the enable step builds the record,
 * cli/utils/agents.js) and whose manifest `describeAgent` can locate; any
 * other peer is masked once its directory exists and a later launch plans the
 * guards again. Creation is skipped for a read-only adoption, which must change
 * nothing; the declared set is then limited to what already exists.
 *
 * The registry read, manifest lookup and creation are injectable for tests.
 */
export function collectRegisteredPeerAgentDataRoots({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    create = false,
    readRegistry = () => readAgentRegistrySnapshot({ workspaceRoot }),
    describe = describeAgent,
    ensureDirectory = target => ensureAgentDataDirectory(target, { workspaceRoot }),
} = {}) {
    const root = path.resolve(workspaceRoot);
    const dataRoot = path.join(root, '.data');
    const declared = new Set();
    const declare = (target) => {
        try {
            assertCanonicalAgentDataPath(target, { workspaceRoot: root });
        } catch (error) {
            if (error?.code === AGENT_DATA_POLICY_CODE) return;
            throw error;
        }
        declared.add(target);
    };
    for (const [name, record] of Object.entries(readRegistry() || {})) {
        if (name.startsWith('_') || !record || typeof record !== 'object') continue;
        const agentName = typeof record.agentName === 'string' ? record.agentName : '';
        const repoName = typeof record.repoName === 'string' ? record.repoName : '';
        if (!agentName) continue;
        declare(path.join(dataRoot, sanitizeAgentDataName(record.alias || agentName)));
        if (!repoName) continue;
        const key = describe(repoName, agentName)?.runtimeResources?.persistentStorage?.key;
        if (!key) continue;
        try {
            validateAgentDataKey(key, { label: 'persistentStorage.key' });
        } catch (error) {
            if (error?.code === AGENT_DATA_POLICY_CODE) continue;
            throw error;
        }
        declare(path.join(dataRoot, key));
    }
    const roots = Array.from(declared).sort();
    if (create) for (const target of roots) ensureDirectory(target);
    return roots;
}
