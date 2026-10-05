// In-Box validation of the read-only hardware-limits wiring marker (plan §4).
// The marker binds instance, pathHash, canonical workspace root, host kind and
// the store identity; it is present only in a gate-on Box.

import fs from 'node:fs';

import { BOX_HARDWARE_MARKER_PATH } from '../constants.mjs';

const MARKER_KEYS = ['schema', 'instance', 'pathHash', 'workspaceRoot', 'hostKind', 'storeId', 'storeDirectory'];
const MAX_MARKER_BYTES = 4096;

export function readBoxHardwareMarker({ markerPath = BOX_HARDWARE_MARKER_PATH, fsApi = fs } = {}) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(markerPath, fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK);
    } catch (error) {
        if (error?.code === 'ENOENT') return Object.freeze({ present: false, valid: false, marker: null, problem: null });
        return Object.freeze({ present: true, valid: false, marker: null, problem: `the hardware marker is not readable (${error?.code || 'error'})` });
    }
    try {
        const stat = fsApi.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) {
            return Object.freeze({ present: true, valid: false, marker: null, problem: 'the hardware marker is not a bounded regular file' });
        }
        const marker = JSON.parse(String(fsApi.readFileSync(descriptor, 'utf8')));
        if (!marker || typeof marker !== 'object' || Array.isArray(marker)
            || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify([...MARKER_KEYS].sort())
            || marker.schema !== 1
            || !/^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/.test(String(marker.instance))
            || !/^[a-f0-9]{12}$/.test(String(marker.pathHash))
            || !/^[0-9a-f]{32}$/.test(String(marker.storeId))
            || typeof marker.workspaceRoot !== 'string' || !marker.workspaceRoot.startsWith('/')) {
            return Object.freeze({ present: true, valid: false, marker: null, problem: 'the hardware marker has an unexpected shape' });
        }
        return Object.freeze({ present: true, valid: true, marker: Object.freeze({ ...marker }), problem: null });
    } catch (_) {
        return Object.freeze({ present: true, valid: false, marker: null, problem: 'the hardware marker is not valid JSON' });
    } finally {
        fsApi.closeSync(descriptor);
    }
}
