import { BOX_ROUTER_CONTAINER_PORT } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { parseHostPort } from '../ports.mjs';
import { parseAgentCliArguments } from './agent-cli.mjs';
import { parseReleaseDescriptor } from '../contract/release.mjs';

function argumentError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
}

function parseArgumentPort(value, source) {
    try {
        return parseHostPort(value, { source });
    } catch (error) {
        throw argumentError(error.message);
    }
}

function consumeValue(tokens, index, flag) {
    const next = tokens[index + 1];
    if (!next || next.text === '') {
        throw argumentError(`${flag} requires a value`);
    }
    return next;
}

function analyzeStart(tokens, commandToken, explicitPort) {
    const tail = tokens.filter((token) => token.rawIndex > commandToken.rawIndex);
    const positional = [];
    const policyWithValue = new Set(['--branch', '--repo-branch', '--branch-fallback']);
    for (let index = 0; index < tail.length; index += 1) {
        const token = tail[index];
        if (token.text === '--port' || token.text.startsWith('--port=')) {
            throw argumentError('--port is accepted only before start and only as two arguments');
        }
        if (policyWithValue.has(token.text)) {
            if (!tail[index + 1]) throw argumentError(`${token.text} requires a value`);
            index += 1;
            continue;
        }
        if (token.text.startsWith('--')) continue;
        if (token.text === '-d') continue;
        positional.push(token);
    }
    if (positional.length === 0) {
        throw argumentError('start requires a static agent');
    }
    if (positional.length > 2) {
        throw argumentError('start accepts only STATIC_AGENT and one optional host port');
    }
    let positionalPort;
    if (positional.length === 2) {
        positionalPort = parseArgumentPort(positional[1].text, 'start host port');
    }
    if (explicitPort !== null && positionalPort !== undefined) {
        throw argumentError('start host port was supplied more than once');
    }
    const hostPort = explicitPort ?? positionalPort ?? null;
    const positionalPortIndex = positional.length === 2 ? positional[1].rawIndex : -1;
    return { hostPort, positionalPortIndex };
}

