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
    // Only the five predefined XML entities may appear (a process name can carry
    // `&amp;`); a custom entity, a stray ampersand or CDATA is unsupported.
    if (typeof xml !== 'string' || xml.length > 1048576 || /<!ENTITY|&(?!(?:amp|lt|gt|quot|apos);)|<!\[/.test(xml)
        || !xml.includes('</nvidia_smi_log>') || (xml.match(/<gpu\s+id=/g) || []).length !== 1) throw new Error('Unsupported GPU inventory');
    if (!/^GPU-[a-fA-F0-9-]{8,64}$/.test(expectedUuid) || textTag(xml, 'uuid') !== expectedUuid
        || textTag(xml, 'compute_mode') !== 'Default') throw new Error('GPU device or compute mode mismatch');
    // Exactly one process-inventory section, inside the one selected device: two
    // sections (an empty one first, a busy one second, or the reverse) are an
    // ambiguous structure, never read as "the first one".
    const device = /<gpu\s+id=[^>]*>([\s\S]*?)<\/gpu>/.exec(xml);
    const sections = [...xml.matchAll(/<processes>([\s\S]*?)<\/processes>/g)];
    const opens = (xml.match(/<processes>/g) || []).length; const closes = (xml.match(/<\/processes>/g) || []).length;
    if (!device || (xml.match(/<\/gpu>/g) || []).length !== 1) throw new Error('Unsupported GPU inventory');
    if (opens !== closes || sections.length !== opens || sections.length > 1) throw new Error('Ambiguous GPU process inventory structure');
    const section = sections[0];
    if (!section || !device[1].includes(section[0])) throw new Error('GPU activity inventory unavailable');
    const rows = [...section[1].matchAll(/<process_info>([\s\S]*?)<\/process_info>/g)];
    // What is left of the section once the process rows are removed must be
    // empty: `N/A` or `Not Supported` there means the inventory is unavailable.
    // A row's own fields (its MIG instance ids are `N/A` on a plain GPU) are
    // not the section's support state; a PID that is not a number still blocks below.
    const outside = section[1].replace(/<process_info>[\s\S]*?<\/process_info>/g, '').trim();
    if (/N\/A|Not Supported/i.test(outside)) throw new Error('GPU activity inventory unavailable');
    if (outside) throw new Error('Unknown GPU activity grammar');
    const processes = rows.map(row => {
        const pid = textTag(row[1], 'pid');
        const type = textTag(row[1], 'type');
        if (!/^[1-9][0-9]{0,9}$/.test(pid) || !Number.isSafeInteger(Number(pid)) || !GPU_PROCESS_TYPES.includes(type)) throw new Error('Malformed GPU process');
        return { pid: Number(pid), type };
    });
    return { processes, uuid: expectedUuid };
}

// nvidia-smi's process types. An MPS server is listed as M+C (compute through
// MPS); any other spelling is an unsupported grammar and blocks.
export const GPU_PROCESS_TYPES = Object.freeze(['C', 'G', 'C+G', 'M', 'M+C', 'M+G', 'M+C+G']);

// The device's dedicated memory, exactly as nvidia-smi -q -x prints it inside
// its single fb_memory_usage element ("6144 MiB"). Anything else blocks.
export function parseGpuMemory(result) {
    requireTransport(result);
    const xml = result.stdout;
    const sections = typeof xml === 'string' ? [...xml.matchAll(/<fb_memory_usage>([\s\S]*?)<\/fb_memory_usage>/g)] : [];
    if (sections.length !== 1) throw new Error('Unsupported GPU memory reply');
    const read = tag => {
        const found = [...sections[0][1].matchAll(new RegExp(`<${tag}>([0-9]{1,9}) MiB</${tag}>`, 'g'))];
        if (found.length !== 1) throw new Error(`Unsupported GPU memory ${tag} reply`);
        return Number(found[0][1]);
    };
    const memory = { totalMiB: read('total'), usedMiB: read('used'), freeMiB: read('free') };
    if (memory.totalMiB <= 0 || memory.usedMiB > memory.totalMiB || memory.freeMiB > memory.totalMiB) throw new Error('Inconsistent GPU memory reply');
    return memory;
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
