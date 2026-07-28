import fs from 'node:fs';

import {
    BOX_MARKER_CONTENT,
    BOX_MARKER_PATH,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';

function markerError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_MARKER_INVALID',
        cause,
    });
}

export function isInsideBox({
    fsApi = fs,
    markerPath = BOX_MARKER_PATH,
} = {}) {
    let stat;
    try {
        stat = fsApi.lstatSync(markerPath);
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw markerError(`Unable to inspect the Ploinky Box marker ${markerPath}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw markerError(`Ploinky Box marker is not a single regular file: ${markerPath}`);
    }
    let bytes;
    try {
        bytes = fsApi.readFileSync(markerPath);
    } catch (error) {
        throw markerError(`Unable to read the Ploinky Box marker ${markerPath}`, error);
    }
    if (!bytes.equals(Buffer.from(BOX_MARKER_CONTENT))) {
        throw markerError(
            'Ploinky Box marker has invalid content; destroy and recreate the Box',
        );
    }
    return true;
}
