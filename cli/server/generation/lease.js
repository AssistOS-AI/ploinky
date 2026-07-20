export class GenerationLease {
    constructor(store, generation) {
        this.store = store;
        this.generation = generation;
        this.digest = generation.digest;
        this.committed = false;
        this.released = false;
        this.invalidated = false;
    }

    commit() {
        if (this.released || this.invalidated || this.committed) return false;
        if (this.store.active !== this.generation) {
            this.invalidated = true;
            return false;
        }
        this.committed = true;
        return true;
    }

    invalidate() {
        if (!this.committed && !this.released) this.invalidated = true;
    }

    release() {
        if (this.released) return;
        this.released = true;
        this.store?._release?.(this);
    }
}

export default GenerationLease;
