import crypto from 'node:crypto';

// The sealed edge selector (`.ploinky/data/edge-routing/active.json`) as a
// pure value: its parser and identity helpers. The in-Box edge generation and
// the host activation recovery read the same file, so both use this module.
// It imports only Node built-ins: the host loads it without the in-Box CLI.

export const EDGE_SELECTOR_SCHEMA_VERSION = 1;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function selectorBodyDigest(body) {
    return `sha256:${crypto.createHash('sha256').update(Buffer.from(JSON.stringify(stableValue(body)))).digest('hex')}`;
}

/** Seal a selector body with its digest, exactly as the edge generation does. */
export function sealEdgeSelector(body) {
    return { ...body, selectorDigest: selectorBodyDigest(body) };
}

/**
 * Validate a parsed selector document. Returns the selector, or null for
 * anything that is not one sealed selector of this schema.
 */
export function validateSealedEdgeSelector(selector) {
    if (!isPlainObject(selector) || selector.schemaVersion !== EDGE_SELECTOR_SCHEMA_VERSION) return null;
    if (!['active', 'inactive'].includes(selector.state)) return null;
    const allowed = selector.state === 'active'
        ? new Set([
            'schemaVersion',
            'state',
            'generation',
            'publicationState',
            'activationId',
            'activatedAt',
            'selectorDigest',
        ])
        : new Set([
            'schemaVersion',
            'state',
            'generation',
            'previousGeneration',
            'reason',
            'activationId',
            'changedAt',
            'selectorDigest',
        ]);
    if (Object.keys(selector).some((key) => !allowed.has(key))) return null;
    if (selector.state === 'active' && !DIGEST_PATTERN.test(String(selector.generation || ''))) return null;
    if (selector.state === 'inactive'
        && ((selector.generation !== undefined
            && !DIGEST_PATTERN.test(String(selector.generation || '')))
            || (selector.previousGeneration
                && !DIGEST_PATTERN.test(String(selector.previousGeneration))))) return null;
    const { selectorDigest, ...body } = selector;
    if (selectorDigest !== selectorBodyDigest(body)) return null;
    return selector;
}

/** Parse selector text; null when it is not one valid sealed selector. */
export function parseSealedEdgeSelector(text) {
    try {
        return validateSealedEdgeSelector(JSON.parse(text));
    } catch (_) {
        return null;
    }
}

/** The four fields that identify one selector publication, or null. */
export function selectorIdentity(selector) {
    if (!isPlainObject(selector) || !['active', 'inactive'].includes(selector.state)) return null;
    return Object.freeze({
        state: selector.state,
        generation: selector.generation ?? null,
        activationId: String(selector.activationId ?? ''),
        selectorDigest: String(selector.selectorDigest ?? ''),
    });
}

/** Whether two selectors (or identities) name the same publication. */
export function sameSelectorIdentity(left, right) {
    const a = selectorIdentity(left);
    const b = selectorIdentity(right);
    return Boolean(a && b && a.state === b.state && a.generation === b.generation
        && a.activationId === b.activationId && a.selectorDigest === b.selectorDigest);
}
