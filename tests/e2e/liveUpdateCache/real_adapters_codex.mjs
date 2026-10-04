import fs from 'node:fs';
import { LIMITS, need, parseStrictJson, validateManifest } from './manifest_codex.mjs';
import { createStopLatch, createOwnedCustody } from './execution_codex.mjs';
import { buildCommandEnvironment, monotonicNow, defaultDelay } from './host_command_codex.mjs';
import { createLinuxProcessObserver } from './linux_observer_codex.mjs';
import { createLiveObserver } from './live_admission_codex.mjs';
import { createWorkerHost } from './worker_host_codex.mjs';
import { createCachePorts } from './cache_ports_codex.mjs';
import { createGitFixture } from './git_fixture_codex.mjs';
import { createMarkerFiles } from './marker_files_codex.mjs';
import { createBrowserPort } from './browser_codex.mjs';
import { createNegativePort } from './negative_port_codex.mjs';
import { createCleanupPort } from './cleanup_port_codex.mjs';
import { createGatePort } from './gates_codex.mjs';
import { applicationMarker } from './application_marker_codex.mjs';
import { readBoundedRegularFile } from './worker_codex.mjs';
import { admitRemainingSchedule } from './contracts_codex.mjs';
import { createRecoveryLog } from './recovery_codex.mjs';

// The one place real adapters are assembled. Nothing here is a mock: every port launches the real engine, Git, outer CLI,
// worker, browser or smoke entrypoint through the owned command runner or its own retained handle.
export function createRunEnvironment({ nowWall = () => Date.now() } = {}) {
    const latch = createStopLatch(), custody = createOwnedCustody();
    const clock = { mono: monotonicNow, wall: nowWall, delay: defaultDelay };
    return { latch, custody, clock };
}

export function createRealPorts({ manifestPath, latch, custody, clock, io = fs, processEnv = process.env }) {
    return async function createPorts({ manifest, inputs, check }) {
        const observerLinux = createLinuxProcessObserver();
        const deps = { latch, custody, runId: manifest.runId, register: observerLinux.register, current: observerLinux.current, now: clock.mono, delay: clock.delay };
        const env = buildCommandEnvironment(processEnv, { PLOINKY_WORKSPACE_ROOT: manifest.workspace.path });
        const workerHost = createWorkerHost({ manifest, deps, io, processEnv });
        const observer = createLiveObserver({ manifest, deps, statusProof: () => workerHost.status(), env });
        const cache = createCachePorts({ manifest, deps, env });
        const fixture = createGitFixture({ manifest, deps, probeAgentImage: inputs.probeAgentImage, env });
        const markerFiles = createMarkerFiles({ manifest, io });
        const browser = createBrowserPort({ manifest, markerFiles, check, processEnv });
        const negative = createNegativePort({ manifest, manifestPath, deps, env, io });
        const cleanup = createCleanupPort({ manifest, cache, fixture, markerFiles, marker: applicationMarker(manifest), io });
        let gatePort = null;
        const release = {
            async load() {
                const bytes = readBoundedRegularFile(manifest.evidence.release, LIMITS.manifestBytes, io);
                const releaseManifest = validateManifest(parseStrictJson(bytes, LIMITS.manifestBytes));
                // Its own grant must be open and cover the stages still to run, not the whole schedule again.
                need(releaseManifest.grant.startsAtMs <= clock.wall(), 'resource-window'); admitRemainingSchedule({ firstPhase: 'U7c', remainingMs: releaseManifest.grant.endsAtMs - clock.wall() });
                // The gates run only against the release manifest that has just been loaded and validated.
                gatePort = createGatePort({ manifest: releaseManifest, inputs, deps, processEnv, io });
                return releaseManifest;
            },
            observerFor(releaseManifest) {
                const releaseHost = createWorkerHost({ manifest: releaseManifest, deps, io, processEnv });
                return createLiveObserver({ manifest: releaseManifest, deps, statusProof: () => releaseHost.status(), env: buildCommandEnvironment(processEnv, { PLOINKY_WORKSPACE_ROOT: releaseManifest.workspace.path }) });
            },
        };
        const recovery = createRecoveryLog({ root: manifest.evidence.root, runId: manifest.runId, io });
        const gates = { async run(gate) { need(gatePort, 'gate-port-unavailable'); return gatePort.run(gate); } };
        return Object.freeze({ recovery, clock, custody, observer, workerHost, cache, fixture, browser, negative, cleanup, release, gates, async close() { await browser.close(); } });
    };
}
