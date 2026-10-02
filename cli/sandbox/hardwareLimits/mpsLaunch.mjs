import { isDeepStrictEqual } from 'node:util';
import { MpsError } from './mpsEligibility.mjs';
import { createMpsDaemonBackend, createMpsStateStore, mpsClientArgs } from './mps.mjs';

const launches = new WeakMap();
export function createMpsLaunch({ key, share = null, state = null, imageId = null }) {
    if (typeof key !== 'string' || !key) throw new MpsError('MPS launch requires an exact key');
    if (share && !/^(?:sha256:)?[a-f0-9]{64}$/.test(String(imageId))) throw new MpsError('MPS launch requires an immutable image identity');
    const freeze = (value) => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
    const captured = freeze(structuredClone({ key, share, state, imageId }));
    const capability = Object.freeze({});
    launches.set(capability, captured);
    return capability;
}
export function hasMpsLaunch(capability) { return Boolean(capability && launches.has(capability)); }
export function readMpsLaunch(capability, key, share) {
    const launch = capability && launches.get(capability);
    if (!launch || launch.key !== key || !isDeepStrictEqual(launch.share, share || null)) throw new MpsError('MPS launch identity or desired share changed');
    return launch;
}
export function verifyMpsLaunch(capability, key, share, { store = createMpsStateStore(), backend = createMpsDaemonBackend() } = {}) {
    const launch = readMpsLaunch(capability, key, share);
    if (!share) return launch;
    const current = store.read();
    if (!current || current.daemonGeneration !== launch.state?.daemonGeneration || current.configurationGeneration !== launch.state?.configurationGeneration
        || current.pipeDirectory !== launch.state?.pipeDirectory || !isDeepStrictEqual(current.serverDefault, launch.state?.serverDefault)
        || current.serverDefault?.smPercent < share.smPercent || current.serverDefault?.memoryMiB < share.memoryMiB
        || current.serverDefault?.deviceUuid !== share.deviceUuid || current.serverDefault?.driverVersion !== share.driverVersion || current.serverDefault?.wiringFingerprint !== share.wiringFingerprint || !backend.verify(current)) throw new MpsError('MPS daemon generation or defaults changed before runtime admission');
    return launch;
}
export function mpsLaunchArgs(capability, key, share) {
    const launch = verifyMpsLaunch(capability, key, share);
    return share ? mpsClientArgs(share, launch.state) : [];
}

export function readMpsLaunchForTracking(capability, key) {
    const launch = capability && launches.get(capability);
    if (!launch || launch.key !== key) throw new MpsError('MPS readiness launch identity changed');
    return launch;
}
