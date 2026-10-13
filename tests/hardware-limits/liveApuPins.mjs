// Frozen APU cohort configuration. These pins describe a probe, never a
// hardware qualification or an authorization to operate its host.
import { keys, jsonDigest } from './liveCommon.mjs';

export const APU_CASES = Object.freeze({ 'amd-apu': ['LIVE-L13', 'LIVE-L9', 'LIVE-L11', 'LIVE-L12'],
    'amd-apu-pressure': ['LIVE-L10'], 'amd-apu-cpu': ['LIVE-L8'] });
export const APU_PARAMS = Object.freeze({ ctxSize: 4096, parallel: 1 });
export const APU_STOP_MS = 60000;
export const isApuModel = model => Object.hasOwn(APU_CASES, model?.profile);
const check = (value, message) => { if (!value) throw new Error(message); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const hex = value => /^0x[0-9a-f]{4}$/.test(value);
const GIB = 1073741824;
const MIB = 1048576;

export function pressureFloor(memTotalBytes) {
    const floor = memTotalBytes + GIB;
    check(Number.isSafeInteger(memTotalBytes) && memTotalBytes > 0 && Number.isSafeInteger(floor) && floor > memTotalBytes,
        'APU pressure floor must be safe pinned MemTotal plus 1 GiB');
    return floor;
}

export function apuEnvironment(model) {
    if (!isApuModel(model) || model.profile === 'amd-apu-cpu') return {};
    const env = { LOCAL_LLM_AMD_APU: 'experimental' };
    if (model.profile === 'amd-apu-pressure') env.LOCAL_LLM_APU_GUARD_FLOOR_BYTES = String(pressureFloor(model.amd.host.memTotalBytes));
    return env;
}

export function validateApuPins(model, { prepared = false } = {}) {
    const pin = model.amd;
    keys(pin, ['pci', 'render', 'host', 'memory', 'vulkan', 'devices'], 'AMD pins');
    keys(pin.pci, ['vendor', 'device', 'revision', 'subsystemVendor', 'subsystemDevice'], 'AMD PCI');
    check(pin.pci.vendor === '0x1002' && [pin.pci.device, pin.pci.subsystemVendor, pin.pci.subsystemDevice].every(hex)
        && /^0x[0-9a-f]{2}$/.test(pin.pci.revision), 'Invalid AMD PCI identity');
    keys(pin.render, ['path', 'major', 'minor', 'mode', 'driver'], 'AMD render node');
    check(/^\/dev\/dri\/renderD[0-9]+$/.test(pin.render.path) && pin.render.major === 226
        && Number.isSafeInteger(pin.render.minor) && pin.render.minor >= 128 && pin.render.minor <= 1048575
        && pin.render.path === `/dev/dri/renderD${pin.render.minor}` && /^0[0-7]{3}$/.test(pin.render.mode)
        && (parseInt(pin.render.mode, 8) & 6) === 6 && pin.render.driver === 'amdgpu', 'Invalid AMD render identity');
    keys(pin.host, ['kernel', 'os', 'memTotalBytes', 'availableBytes', 'umaLabel'], 'AMD host');
    check([pin.host.kernel, pin.host.os, pin.host.umaLabel].every(text)
        && integer(pin.host.memTotalBytes) && pin.host.memTotalBytes > 0 && integer(pin.host.availableBytes)
        && pin.host.availableBytes <= pin.host.memTotalBytes, 'Invalid AMD host memory');
    keys(pin.memory, ['vramTotalBytes', 'gttTotalBytes'], 'AMD memory');
    check(Object.values(pin.memory).every(value => integer(value) && value > 0), 'Invalid AMD memory pins');
    keys(pin.vulkan, ['deviceName', 'deviceType', 'driverID', 'deviceID', 'driverInfo', 'apiVersion', 'heaps'], 'AMD Vulkan');
    check(pin.vulkan.deviceType === 'PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU' && pin.vulkan.driverID === 'DRIVER_ID_MESA_RADV'
        && [pin.vulkan.deviceName, pin.vulkan.deviceID, pin.vulkan.driverInfo, pin.vulkan.apiVersion].every(text)
        && Array.isArray(pin.vulkan.heaps) && pin.vulkan.heaps.length > 0 && pin.vulkan.heaps.length <= 16, 'Invalid AMD Vulkan identity');
    for (const heap of pin.vulkan.heaps) {
        keys(heap, ['sizeBytes', 'flags'], 'AMD Vulkan heap');
        check(integer(heap.sizeBytes) && heap.sizeBytes > 0 && text(heap.flags), 'Invalid AMD Vulkan heap');
    }
    keys(pin.devices, ['name', 'totalBytes', 'freeBytes'], 'AMD runner device');
    check(text(pin.devices.name) && integer(pin.devices.totalBytes) && pin.devices.totalBytes > 0
        && integer(pin.devices.freeBytes) && pin.devices.freeBytes <= pin.devices.totalBytes, 'Invalid AMD runner device');
    if (model.profile === 'amd-apu-pressure') {
        const floor = pressureFloor(pin.host.memTotalBytes);
        check(model.guardFloorBytes === undefined && !prepared || model.guardFloorBytes === floor, 'APU pressure floor differs from pin');
    } else check(model.guardFloorBytes === undefined, 'APU floor override on a non-pressure block');
    if (prepared) {
        check(model.envDelivery === 'manifest-default' && jsonDigest(model.env) === jsonDigest(apuEnvironment(model)), 'APU environment delivery differs');
        if (model.profile === 'amd-apu') validateRefusal(model.refusal, pin);
        else check(model.refusal === undefined, 'Refusal configuration on another block');
    }
    check(model.measurement === undefined && model.apple === undefined, 'APU cannot use Apple measurement or machine pins');
}

// Matches the frozen production C1/C2 arithmetic. The receipt contains all
// inputs and is recalculated at every boundary; no claimed verdict is trusted.
export function apuAdmission(entry, params, pin) {
    const kvBytes = entry.kvBytesPerToken * params.ctxSize * params.parallel + entry.fixedKvBytes;
    const computeBytes = Math.round(2146 * MIB * params.ctxSize / 16384);
    const deviceBytes = entry.size + kvBytes + computeBytes + 256 * MIB;
    const needLoadPeak = deviceBytes + entry.size + GIB + 256 * MIB;
    check([kvBytes, computeBytes, deviceBytes, needLoadPeak].every(integer), 'Unsafe APU refusal estimate');
    const reserve = Math.ceil(Math.min(16 * GIB, Math.max(1.5 * GIB, 0.25 * pin.host.memTotalBytes)));
    const floor = Math.ceil(Math.min(8 * GIB, Math.max(512 * MIB, 0.1 * pin.host.memTotalBytes)));
    const checks = [[needLoadPeak > pin.host.memTotalBytes - reserve, 'incompatible', 'C1'],
        [deviceBytes > 0.9 * pin.devices.totalBytes, 'incompatible', 'C2'],
        [needLoadPeak > pin.host.availableBytes - floor, 'insufficient-now', 'C1'],
        [deviceBytes > pin.devices.freeBytes - 512 * MIB, 'insufficient-now', 'C2']];
    const match = checks.find(row => row[0]);
    return { status: match?.[1] || 'ok', constraint: match?.[2] || null, deviceBytes, needLoadPeak };
}

export function deriveRefusal(catalog, pin) {
    check(Array.isArray(catalog) && catalog.length > 0 && catalog.length <= 512, 'APU refusal catalog unavailable');
    const entries = catalog.map(model => {
        keys(model, ['id', 'size', 'kvBytesPerToken', 'fixedKvBytes'], 'APU refusal catalog entry');
        check(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(model.id) && integer(model.size) && model.size > 0
            && integer(model.kvBytesPerToken) && model.kvBytesPerToken > 0 && integer(model.fixedKvBytes), 'Invalid APU refusal sizing');
        return { ...model };
    }).sort((a, b) => a.size - b.size || a.id.localeCompare(b.id));
    check(new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate refusal catalog entry');
    let selected = null;
    for (const entry of entries) {
        const options = [];
        for (let parallel = 1; parallel <= 4; parallel += 1) {
            if (apuAdmission(entry, { ctxSize: 131072, parallel }, pin).status === 'ok') continue;
            let low = 512; let high = 131072;
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                if (apuAdmission(entry, { ctxSize: middle, parallel }, pin).status === 'ok') low = middle + 1;
                else high = middle;
            }
            const params = { ctxSize: low, parallel };
            options.push({ modelId: entry.id, runnerId: 'llama.cpp-vulkan', params, ...apuAdmission(entry, params, pin) });
        }
        options.sort((a, b) => a.params.ctxSize - b.params.ctxSize || a.params.parallel - b.params.parallel);
        if (options.length) { selected = options[0]; break; }
    }
    return { schema: 1, method: 'catalog-c1-c2/v1', order: 'weight-size,model-id,context,parallel', catalog: entries,
        outcome: selected ? 'refusable' : 'not-exercised', selected };
}

export function validateRefusal(refusal, pin) {
    check(refusal && jsonDigest(refusal) === jsonDigest(deriveRefusal(refusal.catalog, pin)), 'APU refusal derivation differs from pinned inputs');
    return refusal;
}

export function prepareApuModel(model, catalog) {
    if (!isApuModel(model)) return model;
    validateApuPins(model);
    const value = structuredClone(model);
    if (value.profile === 'amd-apu-pressure') value.guardFloorBytes = pressureFloor(value.amd.host.memTotalBytes);
    value.envDelivery = 'manifest-default'; value.env = apuEnvironment(value);
    if (value.profile === 'amd-apu') value.refusal = deriveRefusal(catalog.models.filter(entry => entry.sources?.gguf
        && (!entry.profiles || entry.profiles.includes('cpu'))).map(entry => ({ id: entry.id, size: entry.sources.gguf.size,
        kvBytesPerToken: entry.memory?.kvBytesPerToken ?? 65536, fixedKvBytes: entry.memory?.fixedKvBytes || 0 })), value.amd);
    validateApuPins(value, { prepared: true });
    return value;
}
