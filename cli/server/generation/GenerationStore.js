import { GenerationLease } from './lease.js';

export class GenerationStore {
    constructor() {
        this.active = null;
        this.leases = new Set();
    }

    activate(generation) {
        if (!generation?.active || !Object.isFrozen(generation)) {
            throw new Error('GenerationStore: compiled immutable generation required');
        }
        if (this.active?.digest === generation.digest) return this.active;
        const previous = this.active;
        this.active = generation;
        for (const lease of this.leases) {
            if (lease.generation === previous) lease.invalidate();
        }
        return generation;
    }

    deactivate() {
        const previous = this.active;
        this.active = null;
        for (const lease of this.leases) {
            if (lease.generation === previous) lease.invalidate();
        }
    }

    acquire({ listenerClass, authority } = {}) {
        const generation = this.active;
        if (!generation) throw new Error('GenerationStore: no active generation');
        const surface = generation.surfaces?.[listenerClass];
        if (!surface || surface.authority !== String(authority || '').trim().toLowerCase()) {
            throw new Error('GenerationStore: inactive listener authority');
        }
        const lease = new GenerationLease(this, generation);
        this.leases.add(lease);
        return lease;
    }

    _release(lease) {
        this.leases.delete(lease);
    }
}

export default GenerationStore;
