// Commands that were removed keep a tombstone so old muscle memory gets a
// useful, side-effect-free answer instead of an unknown-command error.
export const RETIRED_DEPS_MESSAGE = 'Dependency caches are managed automatically. '
    + 'Use `ploinky reinstall <agent>` to rebuild the selected agent.';

export const RETIRED_COMMANDS = Object.freeze({ deps: RETIRED_DEPS_MESSAGE });

export function retiredCommandMessage(command) {
    return Object.hasOwn(RETIRED_COMMANDS, command) ? RETIRED_COMMANDS[command] : null;
}

export function retiredCommandError(command) {
    const message = retiredCommandMessage(command);
    if (!message) return null;
    return Object.assign(new Error(message), { code: 'PLOINKY_COMMAND_RETIRED', exitCode: 1 });
}
