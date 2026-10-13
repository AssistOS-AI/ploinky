import { createLinuxHostGuard, linuxHostSampler } from './liveLinuxHostGuard.mjs';
import { createAmdGpuGate } from './liveAmdGpuGate.mjs';
import { blocked } from './liveCommon.mjs';

export async function createApuHostScope({ run, profile, processProvider, signal, write, persist = () => {}, provision = false, timings = {} }) {
    const sample = linuxHostSampler({ profile, processProvider, signal });
    const gpu = profile.model.profile !== 'amd-apu-cpu';
    const baseline = run.preInventory.apuHost;
    if (!provision && !baseline) throw blocked('APU provision host baseline unavailable');
    let gate;
    const host = createLinuxHostGuard({ sample: async () => {
        const value = await sample();
        if (gate) await gate.check({ idle: false });
        return value;
    }, baseline, write: value => write('linux-host-guard', { runId: run.runId, ...value }), ...timings.host });
    const initial = await host.check();
    if (provision) {
        run.preInventory.apuHost = initial;
        write('linux-host-guard-baseline', { runId: run.runId, ...host.snapshot() }); persist();
    }
    if (gpu) {
        gate = createAmdGpuGate({ sample: async () => {
            const value = await sample();
            // Baseline collection is itself guarded, before a workspace exists.
            const { assertLinuxHostSample } = await import('./liveLinuxHostGuard.mjs');
            assertLinuxHostSample(value, run.preInventory.apuHost);
            return value;
        }, baseline: provision ? null : run.preInventory.amdIdle, signal,
        write: value => write(provision ? 'amd-idle-gate-initial' : 'amd-idle-gate-final', { runId: run.runId, ...value }), ...timings.gate });
        if (!provision && !run.preInventory.amdIdle) throw blocked('AMD provision idle baseline unavailable');
        const idle = await gate.initial();
        if (provision) { run.preInventory.amdIdle = idle; persist(); }
    }
    return { host, gate, async final() {
        gate?.setCase(null);
        await host.check();
        if (gate) await gate.check({ idle: true, final: true });
    } };
}