export function parseOuterArguments(argv, releaseOptions = {}) {
    if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
        throw new TypeError('Outer arguments must be an array of strings');
    }
    const raw = [...argv];
    const firstCliIndex = raw.indexOf('cli');
    const firstDebugIndex = raw.findIndex((token, index) => (
        (token === '--debug' || token === '-d')
        && (firstCliIndex < 0 || index < firstCliIndex)
    ));
    const tokens = raw.map((text, rawIndex) => ({ text, rawIndex }))
        .filter((token) => token.rawIndex !== firstDebugIndex);
    const removedRawIndexes = new Set();
    let explicitPort = null;
    let localReleaseDescriptor = null;
    let dryRun = false;
    let help = false;
    let commandToken = null;
    let terminated = false;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.text === '--') {
            removedRawIndexes.add(token.rawIndex);
            terminated = true;
            commandToken = tokens[index + 1] || null;
            break;
        }
        if (token.text === '--port') {
            if (explicitPort !== null) throw argumentError('--port was supplied more than once');
            const value = consumeValue(tokens, index, '--port');
            explicitPort = parseArgumentPort(value.text, '--port');
            removedRawIndexes.add(token.rawIndex);
            removedRawIndexes.add(value.rawIndex);
            index += 1;
            continue;
        }
        if (token.text.startsWith('--port=')) {
            throw argumentError('--port=PORT is unsupported; use --port PORT before start');
        }
        if (token.text === '--local-release-descriptor') {
            if (localReleaseDescriptor !== null) {
                throw argumentError('--local-release-descriptor was supplied more than once');
            }
            const value = consumeValue(tokens, index, '--local-release-descriptor');
            try {
                localReleaseDescriptor = parseReleaseDescriptor(value.text, releaseOptions);
            } catch (error) {
                throw argumentError(`--local-release-descriptor: ${error.message}`);
            }
            removedRawIndexes.add(token.rawIndex);
            removedRawIndexes.add(value.rawIndex);
            index += 1;
            continue;
        }
        if (token.text.startsWith('--local-release-descriptor=')) {
            throw argumentError('--local-release-descriptor=JSON is unsupported; use two arguments');
        }
        if (token.text === '--local-box-image-id'
            || token.text.startsWith('--local-box-image-id=')
            || token.text === '--local-node-image-id'
            || token.text.startsWith('--local-node-image-id=')
            || token.text === '--local-media-port'
            || token.text.startsWith('--local-media-port=')) {
            throw argumentError(`${token.text.split('=')[0]} is retired; use --local-release-descriptor JSON`);
        }
        if (token.text === '--dry-run') {
            if (dryRun) throw argumentError('--dry-run was supplied more than once');
            dryRun = true;
            removedRawIndexes.add(token.rawIndex);
            continue;
        }
        if (token.text === '-h' || token.text === '--help') {
            help = true;
            removedRawIndexes.add(token.rawIndex);
            continue;
        }
        if (['--image', '--engine', '--name', '--rotate-master-key'].includes(token.text)
            || ['--image=', '--engine=', '--name=', '--rotate-master-key='].some((prefix) => token.text.startsWith(prefix))) {
            throw argumentError(`${token.text.split('=')[0]} is not a supported public Box option`);
        }
        if (token.text.startsWith('-')) {
            throw argumentError(`Unknown outer option ${token.text}; use -- before an option-led core command`);
        }
        commandToken = token;
        break;
    }

    if (explicitPort !== null
        && commandToken?.text !== 'start'
        && localReleaseDescriptor === null) {
        throw argumentError(
            '--port outside start requires the coupled local Box image and media-port options',
        );
    }
    if (localReleaseDescriptor !== null && explicitPort !== null) {
        throw argumentError('Release descriptor owns the Router host port; --port is not supported');
    }
    const classificationArgv = tokens.map((token) => token.text);
    const command = commandToken?.text || '';
    const commandArgs = commandToken
        ? tokens.filter((token) => token.rawIndex > commandToken.rawIndex).map((token) => token.text)
        : [];
    const forwarding = raw.filter((_, index) => !removedRawIndexes.has(index));
    let start = null;
    let agentCli = null;
    if (command === 'start') {
        const analyzed = analyzeStart(tokens, commandToken, explicitPort);
        if (localReleaseDescriptor && analyzed.hostPort !== null) {
            throw argumentError('Release descriptor owns the Router host port; do not also supply a start port');
        }
        const normalized = raw.flatMap((token, rawIndex) => {
            if (removedRawIndexes.has(rawIndex)) return [];
            if (rawIndex === analyzed.positionalPortIndex) return [String(BOX_ROUTER_CONTAINER_PORT)];
            return [token];
        });
        if (analyzed.positionalPortIndex < 0) {
            normalized.push(String(BOX_ROUTER_CONTAINER_PORT));
        }
        start = Object.freeze({
            hostPort: localReleaseDescriptor?.routerHostPort ?? analyzed.hostPort,
            coreArgv: Object.freeze(normalized),
        });
    } else if (command === 'cli' && commandArgs.length > 0) {
        agentCli = parseAgentCliArguments(commandArgs);
    }
    return Object.freeze({
        rawArgv: Object.freeze(raw),
        classificationArgv: Object.freeze(classificationArgv),
        forwardingArgv: Object.freeze(forwarding),
        command,
        commandArgs: Object.freeze(commandArgs),
        debug: Object.freeze({
            enabled: firstDebugIndex >= 0,
            token: firstDebugIndex >= 0 ? raw[firstDebugIndex] : '',
            rawIndex: firstDebugIndex,
        }),
        dryRun,
        help,
        terminated,
        explicitPort,
        localReleaseDescriptor,
        start,
        agentCli,
    });
}
