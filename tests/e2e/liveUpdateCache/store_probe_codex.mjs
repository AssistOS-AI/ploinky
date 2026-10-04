import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProbeFailure, inspectNestedContainers } from './box_probe_codex.mjs';

// In-Box, read-only projection of the dependency-store facts the cache phases compare: the admitted record's
// object/generation, the installed package's version, lock and provenance commits and marker hash, the object's
// tree hash recomputed with the store's own function, the exact reader receipt and the live reader's mount.
// It never calls a store mutator, never takes a lease and prints one public document or one fixed failure code.
export const STORE_PROBE_SCHEMA = 'live-update-cache-store-probe';
export const STORE_PROBE_LIMITS = Object.freeze({ targets: 8, objects: 16, manifestBytes: 1024 * 1024, lockBytes: 8 * 1024 * 1024, markerBytes: 64 * 1024, receiptBytes: 64 * 1024, receipts: 512 });
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const objectIdOf = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const component = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const need = (condition, code) => { if (!condition) throw new ProbeFailure(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = value => Object.keys(value).sort().join();

export function validateStoreProbeInput(input) {
    need(input && keys(input) === ['objects', 'targets'].join() && Array.isArray(input.targets) && input.targets.length <= STORE_PROBE_LIMITS.targets
        && Array.isArray(input.objects) && input.objects.length <= STORE_PROBE_LIMITS.objects && input.targets.length + input.objects.length > 0, 'store-probe-input');
    const labels = new Set();
    for (const target of input.targets) {
        need(target && keys(target) === ['alias', 'agentName', 'label', 'markerFile', 'packageName', 'repoName'].sort().join() && component(target.label) && !labels.has(target.label)
            && component(target.repoName) && component(target.agentName) && (target.alias === null || component(target.alias))
            // Identity mode (both null) covers runtimes whose package is not the fixture's, e.g. the declared graph.
            && ((target.packageName === null && target.markerFile === null) || (typeof target.packageName === 'string' && /^[a-z0-9][a-z0-9._-]{0,100}$/.test(target.packageName) && component(target.markerFile))), 'store-probe-input');
        labels.add(target.label);
    }
    need(input.objects.every(id => objectIdOf(id)) && new Set(input.objects).size === input.objects.length, 'store-probe-input');
    return input;
}

function readRegular(io, file, cap, code) {
    let fd;
    try { fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { throw new ProbeFailure(code); }
    try {
        const before = io.fstatSync(fd); need(before.isFile() && before.size <= cap, code);
        const buffer = Buffer.alloc(cap + 1); let offset = 0;
        for (;;) { const count = io.readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count; need(offset <= cap, code); }
        const after = io.fstatSync(fd); need(after.size === offset && after.ino === before.ino && after.dev === before.dev, code);
        return buffer.subarray(0, offset);
    } finally { io.closeSync(fd); }
}
const readJson = (io, file, cap, code) => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readRegular(io, file, cap, code))); } catch (error) { throw error instanceof ProbeFailure ? error : new ProbeFailure(code); } };

export async function loadStoreApis(root = '/opt/ploinky') {
    const [registry, tree] = await Promise.all([import(path.join(root, 'cli/utils/agentRegistrySnapshot.js')), import(path.join(root, 'cli/utils/dependencies/store/treeHash.mjs'))]);
    return { readAgentRegistrySnapshot: registry.readAgentRegistrySnapshot, hashInstalledTree: tree.hashInstalledTree };
}

function inspectObject(storeRoot, objectId, { apis, io, withTree = true }) {
    const dir = path.join(storeRoot, 'objects', objectId);
    let stat; try { stat = io.lstatSync(dir); } catch { return { objectId, present: false, treeMatches: false, payloadSha256: null }; }
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'store-probe-object-shape');
    const manifest = readJson(io, path.join(dir, 'manifest.json'), STORE_PROBE_LIMITS.manifestBytes, 'store-probe-manifest');
    const expected = manifest?.tree?.hash; need(hex64(expected), 'store-probe-manifest');
    let treeMatches = false;
    if (withTree) {
        let computed; try { computed = apis.hashInstalledTree(path.join(dir, 'payload'), { approvedExternalTargets: Array.isArray(manifest.approvedExternalTargets) ? manifest.approvedExternalTargets : [] }).hash; } catch { throw new ProbeFailure('store-probe-tree'); }
        treeMatches = computed === expected;
    }
    return { objectId, present: true, treeMatches, payloadSha256: expected, manifest, dir };
}

