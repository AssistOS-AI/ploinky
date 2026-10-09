import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AcceptanceError, LIMITS, need, exact, validateManifest, parseStrictJson, readBoundedDescriptor } from './manifest.mjs';
import { createVerifiedImportHooks, IMPORT_LIMITS } from './import_binding.mjs';
import { createPinnedPublicSourceReader } from './import_source_reader.mjs';
import { invokeOuterApi, createDiscardOutput, createStopLatch, OPERATIONS, validateExpectation } from './execution.mjs';
import { importProduct } from './product_import.mjs';

// The fresh owned worker. It proves its own runtime, registers Node's official synchronous hooks before the first
// product import, imports the exact candidate CLI API once, and reports only a public frame on the private control
// descriptor. Any failure latches a fixed reason; the worker never retries, deregisters or falls back to a path import.
export const WORKER_KINDS = Object.freeze(['--owned-update', '--owned-status']);
const CONTROL_FD = 3;
const NODE_BINARY_BYTES = 512 * 1024 * 1024;
const reasonOf = error => error instanceof AcceptanceError && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : 'worker-failed';

export function readBoundedRegularFile(filename, cap, io = fs) {
    need(typeof filename === 'string' && path.isAbsolute(filename) && Number.isSafeInteger(cap) && cap > 0 && cap <= LIMITS.readBytes, 'worker-file-arguments');
    const fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = io.fstatSync(fd);
        need(before.isFile() && before.nlink === 1 && before.size <= cap && (before.mode & 0o022) === 0, 'worker-file-shape');
        const bytes = readBoundedDescriptor(fd, cap, io), after = io.fstatSync(fd);
        need(before.dev === after.dev && before.ino === after.ino && before.size === after.size && bytes.length === before.size, 'worker-file-changed');
        return bytes;
    } finally { io.closeSync(fd); }
}

export function hashRuntimeBinary(filename, io = fs) {
    const fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = io.fstatSync(fd); need(before.isFile() && before.size > 0 && before.size <= NODE_BINARY_BYTES, 'worker-node-shape');
        const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let offset = 0;
        for (;;) { const count = io.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; offset += count; need(offset <= before.size, 'worker-node-changed'); digest.update(buffer.subarray(0, count)); }
        const after = io.fstatSync(fd); need(offset === before.size && after.size === before.size && after.ino === before.ino && after.dev === before.dev, 'worker-node-changed');
        return digest.digest('hex');
    } finally { io.closeSync(fd); }
}

export function validateWorkerInput(value, kind, operation) {
    exact(value, kind === '--owned-update' ? ['schemaVersion', 'kind', 'runId', 'operation', 'manifest', 'expected', 'admitted'] : ['schemaVersion', 'kind', 'runId', 'operation', 'manifest']);
    need(value.schemaVersion === 1 && value.kind === (kind === '--owned-update' ? 'update' : 'status') && value.operation === operation, 'worker-input');
    validateManifest(value.manifest); need(value.runId === value.manifest.runId, 'worker-input');
    if (kind === '--owned-update') { need(OPERATIONS.includes(operation), 'worker-input'); validateExpectation(value.expected, value.manifest, { admitted: value.admitted }); } else need(operation === 'status', 'worker-input');
    return value;
}

export function validateCatalogBinding(catalog, manifest) {
    exact(catalog, ['schemaVersion', 'candidateCommit', 'apiURL', 'entryParentURL', 'builtins', 'modules', 'edges', 'initialModules']);
    const apiURL = pathToFileURL(manifest.candidate.apiPath).href;
    const row = Array.isArray(catalog.modules) ? catalog.modules.find(item => item?.url === apiURL) : null;
    need(catalog.candidateCommit === manifest.candidate.commit && catalog.apiURL === apiURL && catalog.entryParentURL === new URL('./product_import.mjs', import.meta.url).href
        && row && row.sha256 === manifest.candidate.apiSha256 && row.format === 'module', 'worker-catalog-binding');
    return catalog;
}

// Registration precedes the first product import; the returned hooks stay active for the life of the process.
export function installVerifiedImportBinding({ catalog, roots, check, registerHooks = module.registerHooks, io = fs }) {
    need(typeof registerHooks === 'function', 'worker-hooks-unavailable');
    const reader = createPinnedPublicSourceReader({ modules: catalog.modules, roots, io, check });
    const hooks = createVerifiedImportHooks(catalog, { readSource: reader.readSource, check });
    registerHooks({ resolve: hooks.resolve, load: hooks.load });
    return Object.freeze({ hooks, reader });
}

