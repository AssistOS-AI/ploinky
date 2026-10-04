import fs from 'node:fs';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { AcceptanceError, need, LIMITS } from './manifest_codex.mjs';
import { assertLiveBefore } from './contracts_codex.mjs';
import { runOwnedCommand, buildCommandEnvironment } from './host_command_codex.mjs';
import { boxInspectArgs, parseBoxInspect, engineInfoArgs, parseEngineInfo, engineIdentityOf, gpuWiringIdentityOf, publicationsId, mountsId,
    boxExecArgs } from './engine_codex.mjs';
import { PROBE_SCHEMA, PROBE_LIMITS } from './box_probe_codex.mjs';

// U0: bind the manifest to the actual running deployment before any fixture exists. Everything here is read-only:
// engine/Box/Git reads through the owned command runner, the product's status API through the pinned worker, the
// in-Box membership probe, and the Router's own health response. No observation mutates or repairs anything.
export const PROBE_BOOTSTRAP_PATH = '/opt/ploinky/tests/e2e/liveUpdateCache/box_probe_codex.mjs';
const HEALTH_BYTES = 64 * 1024;

export function expectedLiveFromManifest(manifest) {
    const repositories = manifest.candidate.repositories.map(repo => ({ name: repo.name, commit: repo.commit, pushedCommit: repo.pushedCommit,
        branch: repo.branch, upstream: repo.upstream, clean: true, detached: false }));
    return { workspace: { path: manifest.workspace.path, dev: manifest.workspace.dev, ino: manifest.workspace.ino, uid: manifest.workspace.uid },
        box: { id: manifest.box.id, imageId: manifest.box.imageId, startedAt: manifest.box.startedAt },
        candidate: { imageId: manifest.box.imageId, repositories },
        requiredGraph: manifest.graph.map(entry => ({ name: entry.name, noWait: entry.noWait, externalHealthRequired: entry.externalHealthRequired })),
        publications: publicationsId(manifest.publications),
        sourceMounts: mountsId(manifest.sourceMounts.map(mount => ({ source: mount.source, destination: mount.destination, readOnly: true }))),
        engineIdentity: manifest.engine.identity, activeGeneration: manifest.box.activeGeneration };
}

export const probeInput = manifest => ({ requiredRuntimes: manifest.graph.map(entry => ({ name: entry.name, noWait: entry.noWait })) });
export function probeBootstrap(input) {
    return Buffer.from(`const { probeMain } = await import(${JSON.stringify(PROBE_BOOTSTRAP_PATH)});\nprocess.exitCode = await probeMain({ input: ${JSON.stringify(input)} });\n`);
}

export function parseProbeOutput(bytes, input) {
    need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMITS.controlBytes, 'live-probe-output');
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new AcceptanceError('live-probe-output'); }
    need(value && value.schema === PROBE_SCHEMA && value.version === 1, 'live-probe-output');
    if (Object.hasOwn(value, 'failure')) { need(typeof value.failure === 'string' && /^probe-[a-z-]{1,48}$/.test(value.failure) && Object.keys(value).length === 3, 'live-probe-output'); throw new AcceptanceError(`live-${value.failure}`); }
    need(Object.keys(value).sort().join() === ['graph', 'schema', 'selector', 'version'].sort().join() && Array.isArray(value.graph) && value.graph.length === input.requiredRuntimes.length
        && value.selector && Object.keys(value.selector).sort().join() === ['activationId', 'generation', 'publicationState', 'state'].sort().join() && value.selector.state === 'active', 'live-probe-output');
    const keys = ['containerName', 'enableGeneration', 'generationJoin', 'graphGeneration', 'imageId', 'instanceId', 'labelsEqual', 'name', 'noWaitState', 'ready', 'runtimeId', 'running'].sort().join();
    value.graph.forEach((row, index) => {
        need(row && Object.keys(row).sort().join() === keys && row.name === input.requiredRuntimes[index].name && typeof row.ready === 'boolean' && typeof row.running === 'boolean'
            && typeof row.generationJoin === 'boolean' && typeof row.labelsEqual === 'boolean' && (row.noWaitState === null || typeof row.noWaitState === 'string')
            && row.graphGeneration === value.selector.generation && [row.runtimeId, row.instanceId, row.enableGeneration, row.containerName].every(item => typeof item === 'string' && item.length <= 512), 'live-probe-output');
    });
    return value;
}

