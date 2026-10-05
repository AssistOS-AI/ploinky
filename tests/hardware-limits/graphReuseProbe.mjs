// Test-only probe: runs the production graph reuse decision
// (graphNodeRuntimeReplacementReason) for fixture agents in a fresh process
// bound to a temporary workspace, so the persisted Router port and every
// workspace path resolve inside that fixture. The engine is stubbed; the
// admitted descriptor comes from the real admission with the fixture Box
// marker and the supplied hardware context. Hardware detection is fixed
// (no probe command and no engine inspection), so no engine is reached.
//
//   node graphReuseProbe.mjs SPEC.json
//
// SPEC: {markerPath, hardwareContext, llmEnv?, agents:[{key, ref, manifest,
// profile?, running:{manifest?, hardwareContext?, admitted?:boolean}}]}
// A profile is resolved by the production profile resolver for both the
// running and the desired manifest.
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
const { detectHardware } = await import('../../cli/sandbox/docker/hardwareDetection.js');
const { resolveManifestRuntimeProfile } = await import('../../cli/utils/runtime/profileService.js');

const OFFLINE_HARDWARE = detectHardware({ runtime: 'podman', arch: 'x64', probes: {}, podmanInspect: () => null });

function revive(context) {
    if (!context || typeof context !== 'object') return context;
    return { ...context, overrides: new Map(Object.entries(context.overrides || {})) };
}

const workDirRoot = path.join(process.env.PLOINKY_WORKSPACE_ROOT, 'llm-work');
const llmEnv = spec.llmEnv || {};

function resolveProfile(agent, manifest) {
    return resolveManifestRuntimeProfile(manifest, {
        agentName: agent.ref, profileName: agent.profile || undefined, fallbackProfileName: 'default',
    });
}

function isLlm(manifest, profileConfig) {
    return manifest.llmRuntime?.enabled === true || profileConfig?.llmRuntime?.enabled === true;
}

function admission(agent, manifest, hardwareContext) {
    const [repoName, agentName] = agent.ref.split('/');
    const profile = resolveProfile(agent, manifest);
    const llm = isLlm(manifest, profile.profileConfig)
        ? resolveLlmRuntimeAdmissionContext({
            runtime: 'podman', manifest, profileConfig: profile.profileConfig, agentName, env: llmEnv, resolvedHardware: OFFLINE_HARDWARE,
        })
        : null;
    const admitted = admitManifestRuntimeCapabilities(manifest, {
        boxMarkerOptions: { markerPath: spec.markerPath },
        workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT,
        agentId: `${repoName}/${agentName}`,
        profileName: profile.resolvedProfileName,
        profileConfig: profile.profileConfig,
        network: profile.network,
        runtime: 'podman',
        hardwareAdmission: 'metadata',
        hardwareContext: revive(hardwareContext),
        instanceKey: agent.key,
        catalogPolicy: llm?.catalogPolicy ?? null,
        catalogIdentity: llm?.catalogIdentity ?? null,
    });
    return { descriptor: admitted.descriptor, llmStartup: llm?.startup || null, profileConfig: profile.profileConfig };
}

function llmProbe(options) {
    // The engine-facing environment and work directory are fixture-owned; the
    // admitted policy and resolved selection/hardware come from the caller.
    return prepareLlmStartup({
        ...options,
        resolvedHardware: options.resolvedHardware || OFFLINE_HARDWARE,
        env: llmEnv,
        agentWorkDirRoot: workDirRoot,
        createDirectories: false,
        writeState: false,
    });
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
    if (isLlm(runningManifest, runningAdmission.profileConfig)) {
        const created = llmProbe({
            runtime: 'podman', manifest: runningManifest, profileConfig: runningAdmission.profileConfig, agentName, alias: '',
            // The network creation used, exactly as the production reuse caller derives it.
            manifestEnvNames: [], envHash: 'envhash', effectiveNetwork: runningAdmission.profileConfig?.network ?? runningManifest.network ?? null,
            ...(running.admitted === false ? {} : {
                admittedRuntimePolicy: runningAdmission.descriptor.runtimePolicy,
                resolvedSelection: runningAdmission.llmStartup?.selection,
                resolvedHardware: runningAdmission.llmStartup?.hardware,
            }),
        });
        labels['ploinky.reusehash'] = created.reuseHash;
    }
    const node = {
        id: agent.key, repoName, shortAgentName: agentName, manifest: agent.manifest, alias: '', profile: agent.profile || '',
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
