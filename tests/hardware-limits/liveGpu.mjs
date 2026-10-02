// Strict supported nvidia-smi XML grammar. Unsupported driver output blocks.
// This module never changes compute mode or controls foreign processes.
import { requireTransport } from './liveProcess.mjs';
import { evaluateGpuIdleGate } from './fixtures.mjs';

function textTag(xml, tag) {
    const matches = [...xml.matchAll(new RegExp(`<${tag}>([^<>]*)</${tag}>`, 'g'))];
    if (matches.length !== 1) throw new Error(`Unsupported GPU ${tag} reply`);
    return matches[0][1].trim();
}
export function parseGpuInventory(result, expectedUuid) {
    requireTransport(result);
    const xml = result.stdout;
    // A literal NVIDIA doctype has no custom entity definitions. Entity
    // references, nested/ambiguous device results and partial XML are rejected.
    if (typeof xml !== 'string' || xml.length > 1048576 || /<!ENTITY|&|<!\[/.test(xml)
        || !xml.includes('</nvidia_smi_log>') || (xml.match(/<gpu\s+id=/g) || []).length !== 1) throw new Error('Unsupported GPU inventory');
    if (!/^GPU-[a-fA-F0-9-]{8,64}$/.test(expectedUuid) || textTag(xml, 'uuid') !== expectedUuid
        || textTag(xml, 'compute_mode') !== 'Default') throw new Error('GPU device or compute mode mismatch');
    const section = xml.match(/<processes>([\s\S]*?)<\/processes>/);
    if (!section || /N\/A|Not Supported/i.test(section[1])) throw new Error('GPU activity inventory unavailable');
    const rows = [...section[1].matchAll(/<process_info>([\s\S]*?)<\/process_info>/g)];
    if (section[1].replace(/<process_info>[\s\S]*?<\/process_info>/g, '').trim()) throw new Error('Unknown GPU activity grammar');
    const processes = rows.map(row => {
        const pid = textTag(row[1], 'pid');
        const type = textTag(row[1], 'type');
        if (!/^[1-9][0-9]{0,9}$/.test(pid) || !Number.isSafeInteger(Number(pid)) || !['C', 'G', 'C+G', 'M'].includes(type)) throw new Error('Malformed GPU process');
        return { pid: Number(pid), type };
    });
    return { processes, uuid: expectedUuid };
}

export async function requireGpuIdle({ query, expectedUuid, initial = false, owned = [], observe, bootId, boxCgroupPrefix }) {
    const inventory = parseGpuInventory(await query(), expectedUuid);
    const observations = new Map();
    for (const record of owned) observations.set(record.hostPid, await observe(record.hostPid));
    const result = evaluateGpuIdleGate({
        query: { ok: true, status: 0, signal: null, stdout: inventory.processes.map(value => String(value.pid)).join('\n') },
        activity: { supported: true, foreign: [] },
        initial, owned, observe: pid => observations.get(pid), bootId, boxCgroupPrefix,
    });
    if (result.state !== 'idle') throw new Error(`GPU idle gate blocked: ${result.reason}`);
    return inventory;
}
