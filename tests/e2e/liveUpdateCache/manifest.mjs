import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { REQUIRED_PHASES, REQUIRED_GATES, PHASE_CAPS_MS, TOTAL_CAP_MS, BOX_MAX_AGE_MS, IMAGE_MAX_AGE_MS, RELEASE_GENERATIONS, OPTIONAL_ACTIVATION } from './contracts.mjs';

export const MODE = 'live-update-cache-acceptance';
export const LIMITS = Object.freeze({ manifestBytes: 256 * 1024, outputBytes: 16 * 1024 * 1024, controlBytes: 128 * 1024,
    commandMs: 1200000, closeMs: 5000, gitMs: 30000, readBytes: 4 * 1024 * 1024 });
export class AcceptanceError extends Error { constructor(code) { super(code); this.code = code; } }
export const need = (condition, code) => { if (!condition) throw new AcceptanceError(code); };
export function exact(value, keys, code = 'manifest-schema') {
    need(value && Object.getPrototypeOf(value) === Object.prototype, code);
    const fields = Object.getOwnPropertyDescriptors(value);
    need(Reflect.ownKeys(fields).length === keys.length && keys.every(key => Object.hasOwn(fields[key] ?? {}, 'value')), code);
}
const placeholder = /(?:^|[\/_.:-])(?:todo|tbd|pending|unknown|placeholder|unqualified)(?:$|[\/_.:-])/i;
export const word = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,511}$/.test(value) && !placeholder.test(value);
export const digest = (value, length = 64) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
    && !/^([a-f0-9])\1+$/.test(value);
export const absolute = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.normalize(value) === value && !/[\0\r\n]/.test(value) && !placeholder.test(value)
    && !/(?:^|\/)(?:\.codex|\.ssh|\.secrets|\.env)(?:\/|$)/.test(value);
// The one browser origin of a Box's Router publication: loopback sign-in is canonicalized to `localhost`, so every smoke
// page (U1/U7 and the gates) runs on, and is checked against, this origin. The host-side `/health` probe stays on 127.0.0.1.
export const smokeOrigin = publication => `http://localhost:${publication.hostPort}`;
// The exact outer Box container name (never its 64-hex ID), as observed by the same exact-ID inspect that bound the ID.
export const BOX_NAME_PATTERN = /^ploinky-box-[a-z0-9][a-z0-9-]{0,200}$/;
export const boxName = value => typeof value === 'string' && BOX_NAME_PATTERN.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const ipv4 = value => typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
    && value.split('.').every(part => String(Number(part)) === part && Number(part) <= 255) && value !== '0.0.0.0';
const inside = (root, file) => file === root || file.startsWith(root + '/');
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19);

export function parseAcceptanceArguments(argv) {
    need(Array.isArray(argv) && argv.length === 2 && argv[0] === '--acceptance'
        && absolute(argv[1]) && /\/_?[A-Za-z0-9.-][A-Za-z0-9_.-]*_codex\.json$/.test(argv[1]), 'acceptance-arguments');
    return { mode: MODE, manifestPath: argv[1] };
}

