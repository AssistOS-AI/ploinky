// Host-side hardware-limits proofs for one exact Box (plan §7.1).
//
// The outer runtime is read from the exact container's inspect, never
// inferred from a changed engine default. The fixed root preparation script
// is executed only from a canonical, read-only, workspace-disjoint source,
// with a fixed verb, workdir /, absolute node and a cleared Node environment.

import fs from 'node:fs';
import path from 'node:path';

export const PREPARE_SCRIPT_BOX_PATH = '/opt/ploinky/ploinky-box/entrypoint/cgroupDelegation.mjs';
export const PREPARE_TIMEOUT_MS = 30_000;
export const PREPARE_RESULT_MAX_BYTES = 8 * 1024;
const RESULT_KEYS = ['schema', 'structurallyPrepared', 'already', 'controllers', 'missing', 'movedPids', 'nsdelegate', 'reason'];

/**
 * Missing, ambiguous or non-crun runtime metadata on the exact Box means
 * runtime_unverified.
 */
export function verifyBoxRuntime({ configuredRuntime, inspectedRuntime }) {
    const configured = String(configuredRuntime || '').trim();
    const inspected = String(inspectedRuntime || '').trim();
    const name = (value) => path.basename(value);
    if (!inspected) return { verified: false, observed: `${configured || 'unknown'}/unknown`, reason: 'the Box OCI runtime is not recorded' };
    if (name(inspected) !== 'crun') return { verified: false, observed: `${configured || 'unknown'}/${inspected}`, reason: `the Box runs ${inspected}, not crun` };
    return { verified: true, observed: `${configured || 'unknown'}/${inspected}`, reason: null };
}

function containsPath(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The script must be a canonical regular single-link file in the read-only
 * Ploinky source, and that source must be disjoint from every writable Box
 * source (workspace, caches). A workspace-writable alias is not trusted just
 * because /opt/ploinky is mounted read-only.
 */
export function assertPreparationSourceIsolated({ repositoryRoot, writableSources = [], fsApi = fs }) {
    const root = fsApi.realpathSync.native(repositoryRoot);
    const script = path.join(root, 'ploinky-box', 'entrypoint', 'cgroupDelegation.mjs');
    const stat = fsApi.lstatSync(script);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw new Error('the preparation script is not one canonical regular file');
    }
    if (fsApi.realpathSync.native(script) !== script) throw new Error('the preparation script has a canonical alias');
    for (const source of writableSources) {
        if (!source) continue;
        let writable;
        try { writable = fsApi.realpathSync.native(source); } catch (_) { writable = path.resolve(source); }
        if (containsPath(writable, root) || containsPath(root, writable)) {
            throw new Error(`the Ploinky installation ${root} overlaps writable Box source ${source}; place the host installation outside the deployed workspace and caches`);
        }
    }
    return { script, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
}

export function parsePreparationResult(stdout) {
    const text = String(stdout || '').trim();
    if (!text || Buffer.byteLength(text) > PREPARE_RESULT_MAX_BYTES || text.includes('\n')) {
        return { structurallyPrepared: false, reason: 'the preparation result is missing, multi-line or oversized' };
    }
    let value;
    try {
        value = JSON.parse(text);
    } catch (_) {
        return { structurallyPrepared: false, reason: 'the preparation result is not JSON' };
    }
    if (!value || typeof value !== 'object' || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...RESULT_KEYS].sort())
        || value.schema !== 1 || typeof value.structurallyPrepared !== 'boolean' || !Array.isArray(value.controllers)
        || !Array.isArray(value.missing)) {
        return { structurallyPrepared: false, reason: 'the preparation result has an unexpected shape' };
    }
    return value;
}

/**
 * Run the fixed root preparation in the exact Box generation. A failure is
 * reported, never fatal to the core: limited agents are refused later.
 */
export async function prepareBoxGeneration({
    engine,
    containerId,
    runner,
    repositoryRoot,
    writableSources = [],
    fsApi = fs,
}) {
    if (!/^[a-f0-9]{12,64}$/.test(String(containerId))) throw new Error('preparation requires the exact immutable Box ID');
    // The outer runtime comes from the exact Box's inspect (and the configured
    // engine default is reported beside it), never inferred from the default.
    const inspected = runner.query(engine.name, ['container', 'inspect', '--format', '{{.OCIRuntime}}', containerId], { timeoutMs: 10_000 });
    const configured = runner.query(engine.name, ['info', '--format', '{{.Host.OCIRuntime.Name}}'], { timeoutMs: 10_000 });
    const runtime = verifyBoxRuntime({
        configuredRuntime: configured?.ok ? String(configured.stdout || '').trim() : '',
        inspectedRuntime: inspected?.ok ? String(inspected.stdout || '').trim() : '',
    });
    if (!runtime.verified) {
        return Object.freeze({
            schema: 1, structurallyPrepared: false, already: false, controllers: [], missing: [], movedPids: 0, nsdelegate: false,
            reason: `runtime_unverified: ${runtime.reason} (observed ${runtime.observed}). Hardware limits require verified crun; `
                + 'for the outer engine set runtime="crun" in the [engine] section of that engine user\'s ~/.config/containers/containers.conf, then run ploinky restart.',
        });
    }
    assertPreparationSourceIsolated({ repositoryRoot, writableSources, fsApi });
    // Revalidated immediately before exec.
    assertPreparationSourceIsolated({ repositoryRoot, writableSources, fsApi });
    const result = runner.query(engine.name, [
        'container', 'exec',
        '--user', 'root',
        '--workdir', '/',
        '--env', 'NODE_OPTIONS=',
        '--env', 'NODE_PATH=',
        containerId,
        '/usr/local/bin/node',
        PREPARE_SCRIPT_BOX_PATH,
        'prepare',
    ], { timeoutMs: PREPARE_TIMEOUT_MS });
    const parsed = parsePreparationResult(result?.stdout);
    if (!result?.ok && parsed.structurallyPrepared) {
        return { ...parsed, structurallyPrepared: false, reason: `preparation exited with status ${result?.status}` };
    }
    return parsed;
}
