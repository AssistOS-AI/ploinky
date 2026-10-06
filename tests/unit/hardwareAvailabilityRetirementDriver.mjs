// Child-process driver for the D2S.13 retirement leaf (not a test file).
// Usage: node hardwareAvailabilityRetirementDriver.mjs <phase> <json-argument>
// Runs one ready-publication site through production entry points against the
// workspace in PLOINKY_WORKSPACE_ROOT, under the REAL workspace mutation lease,
// network-lifecycle lock and edge apply lock the site's real callers hold, and
// prints one JSON line. Retirement is the real helper; a spy only records what
// the selector said at the moment retirement started, and collects its log.
//
//   site-s  start's post-readiness merge: the real mergeRoutingConfig and the real retireStartReadyPublications
//   site-a  the additive activation: the real activatePreparedRuntimeAfterReadiness, the real apply lock; the selector switch is a real apply
//   site-r  the replacement activation: the real function and the real mergeRoutingConfig under an inactive selector
//   site-t  the targeted restart: the real prepare and commit and the real mergeRoutingConfig
//   shell-lifecycle  the `shell` command's lifecycle work (runShellLifecycle) around the real additive activation; `hold` makes the caller hold the workspace lease first
//   merge-capabilities  what a coordinated and a `coordinate: false` merge hand their mutators
//
// Argument fields: { routeKey, container, registryRecord, hostPort, ready, failure, breakCommit, noCapabilities,
//                    countCommits, countLoader, breakGeneration, fsyncFails, killAtRetire, noLease }
//   failure: 'apply' (the merge or switch throws) | 'verify' (targeted restart: the published route is not the exact owner) | 'commit' (additive switch throws)
//   countCommits     record every retirement commit call (`commits`: the entry and slot keys it writes, `slots: null` when it passes none)
//   countLoader      count the helper's generation loads (`loaderCalls`); the load itself is the real one
//   breakGeneration  the helper's generation load throws (counted as well)
//   fsyncFails       the real commit, whose directory fsync of the store fails after the rename (committed, durability unconfirmed)
//   killAtRetire     the real commit, and this process SIGKILLs itself just before the rename, holding every lock it took;
//                    it first writes `KILL_MARKER` in the workspace with its pid
//   noLease          the site runs under the network-lifecycle lock only, as `ploinky cli <agent>` does (no workspace lease)

import fs from 'node:fs';
import path from 'node:path';