function projectTarget(target, { workspaceRoot, registry, rows, apis, io, storeRoot }) {
    const matches = Object.entries(registry).filter(([, record]) => record?.type === 'agent' && record.repoName === target.repoName && record.agentName === target.agentName && (record.alias ?? null) === target.alias);
    need(matches.length === 1, matches.length ? 'store-probe-ambiguous' : 'store-probe-missing');
    const [containerName, record] = matches[0], dependencies = record.dependencies, identityOnly = target.packageName === null;
    const identity = row => ({ label: target.label, containerName, runtimeId: row.id, instanceId: record.instanceId, enableGeneration: record.enableGeneration, running: row.running === true,
        labelsEqual: row.instanceId === record.instanceId && row.enableGeneration === record.enableGeneration && row.name === containerName });
    if (identityOnly && dependencies?.mode === 'none') {
        need(hex64(String(record.containerId || '').toLowerCase()) && record.runtime === 'podman' && record.instanceId && record.enableGeneration, 'store-probe-record');
        return { ...identity(rows.get(String(record.containerId).toLowerCase())), objectId: null, selectorId: null, payloadSha256: null, storeMode: 'none' };
    }
    need(dependencies?.mode === 'store' && objectIdOf(dependencies.objectId) && hex64(dependencies.generationId) && hex64(String(record.containerId || '').toLowerCase()) && record.runtime === 'podman'
        && typeof record.instanceId === 'string' && record.instanceId && typeof record.enableGeneration === 'string' && record.enableGeneration, 'store-probe-record');
    const object = inspectObject(storeRoot, dependencies.objectId, { apis, io });
    need(object.present && object.treeMatches, 'store-probe-object');
    need(path.resolve(String(dependencies.payloadPath || '')) === path.join(object.dir, 'payload'), 'store-probe-record');
    if (identityOnly) {
        const row = rows.get(String(record.containerId).toLowerCase());
        return { ...identity(row), objectId: dependencies.objectId, selectorId: dependencies.generationId, payloadSha256: object.payloadSha256, storeMode: 'store' };
    }
    const provenance = (Array.isArray(object.manifest.provenance) ? object.manifest.provenance : []).find(entry => entry?.name === target.packageName);
    need(provenance && /^[a-f0-9]{40}$/.test(provenance.commit ?? ''), 'store-probe-provenance');
    const nodeModules = path.join(object.dir, 'payload', 'node_modules');
    const lock = readJson(io, path.join(nodeModules, '.package-lock.json'), STORE_PROBE_LIMITS.lockBytes, 'store-probe-lock');
    const resolved = lock?.packages?.[`node_modules/${target.packageName}`]?.resolved; need(typeof resolved === 'string' && /#[a-f0-9]{40}$/.test(resolved), 'store-probe-lock');
    const installed = readJson(io, path.join(nodeModules, target.packageName, 'package.json'), STORE_PROBE_LIMITS.manifestBytes, 'store-probe-package'); need(typeof installed?.version === 'string', 'store-probe-package');
    const marker = readRegular(io, path.join(nodeModules, target.packageName, target.markerFile), STORE_PROBE_LIMITS.markerBytes, 'store-probe-marker');
    const row = rows.get(String(record.containerId).toLowerCase());
    const mount = row.mounts.find(item => item.source === path.join(object.dir, 'payload', 'node_modules') || item.source === path.join(object.dir, 'payload') || item.source.startsWith(`${object.dir}/`));
    const key = `container:${containerName}:${record.instanceId}:${record.enableGeneration}`;
    const receipts = readReceipts(storeRoot, io).filter(receipt => receipt.objectId === dependencies.objectId && receipt.consumer?.kind === 'container' && receipt.consumer.key === key && receipt.generationId === dependencies.generationId);
    return { label: target.label, containerName, runtimeId: row.id, startedAt: row.startedAt, instanceId: record.instanceId, enableGeneration: record.enableGeneration, running: row.running === true,
        labelsEqual: row.instanceId === record.instanceId && row.enableGeneration === record.enableGeneration && row.name === containerName,
        objectId: dependencies.objectId, selectorId: dependencies.generationId, version: installed.version, sourceCommit: provenance.commit, provenanceCommit: provenance.commit, lockCommit: resolved.slice(resolved.lastIndexOf('#') + 1),
        markerSha256: sha(marker), payloadSha256: object.payloadSha256, treeMatchesManifest: true, installerKind: typeof object.manifest.resolution?.installer?.kind === 'string' ? object.manifest.resolution.installer.kind : null,
        verification: typeof provenance.verification === 'string' ? provenance.verification : null,
        readerReceipt: receipts.length === 1 ? { runtimeId: row.id, instanceId: record.instanceId, enableGeneration: record.enableGeneration, objectId: dependencies.objectId } : null, receiptCount: receipts.length,
        mountSource: mount?.source ?? null, mountReadOnly: mount?.readOnly === true };
}

function readReceipts(storeRoot, io) {
    const dir = path.join(storeRoot, 'receipts', 'readers'); let names;
    try { names = io.readdirSync(dir); } catch { return []; }
    need(names.length <= STORE_PROBE_LIMITS.receipts, 'store-probe-receipts');
    return names.filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)).map(name => readJson(io, path.join(dir, name), STORE_PROBE_LIMITS.receiptBytes, 'store-probe-receipt'));
}