export function validateManifest(value, { nowMs } = {}) {
    exact(value, ['schemaVersion', 'mode', 'runId', 'phases', 'gates', 'host', 'workspace', 'candidate', 'box', 'engine', 'graph',
        'sourceMounts', 'publications', 'agentLib', 'fixtureEndpoint', 'evidence', 'grant', 'epochs', 'activation', 'negativeScopes', 'limits']);
    need(value.schemaVersion === 1 && value.mode === MODE && /^update-cache-[0-9TZ]{8,32}-[a-f0-9]{8}_codex$/.test(value.runId), 'manifest-identity');
    need(isDeepStrictEqual(value.phases, REQUIRED_PHASES) && isDeepStrictEqual(value.gates, REQUIRED_GATES), 'mandatory-stages');
    exact(value.host, ['target', 'hostname', 'address', 'boot', 'uid', 'user', 'platform', 'arch', 'node']);
    const host = value.host;
    need(host.target === 'ubuntu-codex' && word(host.hostname) && host.address === '100.76.22.69' && uuid(host.boot)
        && integer(host.uid) && host.uid > 0 && host.user === 'skutner' && host.platform === 'linux' && host.arch === 'x64', 'host-identity');
    exact(host.node, ['path', 'version', 'sha256']);
    need(absolute(host.node.path) && /^v(?:2[2-9]|[3-9]\d|\d{3,})\.\d+\.\d+$/.test(host.node.version) && digest(host.node.sha256), 'node-pin');
    exact(value.workspace, ['path', 'dev', 'ino', 'uid', 'instance']);
    need(value.workspace.path === '/home/skutner/work/testExplorerFresh' && ['dev', 'ino', 'uid'].every(key => integer(value.workspace[key]))
        && value.workspace.ino > 0 && value.workspace.uid === host.uid && word(value.workspace.instance), 'workspace-identity');
    exact(value.candidate, ['root', 'cliPath', 'apiPath', 'apiSha256', 'branch', 'upstream', 'commit', 'pushedCommit', 'tree', 'clean', 'detached', 'deploymentBranch', 'repositories']);
    const c = value.candidate;
    need(absolute(c.root) && !inside(value.workspace.path, c.root) && c.cliPath === path.join(c.root, 'bin/ploinky')
        && c.apiPath === path.join(c.root, 'ploinky-box/bin/ploinky-box.mjs') && digest(c.apiSha256)
        && word(c.branch) && c.upstream === `origin/${c.branch}` && digest(c.commit, 40) && c.commit === c.pushedCommit
        && digest(c.tree, 40) && c.clean === true && c.detached === false && (c.deploymentBranch === null || c.deploymentBranch === c.branch), 'candidate-pin');
    need(Array.isArray(c.repositories) && c.repositories.length >= 4 && c.repositories.length <= 128, 'repository-map');
    const names = new Set();
    for (const repo of c.repositories) {
        exact(repo, ['name', 'path', 'defaultBranch', 'defaultCommit', 'branch', 'commit', 'pushedCommit', 'upstream', 'clean', 'detached', 'hasCandidateBranch']);
        need(word(repo.name) && !names.has(repo.name) && absolute(repo.path) && word(repo.defaultBranch) && digest(repo.defaultCommit, 40)
            && word(repo.branch) && digest(repo.commit, 40) && repo.commit === repo.pushedCommit && repo.upstream === `origin/${repo.branch}`
            && repo.clean === true && repo.detached === false && typeof repo.hasCandidateBranch === 'boolean', 'repository-pin');
        const selected = repo.name === 'ploinky' ? c.branch : c.deploymentBranch && repo.hasCandidateBranch ? c.deploymentBranch : repo.defaultBranch;
        need(repo.branch === selected && (repo.branch !== repo.defaultBranch || repo.commit === repo.defaultCommit), 'repository-fallback'); names.add(repo.name);
        if (repo.name === 'ploinky') need(repo.path === c.root && repo.commit === c.commit && repo.upstream === c.upstream, 'ploinky-map-mismatch');
    }
    need(['ploinky', 'AssistOSExplorer', 'AchillesCLI', 'achillesAgentLib'].every(name => names.has(name)), 'repository-map-incomplete');
    exact(value.box, ['id', 'name', 'imageId', 'imageRef', 'startedAt', 'imageCreatedAt', 'activeGeneration', 'running', 'initialized', 'pendingActivation', 'recoveryBarrier']);
    need(digest(value.box.id) && boxName(value.box.name) && digest(value.box.imageId) && word(value.box.imageRef) && value.box.imageRef.length <= 256 && iso(value.box.startedAt) && iso(value.box.imageCreatedAt)
        && word(value.box.activeGeneration) && value.box.running === true && value.box.initialized === true
        && value.box.pendingActivation === false && value.box.recoveryBarrier === false, 'live-inputs');
    exact(value.engine, ['kind', 'path', 'identity', 'uid', 'rootless', 'init', 'privileged', 'dockerExcluded', 'gpuWiringIdentity']);
    need(value.engine.kind === 'podman' && absolute(value.engine.path) && digest(value.engine.identity) && value.engine.uid === host.uid
        && value.engine.rootless === true && value.engine.init === true && value.engine.privileged === false
        && value.engine.dockerExcluded === true && digest(value.engine.gpuWiringIdentity), 'engine-admission');
    need(Array.isArray(value.graph) && value.graph.length > 0 && value.graph.length <= 256, 'graph-input');
    const graphNames = new Set();
    for (const entry of value.graph) {
        exact(entry, ['name', 'repository', 'noWait', 'externalHealthRequired', 'declaredEnableFlags', 'manifestSha256']);
        need(word(entry.name) && !graphNames.has(entry.name) && names.has(entry.repository) && !/(?:^|[\/:-])(?:docker|gptresearcher)(?:$|[\/:-])/i.test(entry.name)
            && typeof entry.noWait === 'boolean' && typeof entry.externalHealthRequired === 'boolean' && digest(entry.manifestSha256)
            && Array.isArray(entry.declaredEnableFlags) && entry.declaredEnableFlags.length <= 16 && entry.declaredEnableFlags.every(word)
            && new Set(entry.declaredEnableFlags).size === entry.declaredEnableFlags.length
            && entry.noWait === entry.declaredEnableFlags.includes('no-wait'), 'graph-policy'); graphNames.add(entry.name);
    }
    need(Array.isArray(value.sourceMounts) && value.sourceMounts.length > 0 && value.sourceMounts.length <= 128, 'mount-input');
    const destinations = new Set();
    for (const mount of value.sourceMounts) {
        exact(mount, ['source', 'destination', 'readOnly', 'dev', 'ino', 'uid', 'sourceSha256']);
        need(absolute(mount.source) && absolute(mount.destination) && !destinations.has(mount.destination) && mount.readOnly === true
            && ['dev', 'ino', 'uid'].every(key => integer(mount[key])) && mount.ino > 0 && mount.uid === host.uid && digest(mount.sourceSha256), 'mount-pin');
        destinations.add(mount.destination);
    }
    need(Array.isArray(value.publications) && value.publications.length === 2, 'box-publications');
    value.publications.forEach((p, index) => {
        exact(p, ['protocol', 'hostIP', 'hostPort', 'containerPort']);
        need(p.protocol === (index === 0 ? 'tcp' : 'udp') && p.containerPort === (index === 0 ? 8080 : 7882)
            && p.hostIP === (index === 0 ? '127.0.0.1' : '0.0.0.0') && integer(p.hostPort) && p.hostPort > 0 && p.hostPort <= 65535, 'box-publication');
    });
    exact(value.agentLib, ['path', 'commit', 'fingerprint', 'sourceId']);
    const lib = c.repositories.find(repo => repo.name === 'achillesAgentLib');
    need(value.agentLib.path === lib.path && value.agentLib.commit === lib.commit && digest(value.agentLib.fingerprint) && digest(value.agentLib.sourceId), 'agentlib-pin');
    const endpoint = value.fixtureEndpoint;
    exact(endpoint, ['qualified', 'qualifiedAtMs', 'bindIP', 'installerIP', 'port', 'internalPort', 'imageId', 'imageDigest', 'license', 'noticesPath', 'engineIdentity', 'uid', 'rootless', 'init', 'readOnly', 'pullPolicy', 'networkMode', 'capabilities', 'devices']);
    need(endpoint.qualified === true && integer(endpoint.qualifiedAtMs) && ipv4(endpoint.bindIP) && ipv4(endpoint.installerIP)
        && integer(endpoint.port) && endpoint.port > 1023 && endpoint.port <= 65535 && endpoint.internalPort > 1023 && endpoint.internalPort <= 65535
        && integer(endpoint.internalPort) && digest(endpoint.imageId) && /^sha256:/.test(endpoint.imageDigest) && digest(endpoint.imageDigest.slice(7))
        && word(endpoint.license) && absolute(endpoint.noticesPath) && endpoint.engineIdentity === value.engine.identity && endpoint.uid === host.uid
        && endpoint.rootless === true && endpoint.init === true && endpoint.readOnly === true && endpoint.pullPolicy === 'never'
        && endpoint.networkMode === 'bridge' && isDeepStrictEqual(endpoint.capabilities, []) && isDeepStrictEqual(endpoint.devices, []), 'fixture-endpoint');
    exact(value.evidence, ['root', 'functional', 'release', 'release2', 'release1Record', 'receipt', 'sourceManifest']);
    const protectedTrees = [value.workspace.path, c.root, ...c.repositories.map(repo => repo.path)];
    const disjoint = file => protectedTrees.every(root => !inside(root, file) && !inside(file, root));
    need(absolute(value.evidence.root) && disjoint(value.evidence.root), 'evidence-root');
    const evidenceFiles = Object.entries(value.evidence).filter(([key]) => key !== 'root').map(([, file]) => file);
    need(new Set(evidenceFiles).size === evidenceFiles.length && evidenceFiles.every(file => absolute(file) && disjoint(file) && inside(value.evidence.root, file)
        && /_codex\.json$/.test(file)), 'evidence-files');
    exact(value.grant, ['target', 'operation', 'boot', 'issuedAtMs', 'startsAtMs', 'endsAtMs', 'operationStartedMonoMs', 'reviewSha256', 'nativeCheckpointSha256', 'jointCheckpointSha256', 'custodyClosed', 'testingResumeAuthorized']);
    const g = value.grant;
    need(g.target === host.target && g.operation === MODE && g.boot === host.boot && [g.issuedAtMs, g.startsAtMs, g.endsAtMs, g.operationStartedMonoMs].every(integer)
        && g.issuedAtMs <= g.startsAtMs && g.endsAtMs - g.startsAtMs >= TOTAL_CAP_MS && digest(g.reviewSha256)
        && digest(g.nativeCheckpointSha256) && digest(g.jointCheckpointSha256) && g.custodyClosed === true && g.testingResumeAuthorized === true
        && endpoint.qualifiedAtMs <= g.issuedAtMs, 'resource-grant');
    if (nowMs !== undefined) need(integer(nowMs) && g.startsAtMs <= nowMs && g.endsAtMs - nowMs >= TOTAL_CAP_MS, 'resource-window');
    exact(value.epochs, ['functional', 'release']);
    exact(value.epochs.functional, ['boxId', 'generation', 'startedAt', 'candidateCommit', 'imageId']);
    need(value.epochs.functional.boxId === value.box.id && value.epochs.functional.generation === value.box.activeGeneration
        && value.epochs.functional.startedAt === value.box.startedAt && value.epochs.functional.candidateCommit === c.commit
        && value.epochs.functional.imageId === value.box.imageId, 'functional-epoch');
    exact(value.epochs.release, ['freshRequired', 'sameCandidateCommit', 'sameImageId', 'boxMaxAgeMs', 'imageMaxAgeMs', 'gateOrder', 'generations', 'activation']);
    need(value.epochs.release.freshRequired === true && value.epochs.release.sameCandidateCommit === c.commit && value.epochs.release.sameImageId === value.box.imageId
        && value.epochs.release.boxMaxAgeMs === BOX_MAX_AGE_MS && value.epochs.release.imageMaxAgeMs === IMAGE_MAX_AGE_MS
        && isDeepStrictEqual(value.epochs.release.gateOrder, REQUIRED_GATES) && isDeepStrictEqual(value.epochs.release.generations, RELEASE_GENERATIONS)
        && isDeepStrictEqual(value.epochs.release.activation, OPTIONAL_ACTIVATION), 'release-epoch');
    // R2's declaration of the three optional runtimes that the runner-owned activation adds (null for every other generation).
    if (value.activation !== null) {
        need(Array.isArray(value.activation) && value.activation.length === OPTIONAL_ACTIVATION.agents.length, 'activation-declaration');
        const declared = new Set(value.graph.map(entry => entry.name)), addedNames = new Set();
        for (const entry of value.activation) {
            exact(entry, ['name', 'repository', 'noWait', 'externalHealthRequired', 'declaredEnableFlags', 'manifestSha256'], 'activation-declaration');
            need(word(entry.name) && !declared.has(entry.name) && !addedNames.has(entry.name) && names.has(entry.repository) && typeof entry.noWait === 'boolean' && typeof entry.externalHealthRequired === 'boolean'
                && digest(entry.manifestSha256) && Array.isArray(entry.declaredEnableFlags) && entry.declaredEnableFlags.length <= 16 && entry.declaredEnableFlags.every(word)
                && entry.noWait === entry.declaredEnableFlags.includes('no-wait'), 'activation-declaration'); addedNames.add(entry.name);
        }
        need(isDeepStrictEqual([...addedNames].map(name => name.split('/').at(-1)).sort(), [...OPTIONAL_ACTIVATION.agents].sort()), 'activation-declaration');
    }
    exact(value.negativeScopes, ['optional', 'required']);
    const scenario = path.join(value.workspace.path, `UpdateE2E-${value.runId}`);
    need(value.negativeScopes.optional === scenario && value.negativeScopes.required === scenario, 'negative-scope');
    need(isDeepStrictEqual(value.limits, { ...LIMITS, totalMs: TOTAL_CAP_MS, phaseCapsMs: PHASE_CAPS_MS }), 'fixed-limits');
    return value;
}

