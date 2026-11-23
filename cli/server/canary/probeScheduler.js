// One exact-container inspection in flight per rollout. At a missed deadline,
// ignore its eventual result and ask it to cancel. Even an uncooperative probe
// cannot accumulate concurrent inspections or hide successive missed probes.
export function scheduleProbes({ target, probe, observe, intervalMs = 30_000,
    setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
    let active = true;
    let pending;
    const timer = setIntervalFn(async () => {
        if (!active) return;
        if (pending) {
            pending.abort();
            observe({ ok: false });
            return;
        }
        const controller = new AbortController();
        pending = controller;
        try {
            const result = await probe(target, { signal: controller.signal });
            if (active && !controller.signal.aborted) observe(result);
        } catch {
            if (active && !controller.signal.aborted) observe({ ok: false });
        } finally {
            pending = undefined;
        }
    }, intervalMs);
    timer.unref?.();
    return () => {
        active = false;
        clearIntervalFn(timer);
        pending?.abort();
    };
}
