import { compileGeneration } from './compileGeneration.js';

export function activateGeneration(store, inputs) {
    let generation;
    try {
        generation = compileGeneration(inputs);
    } catch (error) {
        store.deactivate();
        throw error;
    }
    return store.activate(generation);
}

export default activateGeneration;
