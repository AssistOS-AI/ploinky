import fs from 'node:fs';
import path from 'node:path';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createRouterBindingStore } from '../../ploinky-box/routerBinding.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { agentLibFixture } from './agentlibFixture.mjs';
import { fakeRestartCore, fakeUpdateCore } from './fakeUpdateCore.mjs';

export const SCENARIO_CONTAINER_ID = 'a'.repeat(64);

const quiet = () => ({ isTTY: false, write() { return true; } });

/**
 * A real Box supervisor whose engine, reconcile and health seams are fakes,
 * for update transaction tests. Every home-rooted default (lock manager,
 * update host state, Router binding store) is rooted under `root`, never the
 * user's home. Pass `runUpdateCore: null` to keep the production bounded
 * update runner (`runBoundedUpdateCommand`).
 *
 * The caller owns `root` and removes it.
 */
export function createUpdateBoxScenario({
    root,
    workspace = path.join(root, 'workspace'),
    graph: initialGraph = { running: true, configured: true },
    store = createMemoryUpdateHostState(),
    lockManager = null,
    engineName = 'podman',
    runner = null,
    runUpdateCore = undefined,
    core = {},
    restartCore = null,
    probe = () => ({ ok: true, pids: [] }),
    events = [],
    overrides = {},
} = {}) {
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const selection = agentLibFixture(identity.workspaceRoot);
    const graph = { ...initialGraph };
    const ownership = () => ({
        state: 'owned',
        engine: { name: engineName, identity: 'engine' },
        handles: { container: { id: SCENARIO_CONTAINER_ID, runtime: { running: graph.running } } },
    });
    const prepared = {
        action: 'reused',
        ownership: ownership(),
        hostPort: 8080,
        mediaHostPort: 7882,
        previousAgentLib: selection,
        validate() {},
        finalize() { events.push('finalize'); },
        async rollback() {
            events.push('rollback');
            return { action: 'reused-preserved', containerId: SCENARIO_CONTAINER_ID, hostPort: 8080, mediaHostPort: 7882, agentLib: selection };
        },
    };
    const coreCommand = async (_engine, _id, argv) => { events.push(['core', [...argv]]); };
    const selectedUpdateCore = runUpdateCore === undefined
        ? fakeUpdateCore({ onCall({ argv }) { events.push(['core', [...argv]]); }, ...core })
        : runUpdateCore;
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: lockManager || {
            async acquire() {
                events.push('lock');
                return { assertHeld() {}, release() { events.push('release'); } };
            },
        },
        discover: () => ownership(),
        repositoryRoot: root,
        env: {},
        stdout: quiet(),
        stderr: quiet(),
        updateHostState: store,
        routerBindingStore: createRouterBindingStore({ homeDirectory: path.join(root, 'home') }),
        runner: runner || {
            run() {},
            query: () => ({ ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: graph.configured }) }),
        },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        updateWorkspacePloinky: async () => null,
        updateAgentLib: async () => ({ selection, changed: false, previous: selection }),
        selectAgentLib: async () => ({ selection }),
        reconcile: async () => { events.push('reconcile'); return prepared; },
        runCoreCommand: coreCommand,
        runRestartCore: restartCore || fakeRestartCore(coreCommand),
        ...(selectedUpdateCore ? { runUpdateCore: selectedUpdateCore } : {}),
        probeUpdateQuiescence: (options) => { events.push('probe'); return probe(options); },
        resolveHostReachableIpv4: async () => '',
        healthCheck: async () => { events.push('health'); },
        revalidateAgentLibSource() {},
        commitAgentLibSelection() { events.push('commit-agentlib'); },
        readAgentLibActive: () => null,
        restoreAgentLibActive() {},
        ...overrides,
    });
    return { supervisor, identity, selection, events, store, graph, prepared };
}

export const scenarioCoreCalls = events => events
    .filter(event => Array.isArray(event) && event[0] === 'core')
    .map(event => event[1]);
