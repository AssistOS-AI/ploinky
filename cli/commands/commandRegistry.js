const rawCommands = {
    add: [],
    install: [],
    remove: [],
    uninstall: [],
    update: ['repo', 'repos', 'all'],
    reinstall: ['agent'],
    enable: ['repo', 'agent', 'sandbox'],
    disable: ['repo', 'agent', 'sandbox'],
    sandbox: ['status', 'disable', 'enable'],
    network: ['status', 'prune'],
    shell: [],
    cli: [],
    cs: [],
    code: [],
    coding: ['agents', 'sessions'],
    'coding-sessions': [],
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
    cache: ['purge-config', 'clear', 'hold', 'release'],
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
