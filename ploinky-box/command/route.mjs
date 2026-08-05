import { PloinkyBoxError } from '../errors.mjs';

function routeError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
}

function localAdmission(parsed) {
    return parsed.localBoxImageId === null
        ? {}
        : {
            localBoxImageId: parsed.localBoxImageId,
            mediaHostPort: parsed.explicitMediaPort,
            ...(parsed.explicitPort === null ? {} : { hostPort: parsed.explicitPort }),
        };
}

function requireNoLocalAdmission(parsed, command) {
    if (parsed.localBoxImageId !== null) {
        throw routeError(`${command}: local Box admission is not supported`);
    }
}

function requireNoArgs(parsed, command) {
    if (parsed.commandArgs.length > 0) {
        throw routeError(`${command}: unexpected trailing argument '${parsed.commandArgs[0]}'`);
    }
    if (parsed.explicitPort !== null) {
        throw routeError(`${command}: --port is not supported`);
    }
    requireNoLocalAdmission(parsed, command);
}

function routeDestroy(parsed) {
    if (parsed.dryRun) {
        throw routeError('destroy: --dry-run is not supported');
    }
    if (parsed.explicitPort !== null) {
        throw routeError('destroy: --port is not supported');
    }
    requireNoLocalAdmission(parsed, 'destroy');
    if (parsed.commandArgs.length === 0) {
        return Object.freeze({ kind: 'destroy', deleteVolumes: false });
    }
    if (parsed.commandArgs[0] !== '--delete-volumes') {
        throw routeError(`destroy: unexpected trailing argument '${parsed.commandArgs[0]}'`);
    }
    if (parsed.commandArgs.length > 1) {
        const message = parsed.commandArgs[1] === '--delete-volumes'
            ? 'destroy: --delete-volumes was supplied more than once'
            : `destroy: unexpected trailing argument '${parsed.commandArgs[1]}'`;
        throw routeError(message);
    }
    return Object.freeze({ kind: 'destroy', deleteVolumes: true });
}

export function routeOuterCommand(parsed) {
    if (parsed.help || parsed.command === 'help') {
        requireNoLocalAdmission(parsed, 'help');
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
    if (parsed.command === 'start') {
        return Object.freeze({
            kind: parsed.dryRun ? 'dry-run' : 'start',
            hostPort: parsed.start.hostPort,
            ...localAdmission(parsed),
            coreArgv: parsed.start.coreArgv,
        });
    }
    if (!parsed.command) {
        return Object.freeze({
            kind: parsed.dryRun ? 'dry-run' : 'repl',
            ...localAdmission(parsed),
            coreArgv: parsed.forwardingArgv,
        });
    }
    if (['bash', 'shell'].includes(parsed.command)
        || (parsed.command === 'cli' && parsed.commandArgs.length === 0)) {
        return Object.freeze({
            kind: parsed.dryRun ? 'dry-run' : 'bash',
            ...localAdmission(parsed),
        });
    }
    if (parsed.command === 'cli') {
        return Object.freeze({
            kind: parsed.dryRun ? 'dry-run' : 'agent-cli',
            ...localAdmission(parsed),
            coreArgv: parsed.forwardingArgv,
            agentCli: parsed.agentCli,
        });
    }
    return Object.freeze({
        kind: parsed.dryRun ? 'dry-run' : 'generic',
        ...localAdmission(parsed),
        coreArgv: parsed.forwardingArgv,
    });
}
