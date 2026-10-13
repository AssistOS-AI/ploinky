// Only bounded selected facts cross these observation programs. Probe output
// is parsed inside the agent, never retained as arbitrary text in a receipt.
export const APU_ENV_FACTS = String.raw`
const wanted=JSON.parse(process.argv[1]);const switchValue=process.env.LOCAL_LLM_AMD_APU;const floor=process.env.LOCAL_LLM_APU_GUARD_FLOOR_BYTES;
process.stdout.write(JSON.stringify({switchMatched:wanted.LOCAL_LLM_AMD_APU==='experimental'&&switchValue==='experimental',
floorMatched:typeof wanted.LOCAL_LLM_APU_GUARD_FLOOR_BYTES==='string'&&floor===wanted.LOCAL_LLM_APU_GUARD_FLOOR_BYTES,
unexpectedSwitch:wanted.LOCAL_LLM_AMD_APU===undefined&&switchValue!==undefined&&switchValue!=='',
unexpectedFloor:wanted.LOCAL_LLM_APU_GUARD_FLOOR_BYTES===undefined&&floor!==undefined&&floor!==''}));`;

export function parseApuDiscovery(summary, full, devices) {
    if ([summary, full, devices].some(value => typeof value !== 'string' || value.length > 2097152)) throw Error('AMD discovery bound exceeded');
    const blocks = summary.split(/^GPU[0-9]+:\s*$/m);
    if (blocks.length !== 2) throw Error('AMD discovery device count differs');
    const identity = {};
    for (const field of ['deviceName', 'deviceType', 'driverID', 'deviceID', 'driverInfo', 'apiVersion']) {
        const rows = [...blocks[1].matchAll(new RegExp('^\\s*' + field + '\\s*=\\s*(\\S[^\\r\\n]*)$', 'gm'))];
        if (rows.length !== 1 || rows[0][1].trim().length > 256) throw Error('AMD discovery identity unavailable');
        identity[field] = rows[0][1].trim();
    }
    const heaps = [];
    const sections = full.split(/memoryHeaps\[([0-9]+)\]:/);
    for (let index = 1; index < sections.length; index += 2) {
        const body = sections[index + 1].split(/memoryTypes\[/)[0];
        const size = /^\s*size\s*=\s*([0-9]+)/m.exec(body);
        const flags = /^\s*flags:\s*(.*)$/m.exec(body);
        const flagNames = [...body.matchAll(/^\s*(?:VK_)?MEMORY_HEAP_([A-Z_]+)_BIT\s*$/gm)].map(row => row[1]).sort();
        if (Number(sections[index]) !== heaps.length || !size || !flags) throw Error('AMD Vulkan heap unavailable');
        heaps.push({ sizeBytes: Number(size[1]), flags: flagNames.join('|') || flags[1].trim() });
    }
    if (!heaps.length || heaps.length > 16) throw Error('AMD Vulkan heaps unavailable');
    const lines = devices.trimEnd().split(/\r?\n/);
    const row = lines.length === 2 && lines[0] === 'Available devices:' && /^  Vulkan0: (.*) \(([0-9]+) MiB, ([0-9]+) MiB free\)$/.exec(lines[1]);
    if (!row) throw Error('AMD runner device unavailable');
    return { vulkan: { ...identity, heaps }, devices: { name: row[1], totalBytes: Number(row[2]) * 1048576, freeBytes: Number(row[3]) * 1048576 } };
}
export const APU_DISCOVERY = `try {
const {execFileSync}=require('node:child_process');
const env={PATH:'/usr/bin:/bin',HOME:'/tmp',LANG:'C.UTF-8',VK_DRIVER_FILES:'/opt/local-llm/vulkan/icd.d/radeon_icd.json',VK_LOADER_LAYERS_DISABLE:'~all~',MESA_SHADER_CACHE_DISABLE:'true'};
const run=(file,args)=>execFileSync(file,args,{env,encoding:'utf8',timeout:20000,maxBuffer:2097152,stdio:['ignore','pipe','pipe']});
const value=(${parseApuDiscovery.toString()})(run('/usr/bin/vulkaninfo',['--summary']),run('/usr/bin/vulkaninfo',[]),run('/opt/llama.cpp-vulkan/llama-server',['--list-devices']));
process.stdout.write(JSON.stringify(value));
}catch{process.stderr.write('AMD discovery unavailable');process.exitCode=1;}`;
