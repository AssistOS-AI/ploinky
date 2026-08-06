import { spawnSync } from 'child_process';
import path from 'path';
import { PLOINKY_MANAGED_LABEL } from './common.js';
import { loadAgents } from '../../utils/workspace.js';
import {
    resolveInteractiveSpawnResult,
    shouldAllocateInteractiveTty,
} from '../interactiveProcess.js';

function joinShellCommandParts(parts) {
    return parts.filter((part) => String(part || '').trim()).join(' ');
}

function buildInteractiveCommandCreateCommand({
    runtime,
    containerName,
    mountOption = '',
    portOptions = '',
    envVars = '',
    containerImage,
} = {}) {
    return joinShellCommandParts([
        runtime,
        'create',
        '--pull=never',
        '-it',
        '--name',
        containerName,
        '--label',
        PLOINKY_MANAGED_LABEL,
        mountOption,
        portOptions,
        envVars,
        containerImage,
        '/bin/sh -lc "while :; do sleep 3600; done"',
    ]);
}

function buildInteractiveAgentCreateCommand({
    runtime,
    containerName,
    envHash,
    projectDir,
    homeDir,
    agentLibPath,
    absAgentPath,
    sharedDir,
    volumeSuffix = '',
    readOnlySuffix = ':ro',
    portOptions = '',
    envVars = '',
    containerImage,
} = {}) {
    return joinShellCommandParts([
        runtime,
        'create',
        '--pull=never',
        '-it',
        '--name',
        containerName,
        '--label',
        PLOINKY_MANAGED_LABEL,
        '--label',
        `ploinky.envhash=${envHash}`,
        `-v "${projectDir}:${projectDir}${volumeSuffix}"`,
        path.resolve(projectDir) === path.resolve(homeDir)
            ? ''
            : `-v "${homeDir}:/root${volumeSuffix}"`,
        `-v "${agentLibPath}:/Agent${readOnlySuffix}"`,
        `-v "${absAgentPath}:/code${readOnlySuffix}"`,
        `-v "${sharedDir}:/shared${volumeSuffix}"`,
        portOptions,
        envVars,
        containerImage,
        '/bin/sh -lc "while :; do sleep 3600; done"',
    ]);
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sanitizeHistoryName(value) {
    return String(value || 'agent').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function buildInteractiveShellCommand(entryCommand, allocateTty) {
    const rawCommand = entryCommand && String(entryCommand).trim()
        ? String(entryCommand).trim()
        : 'exec /bin/bash || exec /bin/sh';
    if (allocateTty && rawCommand === '/bin/sh') {
        return "export PS1='# '; if command -v /bin/bash >/dev/null 2>&1; then exec /bin/bash --noprofile --norc -i; else exec /bin/sh -i; fi";
    }
    return rawCommand;
}

function buildTerminalEnvArgs(env = process.env, historyName = '') {
    const args = [];
    for (const key of ['TERM', 'COLORTERM', 'LINES', 'COLUMNS']) {
        if (env[key]) args.push('-e', `${key}=${env[key]}`);
    }
    if (historyName) {
        args.push(
            '-e', `HISTFILE=/shared/.ploinky-${sanitizeHistoryName(historyName)}-shell-history`,
            '-e', 'HISTSIZE=5000',
            '-e', 'HISTFILESIZE=10000'
        );
    }
    return args;
}

function buildWebchatEnvArgs(env = process.env) {
    const args = [];
    const hasHistory = String(env.PLOINKY_WEBCHAT_HAS_HISTORY || '').trim();
    if (hasHistory === '0' || hasHistory === '1') {
        args.push('-e', `PLOINKY_WEBCHAT_HAS_HISTORY=${hasHistory}`);
    }
    return args;
}

function buildExecArgs(containerName, workdir, entryCommand, interactive = true, allocateTty = true, options = {}) {
    const wd = workdir || process.cwd();
    const cmd = buildInteractiveShellCommand(entryCommand, allocateTty);
    const args = ['exec'];
    if (interactive && allocateTty) {
        args.push('-it');  // Full interactive with TTY (for direct terminal use)
        const historyName = Object.prototype.hasOwnProperty.call(options, 'historyName') ? options.historyName : containerName;
        args.push(...buildTerminalEnvArgs(options.env || process.env, historyName));
    } else if (interactive) {
        args.push('-i');   // Interactive stdin only, no TTY (for webchat - ensures stdin EOF propagates)
    }
    args.push(...buildWebchatEnvArgs(options.env || process.env));
    args.push(containerName, 'sh', '-lc', `cd ${shellQuote(wd)} && ${cmd}`);
    return args;
}

function resolveContainerWorkdir(containerName, workdir, registryRecord = null) {
    try {
        const record = registryRecord || loadAgents()?.[containerName];
        if (record?.runMode === 'isolated' && record.projectPath && path.resolve(record.projectPath) === path.resolve(workdir)) {
            return '/root';
        }
    } catch (_) {}
    return workdir;
}

function requireInteractivePodmanIdentity(options = {}) {
    const record = options.registryRecord;
    const exactText = (value) => typeof value === 'string'
        && value !== ''
        && value === value.trim();
    if (!record
        || record.type !== 'agent'
        || record.runtime !== 'podman'
        || typeof record.containerId !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.containerId)
        || !exactText(record.instanceId)
        || !exactText(record.enableGeneration)) {
        const error = new Error('interactive container attach requires one exact immutable Podman registry identity');
        error.code = 'PLOINKY_INTERACTIVE_RUNTIME_IDENTITY_INVALID';
        error.status = 409;
        throw error;
    }
    return record;
}

function requireInteractivePodmanRuntime(options = {}) {
    if (options.runtime !== 'podman') {
        const requestedRuntime = options.runtime ?? '';
        const error = new Error(
            `interactive container attach requires exact runtime 'podman'; received '${String(requestedRuntime) || 'missing'}'`,
        );
        error.code = 'PLOINKY_INTERACTIVE_RUNTIME_MISMATCH';
        error.status = 409;
        error.context = Object.freeze({ requestedRuntime });
        throw error;
    }
    return options.runtime;
}

function attachInteractive(containerName, workdir, entryCommand, options = {}) {
    const env = options.env || process.env;
    const runtime = requireInteractivePodmanRuntime(options);
    const registryRecord = requireInteractivePodmanIdentity(options);
    const allocateTty = shouldAllocateInteractiveTty({
        env,
        stdin: options.stdin || process.stdin,
        stdout: options.stdout || process.stdout,
    });
    const containerWorkdir = resolveContainerWorkdir(containerName, workdir, registryRecord);
    const execArgs = buildExecArgs(registryRecord.containerId, containerWorkdir, entryCommand, true, allocateTty, {
        env,
        historyName: containerName
    });
    const result = (options.spawnSyncImpl || spawnSync)(runtime, execArgs, { stdio: 'inherit' });
    return resolveInteractiveSpawnResult(result, { label: `container shell '${containerName}'` });
}

export {
    attachInteractive,
    buildExecArgs,
    buildInteractiveAgentCreateCommand,
    buildInteractiveCommandCreateCommand
};
