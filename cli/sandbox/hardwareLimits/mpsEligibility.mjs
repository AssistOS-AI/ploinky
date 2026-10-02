import { spawnSync } from 'node:child_process';
import { managedImageUserNamespace } from '../routerAuthorityAttestation.js';
import { revalidateMpsTools } from '../../../ploinky-box/lib/mpsTools.mjs';

export class MpsError extends Error {
    constructor(message, code = 'gpu_sharing_unavailable') { super(message); this.name = 'MpsError'; this.code = code; this.status = 409; }
}

export function classifyGpuMemoryModel(name) {
    const text = String(name || '').trim();
    if (/\b(?:GB10|GH200|GB200|Grace\s+(?:Hopper|Blackwell)|Jetson|Tegra|Orin)\b/i.test(text)) return 'unified';
    if (/\b(?:GeForce\s+(?:RTX\s+[2345]\d{3}|GTX\s+\d{3,4})|(?:NVIDIA\s+)?RTX\s+(?:[2345]\d{3}|[AB]?\d{3,4}|PRO\s+\d{3,4})|(?:Tesla\s+)?[AVHT]\d{2,3}|L[24]\d[S]?|Quadro\s+[RP]\d{3,4}|B[12]00)\b/i.test(text)) return 'dedicated';
    return 'unknown';
}

// Plan §9.3: the unified/unknown memory-model refusal reason and fix.
export function unsupportedGpuMemoryModelReason(name) {
    const text = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 256) || 'unknown';
    return `GPU sharing is unsupported on this unified or unverified GPU memory model: ${text}.`;
}
export const UNSUPPORTED_GPU_MEMORY_MODEL_FIX = 'Clear the GPU share. CPU/RAM controls remain separately available.';

export function parseMpsGpuObservation(text) {
    const lines = String(text || '').trim().split('\n');
    if (lines.length !== 1) throw new MpsError('GPU index 0 must have one exact observation');
    const fields = lines[0].split(',').map((value) => value.trim());
    if (fields.length !== 5 || fields[0] !== '0') throw new MpsError('GPU identity or dedicated memory is unknown');
    // Classify the model before memory.total: a unified GPU (GB10) may not
    // report dedicated memory at all, and must still refuse as unified.
    const memoryModel = classifyGpuMemoryModel(fields[2]);
    if (memoryModel !== 'dedicated') {
        const error = new MpsError(memoryModel === 'unified' ? 'Unified GPUs cannot use configured MPS shares' : 'The GPU memory model is unknown');
        error.memoryModel = memoryModel;
        error.gpuName = fields[2];
        throw error;
    }
    if (!/^GPU-[a-f0-9-]{36}$/i.test(fields[1]) || !/^[1-9]\d*$/.test(fields[3]) || !/^\d+(?:\.\d+)+$/.test(fields[4])) throw new MpsError('GPU identity or dedicated memory is unknown');
    const memoryMiB = Number(fields[3]);
    if (!Number.isSafeInteger(memoryMiB) || !Number.isSafeInteger(memoryMiB * 1048576)) throw new MpsError('GPU dedicated memory is out of range');
    return Object.freeze({ index: 0, uuid: fields[1], name: fields[2], memoryMiB, driverVersion: fields[4], memoryModel });
}

// The Box image has no loader path for the bound driver libraries (they sit under /usr/local/nvidia/lib64,
// which neither its loader cache nor its environment names), so the bound nvidia-smi cannot load
// libnvidia-ml.so.1 unless the caller names the directory, as every other consumer of those libraries does.
export const MPS_OBSERVATION_ENVIRONMENT = Object.freeze({ PATH: '/usr/local/nvidia/bin:/usr/bin:/bin', LD_LIBRARY_PATH: '/usr/local/nvidia/lib64' });

// What a failed observation looked like, bounded and secret-free: the exit state and the first words of stderr.
function observationFailure(result) {
    const parts = [];
    if (result.error) parts.push(`error ${String(result.error.code || result.error.message).slice(0, 40)}`);
    if (result.signal) parts.push(`signal ${String(result.signal).slice(0, 20)}`);
    if (Number.isInteger(result.status) && result.status !== 0) parts.push(`exit ${result.status}`);
    const stderr = String(result.stderr || '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 200);
    if (stderr) parts.push(`stderr: ${stderr}`);
    return parts.length ? ` (${parts.join(', ')})` : '';
}

export function observeMpsGpu({ query = spawnSync } = {}) {
    const result = query('/usr/local/nvidia/bin/nvidia-smi', ['-i', '0', '--query-gpu=index,uuid,name,memory.total,driver_version', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'], env: { ...MPS_OBSERVATION_ENVIRONMENT } });
    if (result.status !== 0 || result.signal || result.error || Buffer.byteLength(String(result.stdout || '')) > 8192) throw new MpsError(`GPU observation failed or timed out${observationFailure(result)}`);
    return parseMpsGpuObservation(result.stdout);
}

export function assertMpsImageEligibility({ imageId, imageUser, networkMode }) {
    if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(String(imageId))) throw new MpsError('MPS image identity is not immutable');
    const userNamespace = managedImageUserNamespace(imageUser);
    if (!userNamespace) throw new MpsError('MPS requires an exact nonroot numeric image UID:GID within Linux bounds');
    if (!['default', 'bridge', 'managed'].includes(String(networkMode))) throw new MpsError('MPS requires managed default or bridge networking');
    return Object.freeze({ imageId, imageUser, userNamespace });
}

export function prepareMpsImage({ image, networkMode }, { ensureImage, inspectImage }) {
    ensureImage(image);
    return inspectMpsImage({ image, networkMode }, { inspectImage });
}

export function inspectMpsImage({ image, networkMode }, { inspectImage }) {
    let inspected;
    try { inspected = inspectImage(image); } catch (_) { throw new MpsError('The selected image must be prepared on the host before saving a GPU share', 'image_preparation_required'); }
    const record = Array.isArray(inspected) ? inspected[0] : inspected;
    if (!record?.Id) throw new MpsError('The selected image must be prepared on the host before saving a GPU share', 'image_preparation_required');
    return assertMpsImageEligibility({ imageId: record?.Id, imageUser: record?.Config?.User, networkMode });
}

export function resolveMpsShare(policy, gpu, { grant, fsApi } = {}) {
    if (!grant?.valid || grant.state !== 'active' || !grant.mps) throw new MpsError(grant?.mpsProblem || 'Both host MPS tools and active GPU access are required');
    revalidateMpsTools(grant.mps, { ...(fsApi ? { fsApi } : {}), mounted: true });
    const { smPercent, vramPercent } = policy || {};
    if (![smPercent, vramPercent].every((value) => Number.isInteger(value) && value >= 1 && value <= 100)) throw new MpsError('GPU share percentages must be integers in 1..100');
    if (gpu?.memoryModel !== 'dedicated' || !Number.isSafeInteger(gpu.memoryMiB) || gpu.memoryMiB <= 0) throw new MpsError('Dedicated GPU memory cannot be resolved');
    const memoryMiB = Math.floor(vramPercent * gpu.memoryMiB / 100);
    if (memoryMiB < 512) throw new MpsError('The GPU memory share is below the 512 MiB minimum');
    return Object.freeze({ smPercent, vramPercent, vramMiB: memoryMiB, memoryMiB, memoryBytes: memoryMiB * 1048576, deviceUuid: gpu.uuid, driverVersion: gpu.driverVersion, wiringFingerprint: grant.fingerprint });
}