export async function loadVerifiedOuterApi({ catalog, roots, check, registerHooks, io, importer = importProduct }) {
    const binding = installVerifiedImportBinding({ catalog, roots, check, registerHooks, io });
    const api = await importer(catalog.apiURL);
    // A catalog alone is not proof that the hook ran: the whole initial closure must have been loaded through it.
    binding.hooks.assertInitialClosure();
    need(typeof api?.runOuterCli === 'function', 'worker-api-missing');
    return Object.freeze({ runOuterCli: api.runOuterCli, binding });
}

function writeFrame(frame, io = fs, fd = CONTROL_FD) {
    const bytes = Buffer.from(JSON.stringify(frame)); need(bytes.length <= LIMITS.controlBytes, 'worker-control-overflow');
    let offset = 0; while (offset < bytes.length) { const count = io.writeSync(fd, bytes, offset, bytes.length - offset); need(count > 0, 'worker-control-write'); offset += count; }
}

function statusProof(status, update) {
    const inbox = status?.inbox ?? null, count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return { state: typeof status?.state === 'string' ? status.state : 'unknown', owned: status?.ownership?.state === 'owned', initialized: inbox?.initialized === true,
        routingConfigured: inbox?.routingConfigured === true, trackedAgents: count(inbox?.trackedAgents), runningAgents: count(inbox?.runningAgents),
        pendingActivation: update.pendingActivation !== null && update.pendingActivation !== undefined, recoveryBarrier: update.recoveryBarrier !== null && update.recoveryBarrier !== undefined,
        stateReadErrors: Array.isArray(update.errors) ? update.errors.length : 1 };
}

export async function workerMain(argv, { io = fs, now = () => Math.floor(performance.now()),
    nodeFacts = { version: process.version, execPath: process.execPath, platform: process.platform, uid: process.getuid?.(), execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '' },
    hashNode = hashRuntimeBinary, write = frame => writeFrame(frame, io), registerHooks = module.registerHooks, importer = importProduct } = {}) {
    const started = now(); let kind = null, operation = null, runId = null;
    try {
        need(Array.isArray(argv) && argv.length >= 2 && WORKER_KINDS.includes(argv[0]) && argv.length === (argv[0] === '--owned-update' ? 3 : 2), 'worker-arguments');
        [kind, operation] = [argv[0], argv[0] === '--owned-update' ? argv[2] : 'status'];
        const input = validateWorkerInput(parseStrictJson(readBoundedRegularFile(argv[1], LIMITS.manifestBytes, io), LIMITS.manifestBytes), kind, operation);
        const { manifest } = input; runId = manifest.runId;
        need(argv[1] === path.join(manifest.evidence.root, `${operation === 'status' ? 'status' : operation}_input_codex.json`), 'worker-input-path');
        need(nodeFacts.platform === manifest.host.platform && nodeFacts.uid === manifest.host.uid && nodeFacts.version === manifest.host.node.version
            && nodeFacts.execPath === manifest.host.node.path && hashNode(nodeFacts.execPath, io) === manifest.host.node.sha256, 'worker-node-unqualified');
        // No inherited preload, loader, hook or option configuration may exist before the verification hook registers.
        need(Array.isArray(nodeFacts.execArgv) && nodeFacts.execArgv.length === 0 && nodeFacts.nodeOptions === '', 'worker-preload-configuration');
        const deadline = started + LIMITS.commandMs, check = () => need(now() < deadline, 'worker-deadline');
        const catalog = validateCatalogBinding(parseStrictJson(readBoundedRegularFile(manifest.evidence.sourceManifest, LIMITS.readBytes, io), LIMITS.readBytes), manifest);
        const { runOuterCli } = await loadVerifiedOuterApi({ catalog, roots: [manifest.candidate.root], check, registerHooks, io, importer });
        if (kind === '--owned-update') {
            const latch = createStopLatch();
            const proof = await invokeOuterApi({ manifest, operation, expected: input.expected, admitted: input.admitted }, { runOuterCli, output: createDiscardOutput(), latch });
            check(); write({ type: 'UPDATE_RESULT', runId, operation, proof });
            return proof.returnedCode;
        }
        const supervisorURL = pathToFileURL(path.join(manifest.candidate.root, 'ploinky-box/supervisor.mjs')).href;
        const supervisorModule = await importer(supervisorURL); need(typeof supervisorModule?.createBoxSupervisor === 'function', 'worker-api-missing');
        const supervisor = supervisorModule.createBoxSupervisor({ launchCwd: manifest.workspace.path });
        const status = supervisor.inspectBoxStatus(), update = supervisor.inspectUpdateState(status.identity);
        check(); write({ type: 'STATUS_RESULT', runId, proof: statusProof(status, update) });
        return 0;
    } catch (error) {
        const reason = reasonOf(error);
        try { if (runId) write({ type: 'WORKER_FAILURE', runId, operation: operation ?? 'unknown', reason: reason.replace(/^worker-/, '') }); } catch { /* the parent classifies a missing frame as uncertain */ }
        return 2;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await workerMain(process.argv.slice(2));
