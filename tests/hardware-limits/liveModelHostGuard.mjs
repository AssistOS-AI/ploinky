// Read-only Apple host observations. Machine lifecycle belongs to the caller's
// setup/restoration envelope, never to this suite.
import { checkedJson, observeEngineIdentity } from './liveCommon.mjs';

export const MODEL_HOST_LIMITS = Object.freeze({ memoryLevel: 20, pressure: 2, swapGrowthMiB: 1024, krunkitRssMiB: 9216 });

export function assertModelHostSample(sample, baseline = sample) {
    for (const key of ['memoryLevel', 'pressure', 'swapMiB', 'krunkitRssMiB']) {
        if (!Number.isFinite(sample?.[key]) || sample[key] < 0) throw new Error(`Apple host sample unreadable: ${key}`);
    }
    if (!Number.isFinite(baseline?.swapMiB)) throw new Error('Apple host swap baseline unreadable');
    if (sample.memoryLevel < MODEL_HOST_LIMITS.memoryLevel || sample.pressure >= MODEL_HOST_LIMITS.pressure
        || sample.swapMiB - baseline.swapMiB > MODEL_HOST_LIMITS.swapGrowthMiB || sample.krunkitRssMiB > MODEL_HOST_LIMITS.krunkitRssMiB) {
        throw new Error('Apple host guard threshold breached');
    }
    return sample;
}

export function parseModelHostSample({ memoryLevel, pressure, swap, processes }) {
    const number = text => /^\d+(?:\.\d+)?$/.test(String(text).trim()) ? Number(String(text).trim()) : NaN;
    const used = /\bused\s*=\s*([\d.]+)M\b/.exec(swap);
    const rows = String(processes).trim().split('\n').filter(Boolean).map(line => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line));
    if (rows.some(row => !row)) throw new Error('Apple process sample unreadable');
    const krun = rows.filter(row => /(?:^|\/)krunkit$/.test(row[3]));
    if (krun.length !== 1) throw new Error('Apple krunkit sample ambiguous');
    return { memoryLevel: number(memoryLevel), pressure: number(pressure), swapMiB: used ? Number(used[1]) : NaN, krunkitRssMiB: Number(krun[0][2]) / 1024 };
}

export async function observeAppleMachine({ profile, engine }) {
    const pin = profile.model.apple;
    if (await observeEngineIdentity((kind, args) => engine(kind, args, { journal: false })) !== profile.engine.identityDigest) throw new Error('Selected Apple engine identity changed');
    const machines = checkedJson(await engine('model-machine-list', ['machine', 'list', '--format', 'json'], { journal: false }));
    const machine = Array.isArray(machines) ? machines.filter(row => row.Name === pin.machine) : [];
    const inspect = checkedJson(await engine('model-machine-inspect', ['machine', 'inspect', pin.machine], { journal: false }));
    const connections = checkedJson(await engine('model-machine-connection', ['system', 'connection', 'list', '--format', 'json'], { journal: false }));
    const selected = Array.isArray(connections) ? connections.filter(row => row.Default === true) : [];
    if (machine.length !== 1 || machine[0].VMType !== 'libkrun' || machine[0].Running !== true
        || !Array.isArray(inspect) || inspect.length !== 1 || inspect[0].Name !== pin.machine
        || inspect[0].State !== 'running' || inspect[0].Rootful !== false
        || selected.length !== 1 || selected[0].Name !== pin.connection || selected[0].URI !== pin.uri) {
        throw new Error('Selected Apple machine/provider/connection changed');
    }
    return { machine: pin.machine, provider: 'libkrun', rootful: false, connection: pin.connection, uri: pin.uri };
}

export function createModelHostGuard({ sample, write = () => {}, intervalMs = 2000 }) {
    let baseline;
    const history = [];
    async function check() {
        let value;
        try { value = await sample(); }
        catch (error) {
            write({ schema: 1, thresholds: MODEL_HOST_LIMITS, samples: history, unreadable: String(error?.message || error).slice(0, 200) });
            throw error;
        }
        history.push({ at: Date.now(), ...value });
        if (history.length > 1800) throw new Error('Apple host observation bound exceeded');
        write({ schema: 1, thresholds: MODEL_HOST_LIMITS, samples: history });
        assertModelHostSample(value, baseline || value);
        baseline ||= value;
    }
    async function monitor(work) {
        await check();
        const controller = new AbortController();
        let stopped = false; let failure = null; let timer; let wake;
        const watcher = (async () => {
            while (!stopped) {
                await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, intervalMs); });
                if (stopped) break;
                try { await check(); } catch (error) { failure = error; controller.abort(error); break; }
            }
        })();
        try {
            const result = await work(controller.signal);
            if (failure) throw failure;
            await check();
            return result;
        } finally {
            stopped = true; clearTimeout(timer); wake?.(); await watcher;
            if (failure) throw failure;
        }
    }
    return { check, monitor };
}
