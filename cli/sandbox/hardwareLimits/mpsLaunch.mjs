import { isDeepStrictEqual } from 'node:util';
import { MpsError } from './mpsEligibility.mjs';
import { createMpsDaemonBackend, createMpsStateStore, mpsClientArgs, sameMpsServerDefault, verifyDetail } from './mps.mjs';

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
    // The same checks, in the same order, each named: the decision is unchanged, the reason is kept.
    const problems = [];
    const expected = launch.state;
    if (!current) problems.push('the MPS state is gone');
    else {
        if (current.daemonGeneration !== expected?.daemonGeneration) problems.push('the daemon generation changed');
        else if (current.configurationGeneration !== expected?.configurationGeneration) problems.push('the configuration generation changed');
        else if (current.pipeDirectory !== expected?.pipeDirectory) problems.push('the private pipe directory changed');
        else if (!sameMpsServerDefault(current.serverDefault, expected?.serverDefault)) problems.push('the server defaults changed');
        else if (current.serverDefault?.smPercent < share.smPercent || current.serverDefault?.memoryMiB < share.memoryMiB) problems.push('the server defaults are below the share');
        else if (current.serverDefault?.deviceUuid !== share.deviceUuid || current.serverDefault?.driverVersion !== share.driverVersion || current.serverDefault?.wiringFingerprint !== share.wiringFingerprint) problems.push('the device, driver or wiring differs from the share');
        else { const verified = verifyDetail(backend, current); if (!verified.ok) problems.push(`the daemon no longer verifies${verified.reason ? `: ${verified.reason}` : ''}`); }
    }
    if (problems.length) throw new MpsError(`MPS daemon generation or defaults changed before runtime admission (${problems.join('; ')})`);
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
