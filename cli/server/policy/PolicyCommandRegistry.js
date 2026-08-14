/**
 * PolicyCommandRegistry — maps a command name to its `PolicyCommand`
 * instance (DS015). Adding a command is `register(new XCommand(...))`; the
 * invoker never changes (open/closed).
 */
export class PolicyCommandRegistry {
    constructor() {
        this._commands = new Map();
    }

    register(command) {
        this._commands.set(command.name, command);
        return this;
    }

    get(name) {
        return this._commands.get(String(name || '')) || null;
    }
}

export default PolicyCommandRegistry;
