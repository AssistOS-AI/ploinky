import path from 'node:path';

import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';
import { BOX_TMPFS } from '../../../ploinky-box/constants.mjs';
import { PLOINKY_DIR } from '../config.js';

// The Box contract mounts /tmp as a fresh tmpfs for every outer boot. Runtime
// relay sockets and in-flight health-probe requests belong to that boot: a
// nested process cannot survive the Box stopping, and neither may its Unix
// socket inode. Keeping this control plane off the macOS workspace bind also
// avoids carrying an unaddressable virtiofs socket projection into the next
// Box kernel lifetime.
export const BOX_HEALTH_PROBE_CONTROL_HOST_ROOT = path.posix.join(
    BOX_TMPFS.destination,
    'ploinky-health-probes',
);

export function resolveHealthProbeControlHostRoot({
    insideBox = isInsideBox(),
    ploinkyDir = PLOINKY_DIR,
} = {}) {
    if (typeof insideBox !== 'boolean') {
        throw new TypeError('health-probe control root requires an exact Box-runtime decision');
    }
    return insideBox
        ? BOX_HEALTH_PROBE_CONTROL_HOST_ROOT
        : path.join(path.resolve(ploinkyDir), 'run', 'health-probes');
}

export const HEALTH_PROBE_CONTROL_HOST_ROOT = resolveHealthProbeControlHostRoot();
