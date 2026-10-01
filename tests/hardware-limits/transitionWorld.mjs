// Test-only simulated engine and downgrade effects for the §6.4 fault matrix.
//
// The engine state, host records and graph result are plain data that can be
// written to a file. A recovery runs in a FRESH node process (this module
// executed directly): it reloads only that durable state plus the on-disk
// journal, barrier and store, builds new effects, runs the recovery and
// writes the state back. Nothing from the interrupted process's closures,
// objects or module instance reaches it.
//
//   node transitionWorld.mjs recover STATE.json

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    createTransitionStore,
    digestOf,
    recoverHardwareDowngrades,
} from '../../ploinky-box/hardwareLimitsTransition.mjs';

export class Engine {
    constructor() {
        this.boxes = new Map();
        this.creates = 0;
        this.prepares = new Map();
        this.removedByName = 0;
    }

    add(config, { running = true, graphRunning = true } = {}) {
        const id = crypto.randomBytes(32).toString('hex');
        this.boxes.set(id, { config: structuredClone(config), running, graphRunning });
        return id;
    }

    toJSON() {
        return {
            boxes: [...this.boxes],
            creates: this.creates,
            prepares: [...this.prepares],
            removedByName: this.removedByName,
        };
    }

    load(value) {
        this.boxes = new Map(value.boxes);
        this.creates = value.creates;
        this.prepares = new Map(value.prepares);
        this.removedByName = value.removedByName;
        return this;
    }
}

export function effectsFor(world) {
    const { engine } = world;
    return {
        engineIdentity: 'engine-1',
        hostKind: 'native-linux',
        inspectBox() {
            const [entry] = [...engine.boxes];
            return entry ? { id: entry[0], running: entry[1].running } : null;
        },
        stopGraph(id) { engine.boxes.get(id).graphRunning = false; },
        stopBox(id) {
            const box = engine.boxes.get(id);
            box.running = false;
            box.graphRunning = false;
        },
        removeBox(id) {
            if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('removal requires an exact ID');
            engine.boxes.delete(id);
        },
        createBox(config, { receiptPath }) {
            engine.creates += 1;
            const id = engine.add(config, { running: false, graphRunning: false });
            fs.writeFileSync(receiptPath, `${id}\n`, { mode: 0o600 });
            return id;
        },
        startBox(id) {
            engine.boxes.get(id).running = true;
            engine.prepares.set(id, 0);
        },
        prepareBox(id) { engine.prepares.set(id, (engine.prepares.get(id) || 0) + 1); },
        startGraph(id) {
            engine.boxes.get(id).graphRunning = true;
            return world.graphResult;
        },
        graphRunning(id) { return engine.boxes.get(id)?.graphRunning === true; },
        verifyBox(id, config) { return digestOf(engine.boxes.get(id)?.config) === digestOf(config); },
        readHostRecord(name) { return world.records.get(name); },
        writeHostRecord(name, value) { world.records.set(name, value); },
    };
}

export function worldState(world) {
    return {
        identity: world.identity,
        home: world.home,
        engine: world.engine.toJSON(),
        records: [...world.records],
        graphResult: world.graphResult,
    };
}

export function loadWorldState(world, state) {
    world.engine.load(state.engine);
    world.records = new Map(state.records);
    return world;
}

async function recoverFromFile(statePath) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const world = {
        identity: Object.freeze(state.identity),
        home: state.home,
        engine: new Engine().load(state.engine),
        records: new Map(state.records),
        graphResult: state.graphResult,
    };
    let results = null;
    let failure = null;
    try {
        results = await recoverHardwareDowngrades({
            identity: world.identity,
            homeDirectory: world.home,
            transitionStore: createTransitionStore({ identity: world.identity, homeDirectory: world.home }),
            effects: effectsFor(world),
        });
    } catch (error) {
        failure = { message: String(error?.message || error), code: error?.code || null };
    }
    fs.writeFileSync(statePath, JSON.stringify({ ...worldState(world), results, failure, pid: process.pid }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]) && process.argv[2] === 'recover') {
    await recoverFromFile(process.argv[3]);
}
