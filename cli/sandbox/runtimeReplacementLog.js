// One diagnostic line for every start or restart path that replaces an
// existing runtime, so an operator can see WHY a runtime was recreated.
//
//   [start] <agent>: replacing its runtime (<reason>)
//
// The reason is a code plus, for hash mismatches, the first 12 characters of
// the old and new value. Hashes are one-way digests; environment values,
// secrets and full hashes are never printed.

import { hardwareLimitsHashOf } from './runtimeCapabilities.js';

const SHORT_HASH_LENGTH = 12;

export function shortHash(value) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, SHORT_HASH_LENGTH) : 'none';
}

// "<label> <old12> -> <new12>" for a hash that differs from the runtime's.
export function hashMismatchDetail(label, observed, desired) {
    return `${label} ${shortHash(observed)} -> ${shortHash(desired)}`;
}

// The limits-hash detail: the runtime's label against the admitted descriptor.
export function limitsHashDetail(descriptor, observedLabel) {
    return hashMismatchDetail('limitsHash', observedLabel, hardwareLimitsHashOf(descriptor));
}

// Any run of more than 12 hex digits (a full digest) shortens to 12.
export function shortenHashes(text) {
    return String(text ?? '').replace(/[0-9a-f]{13,}/gi, (match) => match.slice(0, SHORT_HASH_LENGTH));
}

function oneLine(text) {
    return String(text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

// The reason text: the code, then its detail when there is one.
export function formatReplacementReason(code, detail = '') {
    const base = oneLine(code) || 'unknown';
    const extra = oneLine(detail);
    return extra ? `${base}: ${extra}` : base;
}

export function formatRuntimeReplacementLine(agent, reasonText) {
    return `[start] ${oneLine(agent)}: replacing its runtime (${oneLine(reasonText) || 'unknown'})`;
}

export function logRuntimeReplacement(agent, reasonText, log = console.log) {
    log(formatRuntimeReplacementLine(agent, reasonText));
}