export function parseStatusProof(proof) {
    need(proof && Object.keys(proof).sort().join() === ['initialized', 'owned', 'pendingActivation', 'recoveryBarrier', 'routingConfigured', 'runningAgents', 'state', 'stateReadErrors', 'trackedAgents'].sort().join()
        && typeof proof.state === 'string' && /^[a-z-]{1,40}$/.test(proof.state)
        && ['initialized', 'owned', 'pendingActivation', 'recoveryBarrier', 'routingConfigured'].every(key => typeof proof[key] === 'boolean')
        && [proof.stateReadErrors, proof.trackedAgents, proof.runningAgents].every(value => Number.isSafeInteger(value) && value >= 0), 'live-status-proof');
    return proof;
}

export function httpGetBounded({ url, timeoutMs, maxBytes = HEALTH_BYTES, request = http.get }) {
    return new Promise((resolve, reject) => {
        let settled = false, bytes = 0;
        const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
        const req = request(url, { agent: false, timeout: timeoutMs, headers: { connection: 'close' } }, response => {
            response.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { response.destroy(); finish(new AcceptanceError('http-overflow')); } });
            response.on('end', () => finish(null, { status: response.statusCode, bytes }));
            response.on('error', () => finish(new AcceptanceError('http-error')));
        });
        req.on('timeout', () => { req.destroy(); finish(new AcceptanceError('http-timeout')); });
        req.on('error', () => finish(new AcceptanceError('http-error')));
    });
}

// Observed participating-source state. A tracking ref is the only local pushed-commit evidence; remote freshness
// is the pre-run pin step's responsibility and is never claimed here.
async function observeRepository(repo, git) {
    // Absence (detached HEAD, no upstream, no tracking ref) is an observation, not a command failure: exit 1/128 only.
    const read = async (args, optional = false) => { const result = await git(repo.path, args, optional ? [0, 1, 128] : [0]); return result.code === 0 ? result.stdout.toString('utf8').trim() : ''; };
    const status = (await git(repo.path, ['status', '--porcelain=v1', '--untracked-files=all'], [0])).stdout;
    const branch = await read(['symbolic-ref', '-q', '--short', 'HEAD'], true);
    const upstream = await read(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], true);
    const commit = await read(['rev-parse', 'HEAD']);
    const pushed = branch ? await read(['rev-parse', `refs/remotes/origin/${branch}`], true) : '';
    return { name: repo.name, commit, pushedCommit: pushed, branch, upstream, clean: status.length === 0, detached: branch === '' };
}