export function readBoundedDescriptor(fd, cap, io) {
    need(Number.isSafeInteger(cap) && cap > 0 && cap <= LIMITS.readBytes, 'read-byte-cap');
    const buffer = Buffer.alloc(cap + 1); let offset = 0;
    while (offset <= cap) {
        const remaining = cap + 1 - offset, count = io.readSync(fd, buffer, offset, remaining, null);
        need(Number.isSafeInteger(count) && count >= 0 && count <= remaining, 'read-count');
        if (!count) break; offset += count;
    }
    need(offset <= cap, 'read-byte-limit'); return buffer.subarray(0, offset);
}

export function parseStrictJson(bytes, cap = LIMITS.manifestBytes) {
    need(Number.isSafeInteger(cap) && cap > 0 && cap <= LIMITS.readBytes && Buffer.isBuffer(bytes) && bytes.length <= cap, 'manifest-byte-limit');
    let parsed, text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); parsed = JSON.parse(text); } catch { throw new AcceptanceError('manifest-json'); }
    const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
    let index = 0;
    function visit(depth = 0) {
        need(depth <= 64, 'manifest-nesting');
        const token = tokens[index++];
        if (token === '{') {
            const keys = new Set();
            if (tokens[index] === '}') { index++; return; }
            for (;;) { const key = JSON.parse(tokens[index++]); need(!keys.has(key), 'manifest-duplicate-key'); keys.add(key);
                index++; visit(depth + 1); if (tokens[index++] === '}') break; }
        } else if (token === '[') {
            if (tokens[index] === ']') { index++; return; }
            for (;;) { visit(depth + 1); if (tokens[index++] === ']') break; }
        }
    }
    visit();
    return parsed;
}
export function parseManifestBytes(bytes, options) { return validateManifest(parseStrictJson(bytes), options); }
