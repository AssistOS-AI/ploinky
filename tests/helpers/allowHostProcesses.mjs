// Integration tests run the real quiescence gate, which refuses while a launch
// record of the test workspace names a running process. When such a process
// is known not to be that agent, `PLOINKY_TEST_ALLOW_HOST_PROCESSES` names it
// explicitly, as a comma-separated list of PIDs; the test forwards
// them exactly as `ploinky --allow-host-process PID` would (the supervisor's
// and host-state guard's `allowHostProcesses`), and the product re-verifies
// each process's start time as usual. Nothing is detected or defaulted: unset
// means no allowance, and a malformed value fails the test setup.

export const ALLOW_HOST_PROCESSES_ENV = 'PLOINKY_TEST_ALLOW_HOST_PROCESSES';

// The same PID form the CLI accepts for `--allow-host-process` (command/parse.mjs).
const PID_PATTERN = /^[1-9][0-9]{0,9}$/;

export function parseAllowHostProcesses(value) {
    if (value === undefined) return Object.freeze([]);
    const parts = typeof value === 'string' ? value.split(',') : [];
    if (!parts.length || parts.some((part) => !PID_PATTERN.test(part) || !Number.isSafeInteger(Number(part)))) {
        throw new Error(`${ALLOW_HOST_PROCESSES_ENV} must be a comma-separated list of positive process IDs `
            + `without spaces, for example 1234,5678; got ${JSON.stringify(value)}`);
    }
    return Object.freeze([...new Set(parts.map(Number))]);
}

export function allowHostProcessesFromEnv(env = process.env) {
    return parseAllowHostProcesses(env[ALLOW_HOST_PROCESSES_ENV]);
}

/** The CLI form: one `--allow-host-process PID` pair per process. */
export function allowHostProcessArgs(pids) {
    return pids.flatMap((pid) => ['--allow-host-process', String(pid)]);
}
