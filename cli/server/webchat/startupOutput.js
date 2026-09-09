// Each pipe has its own ordered boundary. The private readiness FD still owns readiness.
export const CLI_OUTPUT_BOUNDARY = '\u001eploinky-cli-output-start\u001f\n';

export function createStartupOutputFilter(emit) {
    let pending = '';
    let started = false;
    return (chunk) => {
        if (started) return emit(chunk);
        pending += chunk;
        const index = pending.indexOf(CLI_OUTPUT_BOUNDARY);
        if (index < 0) {
            pending = pending.slice(-(CLI_OUTPUT_BOUNDARY.length - 1));
            return;
        }
        started = true;
        const output = pending.slice(index + CLI_OUTPUT_BOUNDARY.length);
        pending = '';
        if (output) emit(output);
    };
}
