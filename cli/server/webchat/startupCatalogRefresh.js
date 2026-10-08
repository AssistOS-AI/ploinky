// The slash-command catalog is keyed by session id, and each load runs a full
// catalog tool. At page load the session id is not known yet, so loading the
// catalog immediately would be discarded when the session arrives moments
// later. The first load therefore waits for the session; if none is announced
// within `delayMs` (a page with no session) it runs once without one.
export const STARTUP_CATALOG_SESSION_WAIT_MS = 1500;

export function createStartupCatalogRefresh({
    refresh,
    getSessionId = () => '',
    delayMs = STARTUP_CATALOG_SESSION_WAIT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
} = {}) {
    let timer = null;

    function cancel() {
        if (timer === null) return;
        clearTimer(timer);
        timer = null;
    }

    function schedule() {
        cancel();
        if (getSessionId()) {
            return refresh();
        }
        timer = setTimer(() => {
            timer = null;
            refresh();
        }, delayMs);
        return null;
    }

    return { schedule, cancel };
}
