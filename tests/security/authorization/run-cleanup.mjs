/**
 * Exit paths of the live run, separated from run.mjs so they are testable offline.
 *
 * Owned cleanups run in reverse order, each behind the ownership guard. A failing
 * guard skips that cleanup (it must not act on an unproven deployment), so no cleanup
 * may be the only thing that closes a network resource: every stream the run opened is
 * also closed unconditionally from the registry in webchat-probes.mjs, whatever the
 * cleanups did. The run can always terminate: a second interruption exits at once, and
 * after the report is written an unreferenced timer ends the process if a handle is
 * still alive.
 */
import { closeAllOpenStreams } from './webchat-probes.mjs';
import { safeError } from './core.mjs';

export async function runOwnedCleanup(ctx, cleanups, { closeStreams = closeAllOpenStreams } = {}) {
    ctx.cleaning = true;
    try {
        for (let index = cleanups.length - 1; index >= 0; index--) {
            try { await ctx.guard(); await cleanups[index](); ctx.report.cleanup.push({ index, status: 'PASS' }); }
            catch (error) { ctx.report.cleanup.push({ index, status: 'FAIL', error: safeError(error, ctx.secrets) }); }
        }
        for (const finalize of ctx.finalizers || []) {
            try { await finalize(); } catch (error) { ctx.report.cleanup.push({ status: 'FAIL', error: safeError(error, ctx.secrets) }); }
        }
    } finally {
        closeStreams();
    }
}

/** First signal: finish the current request and clean up. Second signal: close streams and exit at once. */
export function installInterruptHandlers(ctx, { signals = ['SIGINT', 'SIGTERM'], on = (signal, handler) => process.on(signal, handler), closeStreams = closeAllOpenStreams, exit = code => process.exit(code), log = message => console.log(message) } = {}) {
    let received = 0;
    for (const signal of signals) {
        on(signal, () => {
            received++;
            ctx.report.interrupted = signal;
            if (received === 1) { log('Interruption requested; finishing current bounded request and cleaning owned fixtures. Send it again to exit immediately.'); return; }
            closeStreams();
            log('Second interruption: exiting without completing cleanup; owned fixtures may remain.');
            exit(130);
        });
    }
}

/** Ends the process even if an unclosed handle keeps the event loop alive; the timer itself never keeps it alive. */
export function armExitDeadline(codeOf, { ms = 10000, exit = code => process.exit(code), schedule = setTimeout } = {}) {
    const timer = schedule(() => exit(codeOf()), ms);
    timer.unref?.();
    return timer;
}
