const rawCommands = {
    add: ['repo'],
    update: ['repo', 'repos', 'all'],
    reinstall: ['agent'],
    enable: ['repo', 'agent', 'sandbox'],
    disable: ['repo', 'agent', 'sandbox', 'agents-all'],
    sandbox: ['status', 'disable', 'enable'],
    shell: [],
    cli: [],
    start: [],
    restart: [],
    clean: [],
    status: [],
    shutdown: [],
    stop: [],
    destroy: [],
    list: ['agents', 'repos', 'routes'],
    '/settings': [],
    settings: [],
    client: ['methods', 'status', 'list', 'task', 'task-status'],
    logs: ['tail', 'last'],
    expose: [],
    var: [],
    vars: [],
    echo: [],
    help: [],
    profile: ['list', 'validate', 'show'],
    'default-skills': []
};

for (const key of Object.keys(rawCommands)) {
    const value = rawCommands[key];
    if (Array.isArray(value)) {
        rawCommands[key] = Object.freeze([...value]);
    }
}

const COMMANDS = Object.freeze({ ...rawCommands });

function getCommandRegistry() {
    return COMMANDS;
}

function isKnownCommand(commandName) {
    if (!commandName) return false;
    return Object.prototype.hasOwnProperty.call(COMMANDS, commandName);
}

export {
    getCommandRegistry,
    isKnownCommand
};
