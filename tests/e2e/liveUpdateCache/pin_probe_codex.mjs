import fs from 'node:fs';
import path from 'node:path';
import { ProbeFailure } from './box_probe_codex.mjs';

// In-Box, read-only observation of the record vocabulary an update will emit for registrations, taken immediately before
// the update. It runs the product's own Git-pin refresh over the enabled registrations with discovery stubbed (no network,
// no resolution) and the pin store replaced by a read-only view, so the pin ids and registration keys it returns are the
// ones the product itself derives, never a reimplementation. It writes nothing and prints one public document.
export const PIN_PROBE_SCHEMA = 'live-update-cache-pin-probe';
export const PIN_PROBE_LIMITS = Object.freeze({ ids: 4096, repositories: 256, pinsBytes: 8 * 1024 * 1024, sourcesBytes: 1024 * 1024 });
const need = (condition, code) => { if (!condition) throw new ProbeFailure(code); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,200}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function loadPinApis(root = '/opt/ploinky') {
    const [pins, registry] = await Promise.all([import(path.join(root, 'cli/utils/dependencies/store/updatePins.mjs')), import(path.join(root, 'cli/utils/agentRegistrySnapshot.js'))]);
    return { refreshUpdateGitPins: pins.refreshUpdateGitPins, readAgentRegistrySnapshot: registry.readAgentRegistrySnapshot };
}

function readBounded(io, file, cap, code, optional) {
    let fd; try { fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (error) { if (optional && error?.code === 'ENOENT') return null; throw new ProbeFailure(code); }
    try {
        const stat = io.fstatSync(fd); need(stat.isFile() && stat.size <= cap, code);
        const buffer = Buffer.alloc(cap + 1); let offset = 0;
        for (;;) { const count = io.readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count; need(offset <= cap, code); }
        return buffer.subarray(0, offset);
    } finally { io.closeSync(fd); }
}

export async function runPinProbe(input, { workspaceRoot, apis, io = fs } = {}) {
    need(input && Object.keys(input).length === 0 && typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot) && apis, 'pin-probe-input');
    const pinsBytes = readBounded(io, path.join(workspaceRoot, '.ploinky', 'deps', 'store', 'state', 'pins.json'), PIN_PROBE_LIMITS.pinsBytes, 'pin-probe-pins', true);
    let current = {}; if (pinsBytes) { try { const parsed = JSON.parse(pinsBytes.toString('utf8')); current = parsed?.pins && typeof parsed.pins === 'object' ? parsed.pins : {}; } catch { throw new ProbeFailure('pin-probe-pins'); } }
    // Read-only pin store and offline discovery: the product derives every id; nothing is resolved or published.
    const store = { readPins: () => ({ pins: current }), updatePins() {} };
    const discover = (entries, { unsupported = [] } = {}) => ({ queriesRun: 0, results: [...unsupported.map(item => ({ pinId: item.pinId, status: 'unsupported', reason: 'observed' })),
        ...entries.map(entry => ({ pinId: entry.pinId, status: 'fixed', commit: '0'.repeat(40) }))] });
    let result; try { result = await apis.refreshUpdateGitPins({ repositoryNames: null, sourceOutcomes: null }, { workspaceRoot, store, discover, withLease: (_options, perform) => perform(null) }); } catch { throw new ProbeFailure('pin-probe-refresh'); }
    need(result && Array.isArray(result.records), 'pin-probe-refresh');
    let registry; try { registry = apis.readAgentRegistrySnapshot({ workspaceRoot }); } catch { throw new ProbeFailure('pin-probe-registry'); }
    const registrations = Object.entries(registry).filter(([key, record]) => key !== '_config' && record?.type === 'agent').map(([key]) => key);
    const repositories = new Set(Object.values(registry).filter(record => record?.type === 'agent' && typeof record.repoName === 'string').map(record => record.repoName));
    const sources = readBounded(io, path.join(workspaceRoot, '.ploinky', 'repo_sources.json'), PIN_PROBE_LIMITS.sourcesBytes, 'pin-probe-sources', true);
    if (sources) { try { const parsed = JSON.parse(sources.toString('utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const key of Object.keys(parsed)) repositories.add(key); } catch { throw new ProbeFailure('pin-probe-sources'); } }
    try { for (const name of io.readdirSync(path.join(workspaceRoot, '.ploinky', 'repos'))) repositories.add(name); } catch { /* an absent directory contributes nothing */ }
    const unique = values => [...new Set(values)].sort();
    const gitPinRecordIds = unique(result.records.filter(record => record.phase === 'git-pin').map(record => record.id));
    const document = { schema: PIN_PROBE_SCHEMA, version: 1, gitPinRecordIds, registrations: unique(registrations), repositories: unique([...repositories].filter(name => NAME.test(name))) };
    need([document.gitPinRecordIds, document.registrations].every(list => list.length <= PIN_PROBE_LIMITS.ids && list.every(id => ID.test(id))) && document.repositories.length <= PIN_PROBE_LIMITS.repositories, 'pin-probe-bound');
    return document;
}

export async function pinProbeMain({ input, workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT, write = value => process.stdout.write(`${JSON.stringify(value)}\n`), load = loadPinApis } = {}) {
    try { write(await runPinProbe(input, { workspaceRoot, apis: await load() })); return 0; }
    catch (error) { write({ schema: PIN_PROBE_SCHEMA, version: 1, failure: error instanceof ProbeFailure ? error.code : 'pin-probe-failed' }); return 1; }
}
