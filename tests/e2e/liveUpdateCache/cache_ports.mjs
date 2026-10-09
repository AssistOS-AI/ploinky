import { AcceptanceError, LIMITS, need } from './manifest.mjs';
import { runOwnedCommand, buildCommandEnvironment } from './host_command.mjs';
import { boxExecArgs } from './engine.mjs';
import { createGcOutputProjection } from './output_projection.mjs';
import { STORE_PROBE_SCHEMA, STORE_PROBE_LIMITS, validateStoreProbeInput } from './store_probe.mjs';
import { PIN_PROBE_SCHEMA, PIN_PROBE_LIMITS } from './pin_probe.mjs';

// Host-side ports for the cache phases: the in-Box store probe, bounded reads inside one exact reader container,
// exact-ID container logs, and the supported outer CLI (including the debug reinstall whose GC summary is projected).
export const STORE_BOOTSTRAP_PATH = '/opt/ploinky/tests/e2e/liveUpdateCache/store_probe.mjs';
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const FULL_KEYS = ['label', 'containerName', 'runtimeId', 'startedAt', 'instanceId', 'enableGeneration', 'running', 'labelsEqual', 'objectId', 'selectorId', 'version', 'sourceCommit', 'provenanceCommit', 'lockCommit',
    'markerSha256', 'payloadSha256', 'treeMatchesManifest', 'installerKind', 'verification', 'readerReceipt', 'receiptCount', 'mountSource', 'mountReadOnly'].sort().join();
const IDENTITY_KEYS = ['label', 'containerName', 'runtimeId', 'instanceId', 'enableGeneration', 'running', 'labelsEqual', 'objectId', 'selectorId', 'payloadSha256', 'storeMode'].sort().join();
const shortText = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);

export function storeProbeBootstrap(input) {
    return Buffer.from(`const { storeProbeMain } = await import(${JSON.stringify(STORE_BOOTSTRAP_PATH)});\nprocess.exitCode = await storeProbeMain({ input: ${JSON.stringify(input)} });\n`);
}

export const PIN_BOOTSTRAP_PATH = '/opt/ploinky/tests/e2e/liveUpdateCache/pin_probe.mjs';
export const pinProbeBootstrap = () => Buffer.from(`const { pinProbeMain } = await import(${JSON.stringify(PIN_BOOTSTRAP_PATH)});\nprocess.exitCode = await pinProbeMain({ input: {} });\n`);

export function parsePinProbeOutput(bytes) {
    need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMITS.controlBytes, 'pin-output');
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new AcceptanceError('pin-output'); }
    need(value && value.schema === PIN_PROBE_SCHEMA && value.version === 1, 'pin-output');
    if (Object.hasOwn(value, 'failure')) { need(typeof value.failure === 'string' && /^pin-probe-[a-z-]{1,40}$/.test(value.failure) && Object.keys(value).length === 3, 'pin-output'); throw new AcceptanceError(`live-${value.failure}`); }
    need(Object.keys(value).sort().join() === ['gitPinRecordIds', 'registrations', 'repositories', 'schema', 'version'].sort().join(), 'pin-output');
    const ids = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,200}$/, names = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
    for (const [key, pattern, cap] of [['gitPinRecordIds', ids, PIN_PROBE_LIMITS.ids], ['registrations', ids, PIN_PROBE_LIMITS.ids], ['repositories', names, PIN_PROBE_LIMITS.repositories]]) {
        need(Array.isArray(value[key]) && value[key].length <= cap && value[key].every(item => typeof item === 'string' && pattern.test(item)) && new Set(value[key]).size === value[key].length, 'pin-output');
    }
    return Object.freeze({ gitPinRecordIds: value.gitPinRecordIds, registrations: value.registrations, repositories: value.repositories });
}

export function parseStoreProbeOutput(bytes, input) {
    need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMITS.controlBytes, 'store-output');
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new AcceptanceError('store-output'); }
    need(value && value.schema === STORE_PROBE_SCHEMA && value.version === 1, 'store-output');
    if (Object.hasOwn(value, 'failure')) { need(typeof value.failure === 'string' && /^store-probe-[a-z-]{1,48}$/.test(value.failure) && Object.keys(value).length === 3, 'store-output'); throw new AcceptanceError(`live-${value.failure}`); }
    need(Object.keys(value).sort().join() === ['objects', 'schema', 'targets', 'version'].sort().join() && Array.isArray(value.targets) && value.targets.length === input.targets.length
        && Array.isArray(value.objects) && value.objects.length === input.objects.length, 'store-output');
    value.targets.forEach((row, index) => {
        const identity = input.targets[index].packageName === null;
        need(row && row.label === input.targets[index].label && Object.keys(row).sort().join() === (identity ? IDENTITY_KEYS : FULL_KEYS) && shortText(row.containerName) && hex64(row.runtimeId)
            && shortText(row.instanceId) && shortText(row.enableGeneration) && typeof row.running === 'boolean' && typeof row.labelsEqual === 'boolean'
            && (row.objectId === null || /^[a-f0-9-]{36}$/.test(row.objectId)) && (row.payloadSha256 === null || hex64(row.payloadSha256)) && (row.selectorId === null || hex64(row.selectorId)), 'store-output');
        if (identity) { need(['store', 'none'].includes(row.storeMode) && (row.storeMode === 'store') === (row.objectId !== null), 'store-output'); return; }
        need(shortText(row.startedAt) && Number.isFinite(Date.parse(row.startedAt)) && typeof row.version === 'string' && row.version.length <= 64 && [row.sourceCommit, row.provenanceCommit, row.lockCommit].every(item => /^[a-f0-9]{40}$/.test(item)) && hex64(row.markerSha256)
            && row.treeMatchesManifest === true && Number.isSafeInteger(row.receiptCount) && row.receiptCount >= 0 && typeof row.mountReadOnly === 'boolean' && (row.mountSource === null || shortText(row.mountSource))
            && (row.installerKind === null || shortText(row.installerKind)) && (row.verification === null || shortText(row.verification))
            && (row.readerReceipt === null || (Object.keys(row.readerReceipt).sort().join() === ['enableGeneration', 'instanceId', 'objectId', 'runtimeId'].join() && row.readerReceipt.runtimeId === row.runtimeId
                && row.readerReceipt.objectId === row.objectId)), 'store-output');
    });
    value.objects.forEach((row, index) => need(row && Object.keys(row).sort().join() === ['objectId', 'payloadSha256', 'present', 'treeMatches'].join() && row.objectId === input.objects[index]
        && typeof row.present === 'boolean' && typeof row.treeMatches === 'boolean' && (row.payloadSha256 === null || hex64(row.payloadSha256)), 'store-output'));
    return value;
}

