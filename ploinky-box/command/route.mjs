import { PloinkyBoxError } from '../errors.mjs';

function routeError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
}

function requireNoArgs(parsed, command) {
    if (parsed.commandArgs.length > 0) {
        throw routeError(`${command}: unexpected trailing argument '${parsed.commandArgs[0]}'`);
    }
    if (parsed.explicitPort !== null) {
        throw routeError(`${command}: --port is not supported`);
    }
    if (parsed.explicitMediaPort !== null) {
        throw routeError(`${command}: --udp-port is not supported`);
    }
}

function routeDestroy(parsed) {
    if (parsed.dryRun) {
        throw routeError('destroy: --dry-run is not supported');
    }
    if (parsed.explicitPort !== null) {
        throw routeError('destroy: --port is not supported');
    }
    if (parsed.explicitMediaPort !== null) {
        throw routeError('destroy: --udp-port is not supported');
    }
    if (parsed.commandArgs.length === 0) {
        return Object.freeze({ kind: 'destroy', deleteCache: false });
    }
    if (parsed.commandArgs[0] !== '--delete-cache') {
        throw routeError(`destroy: unexpected trailing argument '${parsed.commandArgs[0]}'`);
    }
    if (parsed.commandArgs.length > 1) {
        const message = parsed.commandArgs[1] === '--delete-cache'
            ? 'destroy: --delete-cache was supplied more than once'
            : `destroy: unexpected trailing argument '${parsed.commandArgs[1]}'`;
        throw routeError(message);
    }
    return Object.freeze({ kind: 'destroy', deleteCache: true });
}

function routeUpdate(parsed) {
    if (parsed.dryRun) {
        return Object.freeze({ kind: 'dry-run' });
    }
    const scope = String(parsed.commandArgs[0] || '').trim().toLowerCase();
    if (!scope || scope === 'all') {
        return Object.freeze({
            kind: 'update',
            coreArgv: parsed.forwardingArgv,
        });
    }
    return Object.freeze({
        kind: 'generic',
        coreArgv: parsed.forwardingArgv,
    });
}

export function routeOuterCommand(parsed) {
    if (parsed.help || parsed.command === 'help') {
        return Object.freeze({ kind: 'help', topic: parsed.commandArgs });
    }
    if (parsed.command === 'status') {
        requireNoArgs(parsed, 'status');
        return Object.freeze({ kind: 'status' });
    }
    if (parsed.command === 'stop') {
        requireNoArgs(parsed, 'stop');
        return Object.freeze({ kind: 'stop' });
    }
    if (parsed.command === 'destroy') {
        return routeDestroy(parsed);
    }
    if (parsed.command === 'update') {
        return routeUpdate(parsed);
    }
    if (parsed.command === 'start') {
        return Object.freeze({
            kind: parsed.dryRun ? 'dry-run' : 'start',
            hostPort: parsed.start.hostPort,
            mediaHostPort: parsed.start.mediaHostPort,
            coreArgv: parsed.start.coreArgv,
        });
    }
    if (parsed.command === 'restart') {
        return Object.freeze({
            kind: parsed.dryRun ? 'dry-run' : 'restart',
            coreArgv: parsed.forwardingArgv,
        });
    }
    if (!parsed.command) {
        return Object.freeze({ kind: parsed.dryRun ? 'dry-run' : 'repl', coreArgv: parsed.forwardingArgv });
    }
    if (['bash', 'shell'].includes(parsed.command)
        || (parsed.command === 'cli' && parsed.commandArgs.length === 0)) {
        return Object.freeze({ kind: parsed.dryRun ? 'dry-run' : 'bash' });
    }
    if (parsed.command === 'cli') {
        return Object.freeze({ kind: parsed.dryRun ? 'dry-run' : 'agent-cli', coreArgv: parsed.forwardingArgv });
    }
    // Logs are observational, so they get their own route instead of the
    // generic one: generic forwarding prepares the Box, which can create,
    // reconcile, or repair it before the command runs.
    if (parsed.command === 'logs') {
        return Object.freeze({
            kind: parsed.dryRun ? 'dry-run' : 'logs',
            coreArgv: parsed.forwardingArgv,
        });
    }
    return Object.freeze({
        kind: parsed.dryRun ? 'dry-run' : 'generic',
        coreArgv: parsed.forwardingArgv,
    });
}
