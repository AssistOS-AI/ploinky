// The PROD switch: a `ploinky var` held in the controller-only encrypted store
// (`.ploinky/data/.secrets`), which agents cannot write. The CLI reads the
// stored value for consistency checks and for the capture. The Router and the
// agents use only the value captured by a start or whole restart
// (`mcpProdGates.mjs`); a stored change therefore takes effect at the next
// start or whole restart and never at a Router-only restart or per call.
//
// This module is the CLI side. It never reads `.env` or `process.env`: both
// are writable by agents or by the caller's shell, and neither selects PROD.

import { readSecretsFile } from './security/encryptedSecretsFile.js';
import { getActiveProfile } from './runtime/profileService.js';

export const PROD_ENV = 'PROD';
export const PROD_PROFILE = 'prod';

export const PROD_INVALID_CODE = 'PLOINKY_PROD_INVALID';
export const PROD_PROFILE_MISMATCH_CODE = 'PLOINKY_PROD_PROFILE_MISMATCH';

function prodError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

// Never echo an attacker- or typo-sized value back to a terminal or a log.
function describeValue(value) {
    const text = typeof value === 'string' ? value : String(value);
    const shown = text.length > 24 ? `${text.slice(0, 24)}...` : text;
    return JSON.stringify(shown);
}

// Strict enum parse. An unset or empty value means "no selection" (undefined);
// anything but the exact lowercase literals `true` and `false` is refused, so a
// typo, a case variant or a padded value can never silently mean either state.
export function parseProd(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw prodError(
        PROD_INVALID_CODE,
        `${PROD_ENV} must be exactly 'true' or 'false', not ${describeValue(value)}.`,
    );
}

// The stored value. Absent means false. A stored invalid value and a store
// read error both throw: neither ever yields false.
export function readProd({ secrets } = {}) {
    const map = secrets ?? readSecretsFile({ readOnly: true });
    const raw = map && Object.hasOwn(map, PROD_ENV) ? map[PROD_ENV] : undefined;
    return parseProd(raw) ?? false;
}

// PROD true requires the workspace profile `prod`. `requestedProd` and
// `requestedProfile` describe the state a command is about to establish; the
// stored value is not read when `requestedProd` is given, so `var PROD
// true|false` can repair a legacy invalid stored value. Profile `prod` with
// PROD false is allowed.
export function assertProdProfileConsistency({
    workspaceProfile,
    requestedProfile,
    requestedProd,
} = {}) {
    const prod = requestedProd !== undefined ? parseProd(requestedProd) : readProd();
    if (!prod) return;
    const profile = String(
        requestedProfile ?? workspaceProfile ?? getActiveProfile(),
    ).trim().toLowerCase();
    if (profile !== PROD_PROFILE) {
        throw prodError(
            PROD_PROFILE_MISMATCH_CODE,
            `${PROD_ENV} is true, which requires the workspace profile '${PROD_PROFILE}' (got '${profile}'). `
            + `Run 'ploinky var ${PROD_ENV} false' first, or select the '${PROD_PROFILE}' profile.`,
        );
    }
}
