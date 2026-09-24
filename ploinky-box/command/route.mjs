import { PloinkyBoxError } from '../errors.mjs';
import { stripBranchPolicyArgs } from '../../agentlib/branchPolicy.mjs';
import { retiredCommandMessage } from '../../cli/retiredCommands.js';
import { parseUpdateRequest, UpdateRequestError } from '../../cli/commands/updateRequest.js';

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

const DEBUG_TOKENS = new Set(['--debug', '-d']);

// Branch-policy options in their original spelling. Targeted forms forward
// them unchanged to the in-Box core, as the generic route did before.
function branchPolicyArgs(args) {
    const kept = [];
    const list = (args || []).map(String);
    for (let index = 0; index < list.length; index += 1) {
        const arg = list[index];
        if (arg === '--branch' || arg === '--repo-branch' || arg === '--branch-fallback') {
            kept.push(arg, ...(index + 1 < list.length ? [list[index + 1]] : []));
            index += 1;
        } else if (arg.startsWith('--branch=') || arg.startsWith('--repo-branch=')
            || arg.startsWith('--branch-fallback=') || arg === '--reset-repos') {
            kept.push(arg);
        }
    }
    return kept;
}

/**
 * Every non-dry-run update form becomes one typed request, parsed once before
 * any host self-update, Box creation or source mutation. Folder scope
 * containment and its Box spelling are resolved later against the exact
 * workspace identity; only syntax is decided here.
 */
function routeUpdate(parsed, { cwd = process.cwd() } = {}) {
    if (parsed.dryRun) {
        return Object.freeze({ kind: 'dry-run' });
    }
    const commandArgs = stripBranchPolicyArgs(parsed.commandArgs);
    const extraDebug = commandArgs.some(argument => DEBUG_TOKENS.has(argument));
    const updateArgs = commandArgs.filter(argument => !DEBUG_TOKENS.has(argument));
    const option = updateArgs.find(argument => argument.startsWith('-'));
    if (option) {
        throw routeError(`update: unsupported option '${option}'`);
    }
    let request;
    try {
        request = parseUpdateRequest(updateArgs, { cwd });
    } catch (error) {
        if (error instanceof UpdateRequestError) {
            throw new PloinkyBoxError(error.message, { code: 'PLOINKY_BOX_ARGUMENT_INVALID', cause: error });
        }
        throw error;
    }
    return Object.freeze({
        kind: 'update',
        request,
        debug: parsed.debug.enabled || extraDebug,
        branchPolicyArgs: Object.freeze(branchPolicyArgs(parsed.commandArgs)),
        coreArgv: parsed.forwardingArgv,
    });
}

function routeStatus(parsed) {
    if (parsed.explicitPort !== null) {
        throw routeError('status: --port is not supported');
    }
    if (parsed.explicitMediaPort !== null) {
        throw routeError('status: --udp-port is not supported');
    }
    if (parsed.commandArgs.length > 1
        || (parsed.commandArgs.length === 1 && parsed.commandArgs[0] !== '--verbose')) {
        throw routeError('Usage: status [--verbose]');
    }
    return Object.freeze({
        kind: 'status',
        coreArgv: parsed.forwardingArgv,
    });
}

function routeDiagnose(parsed) {
    if (parsed.dryRun) {
        throw routeError('diagnose: --dry-run is not supported; diagnose runs temporary probes and cleans them up');
    }
    if (parsed.commandArgs.length > 1
        || (parsed.commandArgs.length === 1 && parsed.commandArgs[0] !== '--json')) {
        throw routeError('Usage: ploinky diagnose [--json]');
    }
    return Object.freeze({ kind: 'diagnose', json: parsed.commandArgs[0] === '--json' });
}

function routeRepair(parsed) {
    let dryRun = parsed.dryRun;
    let json = false;
    for (const argument of parsed.commandArgs) {
        if (argument === '--dry-run') {
            if (dryRun) throw routeError('repair: --dry-run was supplied more than once');
            dryRun = true;
        } else if (argument === '--json') {
            if (json) throw routeError('repair: --json was supplied more than once');
            json = true;
        } else {
            throw routeError('Usage: ploinky repair [--dry-run] [--json]');
        }
    }
    return Object.freeze({ kind: 'repair', dryRun, json });
}

export function routeOuterCommand(parsed, options = {}) {
    // Retired commands answer on the host without preparing or creating a Box.
    const retired = retiredCommandMessage(parsed.command);
    if (retired) return Object.freeze({ kind: 'retired', command: parsed.command, message: retired });
    if (parsed.help || parsed.command === 'help') {
        return Object.freeze({ kind: 'help', topic: parsed.commandArgs });
    }
    if (parsed.command === 'diagnose') {
        return routeDiagnose(parsed);
    }
    if (parsed.command === 'repair') {
        return routeRepair(parsed);
    }
    if (parsed.command === 'status') {
        return routeStatus(parsed);
    }
    if (parsed.command === 'stop') {
        requireNoArgs(parsed, 'stop');
        return Object.freeze({ kind: 'stop' });
    }
    if (parsed.command === 'destroy') {
        return routeDestroy(parsed);
    }
    if (parsed.command === 'update') {
        return routeUpdate(parsed, options);
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
    // Bind changes the host-owned outer publication; it is never forwarded to
    // the in-Box core and its dry run is a read-only host plan.
    if (parsed.command === 'bind') {
        return Object.freeze({
            kind: parsed.dryRun ? 'bind-dry-run' : 'bind',
            mapping: parsed.bind?.mapping ?? null,
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
