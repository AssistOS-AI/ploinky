import { AsyncLocalStorage } from 'node:async_hooks';

const observers = new AsyncLocalStorage();

export function selectionIdentity(selector) {
    if (selector === null || selector === undefined) return null;
    if (!['active', 'inactive'].includes(selector.state)) throw new Error('Invalid edge selection state.');
    const value = { state: selector.state };
    for (const key of ['generation', 'previousGeneration', 'activationId', 'selectorDigest']) {
        const text = selector[key] ?? null;
        if (text !== null && (typeof text !== 'string' || Buffer.byteLength(text) > 512)) throw new Error('Invalid edge selection identity.');
        value[key] = text;
    }
    return Object.freeze(value);
}

// This scope belongs to a core lifecycle operation, never a request-body
// field. Only writes executed inside its async context produce receipts.
export function withEdgeSelectionObserver(observer, callback) {
    if (typeof observer !== 'function' || typeof callback !== 'function') throw new TypeError('An edge selection observer and callback are required.');
    return observers.run(observer, callback);
}

export function recordOwnedEdgeSelection({ selectorFile, before, after }) {
    const observer = observers.getStore();
    if (observer) observer({ selectorFile, before: selectionIdentity(before), after: selectionIdentity(after) });
}
