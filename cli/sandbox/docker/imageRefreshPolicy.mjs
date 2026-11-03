import { resolveSecretAlias } from '../../utils/security/secretAlias.mjs';

export const IMAGE_REFRESH_VAR = 'PLOINKY_IMAGE_REFRESH';

/**
 * The refresh policy of a raw variable value. `off` turns image refresh off; `on` and empty are the
 * default; any other value is ignored and reported.
 */
export function imageRefreshPolicyOf(raw) {
    const value = String(raw ?? '').trim();
    if (value === 'off') return { policy: 'off', ignoredValue: '' };
    return { policy: 'refresh', ignoredValue: value === 'on' ? '' : value };
}

/** The policy held by a decrypted workspace variable map (aliases followed). */
export function imageRefreshPolicyFromSecrets(secrets) {
    const raw = secrets?.[IMAGE_REFRESH_VAR];
    return imageRefreshPolicyOf(raw === undefined ? '' : resolveSecretAlias(raw, secrets));
}