export async function runStoreProbe(input, { workspaceRoot, apis, io = fs, inspect = inspectNestedContainers } = {}) {
    validateStoreProbeInput(input); need(typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot) && apis, 'store-probe-environment');
    const storeRoot = path.join(workspaceRoot, '.ploinky', 'deps', 'store');
    let registry; try { registry = apis.readAgentRegistrySnapshot({ workspaceRoot }); } catch { throw new ProbeFailure('store-probe-registry'); }
    const ids = input.targets.map(target => { const record = Object.values(registry).find(item => item?.type === 'agent' && item.repoName === target.repoName && item.agentName === target.agentName && (item.alias ?? null) === target.alias);
        need(record && hex64(String(record.containerId || '').toLowerCase()), 'store-probe-missing'); return String(record.containerId).toLowerCase(); });
    const rows = ids.length ? inspect(ids) : new Map();
    const targets = input.targets.map(target => projectTarget(target, { workspaceRoot, registry, rows, apis, io, storeRoot }));
    const objects = input.objects.map(objectId => { const found = inspectObject(storeRoot, objectId, { apis, io }); return { objectId, present: found.present, treeMatches: found.treeMatches, payloadSha256: found.payloadSha256 }; });
    let after; try { after = apis.readAgentRegistrySnapshot({ workspaceRoot }); } catch { throw new ProbeFailure('store-probe-registry'); }
    const tuple = records => input.targets.map(target => { const record = Object.values(records).find(item => item?.type === 'agent' && item.repoName === target.repoName && item.agentName === target.agentName && (item.alias ?? null) === target.alias);
        return [record?.containerId, record?.instanceId, record?.enableGeneration, record?.dependencies?.objectId, record?.dependencies?.generationId]; });
    need(JSON.stringify(tuple(after)) === JSON.stringify(tuple(registry)), 'store-probe-registry-changed');
    return { schema: STORE_PROBE_SCHEMA, version: 1, targets, objects };
}

export async function storeProbeMain({ input, workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT, write = value => process.stdout.write(`${JSON.stringify(value)}\n`), load = loadStoreApis } = {}) {
    try { write(await runStoreProbe(input, { workspaceRoot, apis: await load() })); return 0; }
    catch (error) { write({ schema: STORE_PROBE_SCHEMA, version: 1, failure: error instanceof ProbeFailure ? error.code : 'store-probe-failed' }); return 1; }
}
