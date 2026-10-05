import fs from 'node:fs';
import cp from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { MODE, LIMITS } from './manifest_codex.mjs';
import { REQUIRED_PHASES, REQUIRED_GATES, PHASE_CAPS_MS, TOTAL_CAP_MS, BOX_MAX_AGE_MS, IMAGE_MAX_AGE_MS } from './contracts_codex.mjs';

export const H = value => createHash('sha256').update(value).digest('hex');
export function installPureGuards() {
    const forbidden = () => { throw new Error('PURE_REAL_OPERATION_FORBIDDEN'); };
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = forbidden;
    process.kill = forbidden;
    for (const module of [net, http, https, tls]) for (const name of ['connect', 'createConnection', 'request', 'get', 'createServer']) if (name in module) module[name] = forbidden;
    for (const name of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync']) {
        const original = fs[name]; fs[name] = function guarded(file, ...args) {
            if (typeof file === 'string' && (file.startsWith('/proc') || file.startsWith('/home/')
                || /\/(?:\.codex|\.ssh|\.secrets|\.env)(?:\/|$)/.test(file) || file.includes('/Library/Caches/'))) forbidden();
            return original.call(this, file, ...args);
        };
    }
    syncBuiltinESMExports();
}

export function manifestFixture() {
    const nowMs = Date.parse('2026-10-04T12:00:00Z'), runId = 'update-cache-20261004T120000Z-1234abcd_codex';
    const root = '/home/skutner/work/pinned-ploinky', uid = 1000, workspace = '/home/skutner/work/testExplorerFresh';
    const candidateCommit = H('ploinky-commit').slice(0, 40), boot = '47ec5b32-52bc-489c-ae6b-4bad94022abb';
    const repositories = ['ploinky', 'AssistOSExplorer', 'AchillesCLI', 'achillesAgentLib'].map(name => {
        const commit = name === 'ploinky' ? candidateCommit : H(`${name}-commit`).slice(0, 40), branch = name === 'ploinky' ? 'repair/integrated-20261002' : 'main';
        return { name, path: name === 'ploinky' ? root : `/home/skutner/work/${name}`, defaultBranch: 'main', defaultCommit: name === 'ploinky' ? H('ploinky-main').slice(0, 40) : commit,
            branch, commit, pushedCommit: commit, upstream: `origin/${branch}`, clean: true, detached: false, hasCandidateBranch: name === 'ploinky' };
    });
    const evidenceRoot = `/home/skutner/work/evidence/${runId}`;
    const value = { schemaVersion: 1, mode: MODE, runId, phases: [...REQUIRED_PHASES], gates: [...REQUIRED_GATES],
        host: { target: 'ubuntu-codex', hostname: 'qualified-ubuntu', address: '100.76.22.69', boot, uid, user: 'skutner', platform: 'linux', arch: 'x64',
            node: { path: '/usr/local/bin/node', version: 'v22.19.0', sha256: H('node-binary') } },
        workspace: { path: workspace, dev: 1, ino: 99, uid, instance: 'selected-workspace-instance' },
        candidate: { root, cliPath: `${root}/bin/ploinky`, apiPath: `${root}/ploinky-box/bin/ploinky-box.mjs`, apiSha256: H('api-source-bytes'),
            branch: 'repair/integrated-20261002', upstream: 'origin/repair/integrated-20261002', commit: candidateCommit, pushedCommit: candidateCommit,
            tree: H('tree').slice(0, 40), clean: true, detached: false, deploymentBranch: 'repair/integrated-20261002', repositories },
        box: { id: H('box'), name: 'ploinky-box-testexplorerfresh-5c1d9a7e03b2', imageId: H('box-image'), imageRef: 'docker.io/assistos/ploinky-box:candidate-20261004', startedAt: '2026-10-04T11:59:50Z', imageCreatedAt: '2026-10-04T11:00:00Z', activeGeneration: 'current-generation',
            running: true, initialized: true, pendingActivation: false, recoveryBarrier: false },
        engine: { kind: 'podman', path: '/usr/bin/podman', identity: H('engine'), uid, rootless: true, init: true, privileged: false, dockerExcluded: true, gpuWiringIdentity: H('gpu-wiring') },
        graph: [{ name: 'AssistOSExplorer/explorer', repository: 'AssistOSExplorer', noWait: false, externalHealthRequired: true, declaredEnableFlags: [], manifestSha256: H('explorer-manifest') }],
        sourceMounts: [{ source: root, destination: '/opt/ploinky', readOnly: true, dev: 1, ino: 10, uid, sourceSha256: H('source') }],
        publications: [{ protocol: 'tcp', hostIP: '127.0.0.1', hostPort: 8080, containerPort: 8080 }, { protocol: 'udp', hostIP: '0.0.0.0', hostPort: 7882, containerPort: 7882 }],
        agentLib: { path: repositories[3].path, commit: repositories[3].commit, fingerprint: H('lib-fingerprint'), sourceId: H('lib-source') },
        fixtureEndpoint: { qualified: true, qualifiedAtMs: nowMs - 1, bindIP: '100.76.22.69', installerIP: '10.0.2.2', port: 18080, internalPort: 8080,
            imageId: H('busybox-image'), imageDigest: `sha256:${H('busybox-manifest')}`, license: 'GPL-2.0-only', noticesPath: '/home/skutner/work/notices/busybox.txt',
            engineIdentity: H('engine'), uid, rootless: true, init: true, readOnly: true, pullPolicy: 'never', networkMode: 'bridge', capabilities: [], devices: [] },
        evidence: { root: evidenceRoot, functional: `${evidenceRoot}/functional_codex.json`, release: `${evidenceRoot}/release_codex.json`, receipt: `${evidenceRoot}/receipt_codex.json`, sourceManifest: `${evidenceRoot}/sources_codex.json` },
        grant: { target: 'ubuntu-codex', operation: MODE, boot, issuedAtMs: nowMs, startsAtMs: nowMs, endsAtMs: nowMs + TOTAL_CAP_MS + 1,
            operationStartedMonoMs: 1000, reviewSha256: H('review'), nativeCheckpointSha256: H('native-checkpoint'), jointCheckpointSha256: H('joint-checkpoint'), custodyClosed: true, testingResumeAuthorized: true },
        epochs: { functional: { boxId: H('box'), generation: 'current-generation', startedAt: '2026-10-04T11:59:50Z', candidateCommit, imageId: H('box-image') },
            release: { freshRequired: true, sameCandidateCommit: candidateCommit, sameImageId: H('box-image'), boxMaxAgeMs: BOX_MAX_AGE_MS, imageMaxAgeMs: IMAGE_MAX_AGE_MS, gateOrder: [...REQUIRED_GATES] } },
        negativeScopes: { optional: `${workspace}/UpdateE2E-${runId}`, required: `${workspace}/UpdateE2E-${runId}` }, limits: { ...LIMITS, totalMs: TOTAL_CAP_MS, phaseCapsMs: { ...PHASE_CAPS_MS } } };
    return { value, nowMs };
}

export function expectationFixture(manifest, operation = 'normal-update') {
    const negative = ['optional-negative', 'required-negative'].includes(operation), required = operation === 'required-negative';
    const id = `AAUpdateE2E4-collision-${manifest.runId}`;
    const error = { phase: 'registered-repository', id, outcome: 'failed', required: required ? null : false, code: 'untracked-would-be-overwritten' };
    return { expected: { errors: negative ? [error] : [], blockedBy: required ? [error] : [], recordIds: negative ? ['workspace-graph', id] : ['workspace-graph'] },
        records: [...(negative ? [error] : []), { phase: 'activation', id: 'workspace-graph', outcome: required ? 'deferred' : 'changed', required: false, code: required ? 'deferred' : 'restarted' }] };
}