export function createCachePorts({ manifest, deps, env = buildCommandEnvironment(process.env, { PLOINKY_WORKSPACE_ROOT: manifest.workspace.path }) }) {
    const engine = manifest.engine.path, publication = manifest.publications[0], media = manifest.publications[1];
    const run = (operation, kind, argv, extra = {}) => runOwnedCommand({ operation, kind, argv, cwd: manifest.workspace.path, env, deadlineMs: extra.deadlineMs ?? (kind === 'mutation' ? LIMITS.commandMs : 60000), ...extra }, deps);
    const boxExec = (argv, extra = {}) => boxExecArgs({ engineBin: engine, boxId: manifest.box.id, workspace: manifest.workspace.path, routerHostPort: publication.hostPort, mediaHostPort: media.hostPort, argv, ...extra });
    // Output of a mutating CLI command is counted and discarded; only the GC projection below ever inspects any of it.
    const discard = () => ({ push: () => true, end() {} });
    return Object.freeze({
        async probeStore(input) {
            validateStoreProbeInput(input);
            const result = await run('cache-store-probe', 'read', boxExec(['/usr/local/bin/node', '--input-type=module', '-'], { interactive: true }),
                { input: storeProbeBootstrap(input), maxStdoutBytes: LIMITS.controlBytes, allowedExitCodes: [0, 1] });
            const parsed = parseStoreProbeOutput(result.stdout, input); need(result.code === 0, 'store-output'); return parsed;
        },
        // The record vocabulary the next update will emit for registrations, observed offline through the product's own pin refresh.
        async observeAdmissibleIds() {
            const result = await run('cache-pin-probe', 'read', boxExec(['/usr/local/bin/node', '--input-type=module', '-'], { interactive: true }), { input: pinProbeBootstrap(), maxStdoutBytes: LIMITS.controlBytes, allowedExitCodes: [0, 1] });
            const parsed = parsePinProbeOutput(result.stdout); need(result.code === 0, 'pin-output'); return parsed;
        },
        // One bounded read inside the exact reader: the installed marker file's hash, never its content.
        async readerMarkerSha256(containerId, packageName, markerFile) {
            need(hex64(containerId) && /^[a-z0-9][a-z0-9._-]{0,100}$/.test(packageName) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(markerFile), 'reader-read-input');
            const script = `const fs=require('node:fs'),c=require('node:crypto');const b=fs.readFileSync('/code/node_modules/${packageName}/${markerFile}');if(b.length>65536)process.exit(2);console.log(c.createHash('sha256').update(b).digest('hex'))`;
            const result = await run('cache-reader-read', 'read', [engine, 'exec', manifest.box.id, 'podman', 'exec', containerId, 'node', '-e', script], { maxStdoutBytes: 256, allowedExitCodes: [0, 1, 2, 125] });
            const line = result.stdout.toString('utf8').trim(); return result.code === 0 && /^[a-f0-9]{64}$/.test(line) ? line : null;
        },
        async containerLogs(containerId) {
            need(hex64(containerId), 'logs-input');
            const result = await run('cache-container-logs', 'read', [engine, 'exec', manifest.box.id, 'podman', 'logs', '--tail', '200', containerId], { maxStdoutBytes: 256 * 1024, maxStderrBytes: 256 * 1024 });
            return `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
        },
        // A supported outer CLI command. The caller names the operation; arguments are fixed arrays, never a shell string.
        async cli(operation, args, { allowedExitCodes = [0] } = {}) {
            need(Array.isArray(args) && args.length > 0 && args.every(value => typeof value === 'string' && value.length > 0 && !value.includes('\0')), 'cli-arguments');
            return run(operation, 'mutation', [manifest.candidate.cliPath, ...args], { collect: false, tap: discard(), allowedExitCodes });
        },
        // `--debug reinstall <owned alias>` is the only command whose output is parsed: a bounded projection of the
        // ordinary GC summary line. Everything else is counted and dropped.
        async reinstallWithGcSummary(alias, { onChunk } = {}) {
            need(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(alias), 'cli-arguments');
            const projection = createGcOutputProjection();
            const tap = { push: (source, chunk) => { const accepted = projection.push(source, chunk); if (typeof onChunk === 'function') onChunk(projection.snapshot()); return accepted; }, end: source => projection.end(source) };
            const result = await run('cache-reinstall-debug', 'mutation', [manifest.candidate.cliPath, '--debug', 'reinstall', alias], { collect: false, tap });
            const snapshot = projection.snapshot();
            need(snapshot.closed && snapshot.failure === null && snapshot.summary, snapshot.failure ?? 'gc-summary-missing');
            return Object.freeze({ code: result.code, summary: snapshot.summary, bytes: snapshot.bytes, discardedLines: snapshot.discardedLines });
        },
        limits: STORE_PROBE_LIMITS,
    });
}
