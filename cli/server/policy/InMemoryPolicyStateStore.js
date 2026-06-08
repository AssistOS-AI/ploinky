import { PolicyStateStore } from './PolicyStateStore.js';

/**
 * InMemoryPolicyStateStore — a non-persistent `PolicyStateStore` adapter. It exists
 * to (a) prove the persistence seam (the repository's full contract is satisfiable
 * with zero filesystem access) and (b) serve as a minimal template for a future
 * database adapter: implement the same three methods over your backend.
 *
 * Documents are deep-copied in and out so a caller can never mutate stored state
 * through a returned reference. A `document` whose schema is invalid is stored as-is
 * — the repository's `validateState` is what rejects it, exercising the fail-closed
 * path without any filesystem corruption.
 */
function clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export class InMemoryPolicyStateStore extends PolicyStateStore {
    constructor({ document = null } = {}) {
        super();
        this._document = clone(document);
        this._version = this._document ? 1 : 0;
    }

    currentVersion() {
        return this._document ? String(this._version) : null;
    }

    read() {
        if (!this._document) return { found: false };
        return { found: true, document: clone(this._document) };
    }

    write(document) {
        this._document = clone(document);
        this._version += 1;
        return String(this._version);
    }
}

export default InMemoryPolicyStateStore;
