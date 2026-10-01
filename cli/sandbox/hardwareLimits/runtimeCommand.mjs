// Engine command adapter for hardware-placed agents (plan §8.1). The nested
// cgroupfs manager is selected with an engine-level option placed before the
// Podman subcommand, as an argument array, never by concatenating an engine
// name. Gate-off, maintenance, outside-Box, helper-exempt and unlimited D4
// legacy invocations keep their existing command form (empty prefix).

export const CGROUPFS_ENGINE_PREFIX = Object.freeze(['--cgroup-manager=cgroupfs']);
export const PREFIXED_OPERATIONS = Object.freeze(['create', 'start', 'exec', 'run']);

export function assertEnginePrefix(prefix) {
    const value = Array.isArray(prefix) ? prefix : [];
    if (value.length === 0) return Object.freeze([]);
    if (value.length === 1 && value[0] === CGROUPFS_ENGINE_PREFIX[0]) return CGROUPFS_ENGINE_PREFIX;
    throw new Error(`unsupported engine command prefix: ${JSON.stringify(value)}`);
}

// [...prefix, subcommand, ...args] for the prefixed operations only.
export function engineCommandArgs(prefix, args) {
    const exact = assertEnginePrefix(prefix);
    if (!Array.isArray(args) || !args.length) throw new Error('engine command arguments are required');
    return exact.length && PREFIXED_OPERATIONS.includes(args[0]) ? [...exact, ...args] : [...args];
}

// Wrap a run(runtime, args, options) function so prefixed operations carry
// the engine option; every other command is passed through unchanged.
export function withEnginePrefix(run, prefix) {
    const exact = assertEnginePrefix(prefix);
    if (!exact.length) return run;
    return (runtime, args, options) => run(runtime, engineCommandArgs(exact, args), options);
}
