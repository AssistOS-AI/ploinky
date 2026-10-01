// Test-only probe: runs the production graph reuse decision
// (graphNodeRuntimeReplacementReason) for fixture agents in a fresh process
// bound to a temporary workspace, so the persisted Router port and every
// workspace path resolve inside that fixture. The engine is stubbed; the
// admitted descriptor comes from the real admission with the fixture Box
// marker and the supplied hardware context.
//
//   node graphReuseProbe.mjs SPEC.json
//
// SPEC: {markerPath, hardwareContext, llmEnv?, agents:[{key, ref, manifest,
// running:{manifest?, hardwareContext?, admitted?:boolean}}]}
// Prints {results:{key: reason}, probes:{key: [optionKeys]}} as JSON.

import fs from 'node:fs';
import path from 'node:path';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { graphNodeRuntimeReplacementReason } = await import('../../cli/commands/workspaceUtil.js');
const {
    admitManifestRuntimeCapabilities,
    hardwareLimitsHashOf,
} = await import('../../cli/sandbox/runtimeCapabilities.js');
const {
    prepareLlmStartup,
    resolveLlmRuntimeAdmissionContext,
} = await import('../../cli/sandbox/docker/llmRuntimeIntegration.js');

function revive(context) {
    if (!context || typeof context !== 'object') return context;
    return { ...context, overrides: new Map(Object.entries(context.overrides || {})) };
}

const workDirRoot = path.join(process.env.PLOINKY_WORKSPACE_ROOT, 'llm-work');
const llmEnv = spec.llmEnv || {};

function admission(agent, manifest, hardwareContext) {
    const [repoName, agentName] = agent.ref.split('/');
    const llm = manifest.llmRuntime?.enabled
        ? resolveLlmRuntimeAdmissionContext({ runtime: 'podman', manifest, profileConfig: null, agentName, env: llmEnv })
        : null;
    const admitted = admitManifestRuntimeCapabilities(manifest, {
        boxMarkerOptions: { markerPath: spec.markerPath },
        workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT,
        agentId: `${repoName}/${agentName}`,
        runtime: 'podman',
        hardwareAdmission: 'metadata',
        hardwareContext: revive(hardwareContext),
        instanceKey: agent.key,
        catalogPolicy: llm?.catalogPolicy ?? null,
        catalogIdentity: llm?.catalogIdentity ?? null,
    });
    return { descriptor: admitted.descriptor, llmStartup: llm?.startup || null };
}

function llmProbe(options) {
    // The engine-facing environment and work directory are fixture-owned; the
    // admitted policy and resolved selection/hardware come from the caller.
    return prepareLlmStartup({ ...options, env: llmEnv, agentWorkDirRoot: workDirRoot, createDirectories: false, writeState: false });
}

const results = {};
const probes = {};
for (const agent of spec.agents) {
    const [repoName, agentName] = agent.ref.split('/');
    const running = agent.running || {};
    const runningManifest = running.manifest || agent.manifest;
    const runningContext = running.hardwareContext || spec.hardwareContext;
    const runningAdmission = admission(agent, runningManifest, runningContext);
    // Labels of the running runtime, as creation wrote them.
    const labels = {
        'ploinky.envhash': 'envhash',
        'ploinky.limitshash': hardwareLimitsHashOf(runningAdmission.descriptor),
    };
    if (runningManifest.llmRuntime?.enabled) {
        const created = llmProbe({
            runtime: 'podman', manifest: runningManifest, profileConfig: null, agentName, alias: '',
            manifestEnvNames: [], envHash: 'envhash', effectiveNetwork: null,
            ...(running.admitted === false ? {} : {
                admittedRuntimePolicy: runningAdmission.descriptor.runtimePolicy,
                resolvedSelection: runningAdmission.llmStartup?.selection,
                resolvedHardware: runningAdmission.llmStartup?.hardware,
            }),
        });
        labels['ploinky.reusehash'] = created.reuseHash;
    }
    const node = {
        id: agent.key, repoName, shortAgentName: agentName, manifest: agent.manifest, alias: '', profile: '',
    };
    const plan = {
        node,
        existing: { key: agent.key, rec: { instanceId: `${agent.key}-instance`, enableGeneration: `${agent.key}-generation`, alias: '' } },
    };
    probes[agent.key] = [];
    results[agent.key] = graphNodeRuntimeReplacementReason(plan, {
        containerExistsImpl: () => true,
        isContainerRunningImpl: () => true,
        getRuntimeForAgentImpl: () => 'podman',
        getRuntimeImpl: () => 'podman',
        computeEnvHashImpl: () => 'envhash',
        computeRetainedManagedEnvHashImpl: () => 'envhash',
        getContainerLabelImpl: (_key, label) => labels[label] ?? '',
        getManifestEnvNamesImpl: () => [],
        getExposedNamesImpl: () => [],
        admitRuntimeImpl: () => admission(agent, agent.manifest, spec.hardwareContext),
        prepareLlmStartupImpl: (options) => {
            probes[agent.key] = Object.keys(options).filter((name) => ['admittedRuntimePolicy', 'resolvedSelection', 'resolvedHardware'].includes(name) && options[name] !== undefined).sort();
            return llmProbe(options);
        },
        createNetworkLifecycleAdapterImpl: () => ({ inspectContainerContract: () => ({ state: 'owned' }) }),
    });
}
process.stdout.write(`${JSON.stringify({ results, probes })}\n`);
