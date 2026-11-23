// The operator probe of one exact canary container (plan 3.3, 3.5).
// Interface fixed for the parallel slices: S2 implements it, the Router's
// probe scheduler (S3 wiring) and `canary start` (S2) call it.
//
// probeCanaryContainer({ runtime, containerId, containerName, port, path, status, timeoutMs })
//   -> Promise<{ ok: boolean, status: number|null, code?: string, detail?: string }>
// It targets the exact container by id (never through user routing) and
// resolves ok only when the HTTP status equals `status`.
export async function probeCanaryContainer() {
    throw Object.assign(new Error('probeCanaryContainer is not implemented yet (slice S2)'), { code: 'CANARY_PROBE_UNIMPLEMENTED' });
}
