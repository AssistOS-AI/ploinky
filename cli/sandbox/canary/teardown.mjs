// Ending a canary (plan 3.7). Interface fixed for the parallel slices: S5
// implements it; `canary abort` (S2) and every workspace lifecycle command
// (S5) call it.
//
// endCanary({ routeKey, reason, workspaceRoot }) -> Promise<{ ended: boolean, outcome: string }>
//   Safe order: publish mode 'withdrawn' (pair kept), stop and remove the exact
//   canary container by its recorded id, verify it no longer exists (running
//   or stopped), publish one removal of both the route field and the record,
//   delete the export and the rollout's task queue file, close the receipt.
//   Idempotent: re-running after any interruption completes the cleanup.
//
// reconcileCanaries({ reason, workspaceRoot }) -> Promise<Array<{ routeKey, outcome }>>
//   Called first by stop, restart, shutdown, destroy, clean, update, disable
//   and start (cold start). Ends every canary of the workspace per plan 3.7.
export async function endCanary() {
    throw Object.assign(new Error('endCanary is not implemented yet (slice S5)'), { code: 'CANARY_TEARDOWN_UNIMPLEMENTED' });
}
export async function reconcileCanaries() {
    throw Object.assign(new Error('reconcileCanaries is not implemented yet (slice S5)'), { code: 'CANARY_TEARDOWN_UNIMPLEMENTED' });
}