const root = process.env.PLOINKY_WORKSPACE_ROOT;
const [phase, rawArgument] = process.argv.slice(2);
const argument = rawArgument ? JSON.parse(rawArgument) : {};
const cli = (relative) => import(new URL(`../../cli/${relative}`, import.meta.url).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const agentsFile = path.join(root, '.ploinky', 'agents.json');
const routingFile = path.join(root, '.ploinky', 'routing.json');
const KILL_MARKER = 'retirement-killed-before-rename.json';

async function run() {
    const locks = await cli('utils/runtime/maintenanceLocks.js');
    const network = await cli('sandbox/networkLifecycle.js');
    const edge = await cli('sandbox/edgeGeneration.js');
    const coordinated = await cli('sandbox/coordinatedEdgeApply.js');
    const routing = await cli('server/routingFile.js');
    const store = await cli('sandbox/hardwareAvailabilityStore.mjs');
    const retirement = await cli('commands/hardwareAvailabilityRetirement.js');
    const workspaceUtil = await cli('commands/workspaceUtil.js');
    const restart = await cli('commands/targetedAgentRestart.js');

    const logs = [];
    const log = (type, data) => logs.push({ type, ...data });
    const witnesses = [];
    const paths = edge.resolveEdgeGenerationPaths({ workspaceRoot: root });
    const selection = () => {
        const { selector } = edge.readEdgeRoutingSelection({ workspaceRoot: root });
        return { state: selector.state, generation: selector.generation || '', previousGeneration: selector.previousGeneration || '', activationId: selector.activationId || '' };
    };
    const entryKeys = () => Object.keys(store.readHardwareAvailabilityPolicy({ paths }).entries).sort();
    const slotKeys = () => Object.keys(store.readHardwareAvailabilityPolicy({ paths }).slots).sort();
    const commits = [];
    const returns = [];
    let loaderCalls = 0;
    const describeCommit = (args) => ({
        entries: Object.keys(args.entries || {}).sort(),
        slots: Object.prototype.hasOwnProperty.call(args, 'slots') ? Object.keys(args.slots || {}).sort() : null,
        expectedRevision: args.expectedRevision ?? null,
    });
    // An fs facade whose fsync of the store directory fails (EIO): the store throws only after its rename.
    const fsyncFailingFs = () => {
        const directories = new Set();
        return {
            ...fs,
            constants: fs.constants,
            openSync: (target, flags, mode) => {
                const descriptor = fs.openSync(target, flags, mode);
                if (String(target) === paths.availabilityStoreDir) directories.add(descriptor);
                else directories.delete(descriptor);
                return descriptor;
            },
            closeSync: (descriptor) => { directories.delete(descriptor); return fs.closeSync(descriptor); },
            fsyncSync: (descriptor) => {
                if (directories.has(descriptor)) throw Object.assign(new Error('EIO: the fixture failed the store directory fsync'), { code: 'EIO' });
                return fs.fsyncSync(descriptor);
            },
        };
    };
    const retirementCommit = () => {
        if (argument.breakCommit) return { commit: (args) => { commits.push(describeCommit(args)); throw new Error('the retirement commit failed'); } };
        if (argument.fsyncFails) return { commit: (args) => { commits.push(describeCommit(args)); return store.commitHardwareAvailabilityPolicy({ ...args, fsApi: fsyncFailingFs() }); } };
        if (argument.killAtRetire) {
            return { commit: (args) => {
                commits.push(describeCommit(args));
                return store.commitHardwareAvailabilityPolicy({ ...args, beforeRename: () => {
                    fs.writeFileSync(path.join(root, KILL_MARKER), JSON.stringify({ pid: process.pid, commit: describeCommit(args) }));
                    process.kill(process.pid, 'SIGKILL');
                } });
            } };
        }
        if (argument.countCommits) return { commit: (args) => { commits.push(describeCommit(args)); return store.commitHardwareAvailabilityPolicy(args); } };
        return {};
    };
    const generationLoader = () => ((argument.countLoader || argument.breakGeneration)
        ? { loadGeneration: (options) => {
            loaderCalls += 1;
            if (argument.breakGeneration) throw Object.assign(new Error('the fixture broke the generation load'), { code: 'FIXTURE_GENERATION_LOAD_FAILED' });
            return edge.loadActiveEdgeRoutingGeneration(options).generation;
        } }
        : {});
    // The real helper; the spy records the selector and the store at the moment retirement STARTS.
    const spyRetire = (options) => {
        witnesses.push({
            site: options.site, selector: selection(), entries: entryKeys(), slots: slotKeys(),
            revision: store.readHardwareAvailabilityPolicy({ paths }).revision,
            lease: locks.heldWorkspaceMutationLease()?.operation ?? null,
        });
        const value = retirement.retireSameTupleHardwareEntries({
            ...options,
            log,
            ...retirementCommit(),
            ...generationLoader(),
        });
        returns.push(value);
        return value;
    };
    const spyAfterApply = (options) => retirement.retireSameTupleAfterApply({ ...options, retire: spyRetire, log });
    const underStartLocks = (operation, callback) => (argument.noLease
        ? network.withNetworkLifecycleLock(callback)
        : locks.withWorkspaceMutationLease({ operation }, () => network.withNetworkLifecycleLock(callback)));
    const result = (extra = {}) => ({
        phase, witnesses, logs, entriesAfter: entryKeys(), slotsAfter: slotKeys(), selectorAfter: selection(),
        commits, returns, loaderCalls, ...extra,
    });
    const failure = (error) => ({ code: error?.code || null, message: String(error?.message || error).slice(0, 300) });
    const record = () => structuredClone(argument.registryRecord);
    const successorRecord = () => ({ ...record(), ...(argument.hostPort ? { runtime: 'podman', containerId: 'c'.repeat(64) } : {}) });

    if (phase === 'merge-capabilities') {
        const seen = {};
        const proves = (assertion) => { try { assertion(); return true; } catch (_) { return false; } };
        // Liveness is judged inside the mutator, while the merge still holds its locks.
        await underStartLocks('merge-capabilities', async () => {
            await routing.mergeRoutingConfig((current, capabilities) => {
                seen.coordinated = {
                    applyLockLive: proves(() => edge.assertEdgeGenerationApplyLockCapability({ workspaceRoot: root, applyLockCapability: capabilities?.applyLockCapability, storePaths: paths })),
                    networkLive: proves(() => network.assertNetworkLifecycleCapability(capabilities?.networkLifecycleCapability)),
                };
                return current;
            }, { reason: 'fixture-coordinated' });
            await routing.mergeRoutingConfig((current, capabilities) => {
                seen.uncoordinated = { applyLockCapability: capabilities?.applyLockCapability ?? null, networkLifecycleCapability: capabilities?.networkLifecycleCapability ?? null };
                return current;
            }, { coordinate: false });
        });
        return result({ coordinated: seen.coordinated, uncoordinated: seen.uncoordinated });
    }

    if (phase === 'site-s') {
        let mergeError = null;
        let retired = null;
        try {
            await underStartLocks('start', async () => {
                await routing.mergeRoutingConfig((current, capabilities) => {
                    // The exact call start's post-readiness mutator makes.
                    retired = retirement.retireStartReadyPublications({
                        current,
                        registry: readJson(agentsFile),
                        readyAgentKeys: argument.ready,
                        capabilities: argument.noCapabilities ? undefined : capabilities,
                        retire: spyRetire,
                        log,
                    });
                    if (argument.failure === 'apply') throw new Error('the apply failed after the mutator');
                    return current;
                }, { reason: 'workspace-runtime-graph-ready' });
            });
        } catch (error) { mergeError = failure(error); }
        return result({ retired, mergeError });
    }

    if (phase === 'site-a') {
        const container = argument.container;
        let activated = null;
        let activationError = null;
        try {
            await underStartLocks('additive-activation', async (networkLifecycleCapability) => {
                const outcome = await workspaceUtil.activatePreparedRuntimeAfterReadiness({
                    result: { requiresEdgeActivation: true, containerName: container, registryRecord: successorRecord(), hostPort: argument.hostPort || 0, preparationLease: { mode: 'additive' } },
                    routeKey: argument.routeKey, repoName: 'fixtures', shortAgentName: argument.routeKey, agentPath: path.join(root, '.ploinky', 'repos', 'fixtures', argument.routeKey),
                    networkLifecycleCapability,
                }, {
                    withApplyLock: (callback) => edge.withEdgeGenerationApplyLock(callback, { workspaceRoot: root }),
                    // The additive commit: write the candidate sources, then really switch the selector under the held capability.
                    commitAdditive: (lease, { agents, routing: nextRouting, applyLockCapability }) => {
                        if (argument.failure === 'commit') throw new Error('the additive commit failed');
                        fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
                        fs.writeFileSync(routingFile, JSON.stringify(nextRouting, null, 2));
                        return coordinated.applyEdgeRoutingGeneration({ workspaceRoot: root, reason: 'additive-switch', publicationState: 'ready', applyLockCapability });
                    },
                    retireEntries: spyRetire,
                    retirePredecessor: () => {},
                    retireCandidate: () => {},
                    cleanupFailure: () => {},
                });
                activated = outcome;
            });
        } catch (error) { activationError = failure(error); }
        return result({ activated, activationError });
    }

    if (phase === 'shell-lifecycle') {
        const container = argument.container;
        const agentPath = path.join(root, '.ploinky', 'repos', 'fixtures', argument.routeKey);
        let shell = null;
        let lifecycleError = null;
        let leaseAtActivation = null;
        const lifecycle = () => workspaceUtil.runShellLifecycle({
            shortAgentName: argument.routeKey, manifest: {}, agentDir: agentPath, repoName: 'fixtures',
            registryRecord: { containerName: container, record: record() }, registeredContainerName: container,
            routerEndpoint: { mode: 'default' }, directAdmission: { runtimeAdmission: {} },
        }, {
            ensureAgentService: async () => ({ requiresEdgeActivation: true, containerName: container, registryRecord: successorRecord(), hostPort: argument.hostPort || 0, preparationLease: { mode: 'additive' } }),
            waitForReadiness: async () => {},
            cleanupFailedRuntime: () => {},
            activateAfterReadiness: (options) => {
                leaseAtActivation = locks.heldWorkspaceMutationLease()?.operation ?? null;
                return workspaceUtil.activatePreparedRuntimeAfterReadiness(options, {
                    withApplyLock: (callback) => edge.withEdgeGenerationApplyLock(callback, { workspaceRoot: root }),
                    commitAdditive: (lease, { agents, routing: nextRouting, applyLockCapability }) => {
                        fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
                        fs.writeFileSync(routingFile, JSON.stringify(nextRouting, null, 2));
                        return coordinated.applyEdgeRoutingGeneration({ workspaceRoot: root, reason: 'additive-switch', publicationState: 'ready', applyLockCapability });
                    },
                    retireEntries: spyRetire,
                    retirePredecessor: () => {},
                    retireCandidate: () => {},
                    cleanupFailure: () => {},
                });
            },
        });
        try {
            shell = argument.hold
                ? await locks.withWorkspaceMutationLease({ operation: 'outer-holder' }, lifecycle)
                : await lifecycle();
        } catch (error) { lifecycleError = failure(error); }
        return result({ shell: shell ? { containerName: shell.containerName } : null, lifecycleError, leaseAtActivation });
    }

    if (phase === 'site-r') {
        const container = argument.container;
        let activated = null;
        let activationError = null;
        // The replacement preparation keeps the selector inactive until the activation applies.
        edge.inactivateEdgeRoutingGeneration('replacement-preparation', { workspaceRoot: root });
        try {
            await underStartLocks('replacement-activation', async (networkLifecycleCapability) => {
                activated = await workspaceUtil.activatePreparedRuntimeAfterReadiness({
                    result: { requiresEdgeActivation: true, containerName: container, registryRecord: successorRecord(), hostPort: argument.hostPort || 0, preparationLease: { mode: 'replacement' } },
                    routeKey: argument.routeKey, repoName: 'fixtures', shortAgentName: argument.routeKey, agentPath: path.join(root, '.ploinky', 'repos', 'fixtures', argument.routeKey),
                    networkLifecycleCapability,
                }, {
                    mergeRouting: (mutator, options) => {
                        if (argument.failure === 'apply') throw new Error('the replacement apply failed');
                        // The preparation lease is a stand-in here: the merge re-inactivates and applies the new generation.
                        return routing.mergeRoutingConfig(mutator, { ...options, preparationLease: undefined });
                    },
                    retireEntriesAfterApply: spyAfterApply,
                    retireCandidate: () => {},
                    cleanupFailure: () => {},
                });
            });
        } catch (error) { activationError = failure(error); }
        return result({ activated, activationError });
    }

    if (phase === 'site-t') {
        const container = argument.container;
        let committed = null;
        let commitError = null;
        try {
            await underStartLocks('targeted-restart', async (networkLifecycleCapability) => {
                const transition = await restart.prepareTargetedAgentRestart({
                    containerName: container, routeKey: argument.routeKey, repoName: 'fixtures', shortAgentName: argument.routeKey,
                    record: record(), networkLifecycleCapability,
                });
                const dependencies = {
                    retireEntriesAfterApply: spyAfterApply,
                    retireCandidate: () => {},
                    // The real merge inactivates the selector and runs the mutator; the publication then fails before its apply completes.
                    ...(argument.failure === 'apply'
                        ? { mergeRouting: (mutator, options) => routing.mergeRoutingConfig((current, capabilities) => {
                            mutator(current, capabilities);
                            throw new Error('the successor publication failed');
                        }, options) }
                        : {}),
                    ...(argument.failure === 'verify'
                        ? { loadActive: (() => {
                            let calls = 0;
                            return () => {
                                // The first read (the drain check) is the real one; the post-publication read names a route that is not the exact owner.
                                calls += 1;
                                const active = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: root });
                                if (calls <= 1) return active;
                                const generation = structuredClone(active.generation);
                                generation.routing.routes[argument.routeKey].agent = 'someone-else';
                                return { ...active, generation };
                            };
                        })() }
                        : {}),
                };
                committed = await restart.commitTargetedAgentRestart({
                    transition,
                    result: { containerName: container, registryRecord: successorRecord(), hostPort: argument.hostPort || 0 },
                    agentPath: path.join(root, '.ploinky', 'repos', 'fixtures', argument.routeKey),
                    networkLifecycleCapability,
                }, dependencies);
            });
        } catch (error) { commitError = failure(error); }
        return result({ committed: Boolean(committed), commitError });
    }
    throw new Error(`unknown phase '${phase}'`);
}

run().then((value) => process.stdout.write(`${JSON.stringify(value)}\n`), (error) => {
    process.stdout.write(`${JSON.stringify({ driverError: String(error?.stack || error) })}\n`);
    process.exitCode = 1;
});
