import os from 'node:os';

export function shouldAllocateInteractiveTty({
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
} = {}) {
    return env?.PLOINKY_NO_TTY !== '1'
        && stdin?.isTTY === true
        && stdout?.isTTY === true;
}

export function resolveInteractiveSpawnResult(result, {
    label = 'interactive process',
} = {}) {
    if (!result || typeof result !== 'object') {
        throw new Error(`${label} returned no process result`);
    }
    if (result.error) {
        throw new Error(
            `${label} failed to start: ${result.error.message || result.error}`,
            { cause: result.error },
        );
    }
    if (Number.isInteger(result.status)) return result.status;
    if (result.signal) {
        const signalNumber = os.constants.signals[result.signal];
        if (!Number.isInteger(signalNumber)) {
            throw new Error(`${label} terminated by unknown signal '${result.signal}'`);
        }
        return 128 + signalNumber;
    }
    throw new Error(`${label} ended without an exit status or signal`);
}