export function createLiveObserver({ manifest, deps, statusProof, httpGet = httpGetBounded, env = buildCommandEnvironment(process.env), io = fs, gitBin = '/usr/bin/git', hostFacts = { platform: process.platform, uid: process.getuid?.() } }) {
    need(manifest && deps && typeof statusProof === 'function' && typeof httpGet === 'function', 'live-observer-adapters');
    const publication = manifest.publications[0], media = manifest.publications[1];
    const run = (operation, kind, argv, extra = {}) => runOwnedCommand({ operation, kind, argv, cwd: manifest.workspace.path, env, deadlineMs: extra.deadlineMs ?? (kind === 'git' ? 30000 : 60000), ...extra }, deps);
    const git = (repoPath, args, allowedExitCodes = [0]) => runOwnedCommand({ operation: 'live-git-read', kind: 'git', argv: [gitBin, '-C', repoPath, ...args], cwd: repoPath, env, deadlineMs: 30000, allowedExitCodes }, deps);
    return Object.freeze({
        async observe() {
            need(hostFacts.platform === 'linux' && hostFacts.uid === manifest.host.uid, 'runtime-host-unqualified');
            const bin = manifest.engine.path;
            const info = parseEngineInfo((await run('live-engine-info', 'read', engineInfoArgs(bin))).stdout);
            const identity = engineIdentityOf({ info, path: bin, uid: manifest.host.uid });
            const box = parseBoxInspect((await run('live-box-inspect', 'read', boxInspectArgs(bin, manifest.box.id))).stdout);
            const startedMs = Date.parse(box.startedAt), expectedStartedMs = Date.parse(manifest.box.startedAt);
            need(Number.isFinite(startedMs) && Math.floor(startedMs / 1000) === Math.floor(expectedStartedMs / 1000), 'live-box-start-epoch');
            // The Box is created with /dev/fuse and /dev/net/tun; GPU devices appear only under an active grant wiring.
            const gpuWired = gpuWiringIdentityOf({}) !== manifest.engine.gpuWiringIdentity;
            const devicePaths = box.devices.map(device => device?.PathOnHost).sort();
            need(box.id === manifest.box.id && box.running === true && box.privileged === false && box.init === true && box.user === 'podman' && box.capAdd.length === 0
                && ['/dev/fuse', '/dev/net/tun'].every(device => devicePaths.includes(device))
                && devicePaths.every(device => typeof device === 'string' && (['/dev/fuse', '/dev/net/tun'].includes(device) || (gpuWired && /^\/dev\/nvidia[A-Za-z0-9_-]*$/.test(device))))
                && gpuWiringIdentityOf(box.labels) === manifest.engine.gpuWiringIdentity && box.labels.agentLibFingerprint === manifest.agentLib.fingerprint, 'live-box-contract');
            const mounts = manifest.sourceMounts.map(mount => { const found = box.mounts.find(row => row.destination === mount.destination);
                return found ? { source: found.source, destination: found.destination, readOnly: found.readOnly } : { source: '', destination: mount.destination, readOnly: false }; });
            need(box.publications.length === 2 && box.publications.every((row, index) => isDeepStrictEqual(row, [publication, media][index])), 'live-box-publications');
            const status = parseStatusProof(await statusProof());
            need(status.owned === true && status.state === 'running-initialized' && status.runningAgents >= manifest.graph.length, 'live-status-not-running');
            const stat = io.lstatSync(manifest.workspace.path);
            need(stat.isDirectory() && !stat.isSymbolicLink() && io.realpathSync(manifest.workspace.path) === manifest.workspace.path, 'live-workspace-alias');
            const input = probeInput(manifest);
            // The probe exits 1 only together with one fixed public failure code, which parseProbeOutput converts into the refusal.
            const probeResult = await run('live-box-probe', 'read', boxExecArgs({ engineBin: bin, boxId: manifest.box.id, workspace: manifest.workspace.path,
                routerHostPort: publication.hostPort, mediaHostPort: media.hostPort, interactive: true, argv: ['/usr/local/bin/node', '--input-type=module', '-'] }),
            { input: probeBootstrap(input), maxStdoutBytes: PROBE_LIMITS.inspectBytes, allowedExitCodes: [0, 1] });
            const probed = parseProbeOutput(probeResult.stdout, input);
            need(probeResult.code === 0, 'live-probe-output');
            const health = await httpGet({ url: `http://${publication.hostIP}:${publication.hostPort}/health`, timeoutMs: 5000 });
            const routerHealthy = health.status === 200;
            const repositories = []; for (const repo of manifest.candidate.repositories) repositories.push(await observeRepository(repo, git));
            return { hostPlatform: 'linux', engine: 'podman', rootless: info.rootless === true && manifest.engine.rootless === true,
                running: status.state === 'running-initialized' && box.running, initialized: status.initialized && status.routingConfigured, activeGeneration: probed.selector.generation,
                pendingActivation: status.pendingActivation || status.stateReadErrors > 0, recoveryBarrier: status.recoveryBarrier,
                workspace: { path: manifest.workspace.path, dev: stat.dev, ino: stat.ino, uid: stat.uid }, box: { id: box.id, imageId: box.imageId, startedAt: manifest.box.startedAt },
                candidate: { imageId: box.imageId, repositories }, publications: publicationsId(box.publications), sourceMounts: mountsId(mounts), engineIdentity: identity,
                graph: probed.graph.map((row, index) => ({ name: row.name, graphGeneration: row.graphGeneration, running: row.running && row.generationJoin && row.labelsEqual,
                    runtimeId: row.runtimeId, instanceId: row.instanceId, enableGeneration: row.enableGeneration, ready: row.ready,
                    externalHealth: manifest.graph[index].externalHealthRequired ? routerHealthy : true, noWaitState: row.noWaitState })) };
        },
        // The admission is positive only when the independently observed deployment matches the manifest-derived expectation.
        async admit() { const observed = await this.observe(); assertLiveBefore({ expected: expectedLiveFromManifest(manifest), observed }); return Object.freeze({ phase: 'U0', admitted: true, activeGeneration: observed.activeGeneration, runtimes: observed.graph.length }); },
    });
}
