#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { showHelp } from './commands/help.js';
import { bootstrapAgentLibRuntime } from '../agentlib/bootstrap.mjs';
import { parseBranchPolicy, stripBranchPolicyArgs } from '../agentlib/branchPolicy.mjs';
import { fingerprintSource, sourceIdEquals } from '../agentlib/fingerprint.mjs';
import {
    clearTransactionDescriptor,
    readActiveDescriptor,
    readTransactionDescriptor,
    resolveDescriptorSource,
    resolveWorkspaceRoot,
    writeActiveDescriptor,
    writeTransactionDescriptor,
} from '../agentlib/source.mjs';

const AGENTLIB_ACTIVATE_TRANSACTION = '--agentlib-activate-transaction';

// `runCoreCli()` accepts one global debug flag in any position. The read-only
// log dispatch has to recognize the same placement before it can decide whether
// `logs` is the command, but it must not take the initializing core path to do
// it.
function extractGlobalDebugFlag(args) {
    const index = args.findIndex(arg => arg === '--debug' || arg === '-d');
    if (index === -1) return { commandArgs: args, debug: false };
    const commandArgs = [...args];
    commandArgs.splice(index, 1);
    return { commandArgs, debug: true };
}

// Branch policy only narrows the AgentLib selection; a malformed value is
// reported by the command that owns it, so bootstrap treats it as absent rather
// than failing before the command can produce its own message.
function safeBranchPolicy(args) {
    try {
        return parseBranchPolicy(args);
    } catch (_) {
        return null;
    }
}

function revalidateSelection(selection) {
    const observed = fingerprintSource(selection.sourceDir);
    if (!sourceIdEquals(observed.sourceId, selection.sourceId)
        || observed.fingerprint !== selection.contentFingerprint) {
        const error = new Error(
            `The achillesAgentLib source at ${selection.sourceDir} changed during deployment; active.json was not updated.`,
        );
        error.code = 'PLOINKY_AGENTLIB_SOURCE_CHANGED';
        throw error;
    }
    return selection;
}

function transactionSelection(workspaceRoot) {
    const descriptor = readTransactionDescriptor(workspaceRoot);
    if (!descriptor) throw new Error('No staged achillesAgentLib transaction exists for this workspace.');
    const { sourceDir } = resolveDescriptorSource(descriptor, workspaceRoot);
    const selection = { ...descriptor, sourceDir, workspaceRoot };
    revalidateSelection(selection);
    return selection;
}

function commandFailed(code) {
    return Number.isInteger(code) && code !== 0;
}

function selectionsDiffer(first, second) {
    return !first || !second
        || first.mode !== second.mode
        || first.contentFingerprint !== second.contentFingerprint
        || !sourceIdEquals(first.sourceId, second.sourceId);
}

export async function launchCli(args = process.argv.slice(2), {
    showHelpImpl = showHelp,
    // The runtime shell reaches the Router security path, which resolves
    // achillesAgentLib at module load. Importing it lazily keeps `help` and
    // `logs` loadable without any AgentLib runtime contract at all.
    runOuterRuntimeShellImpl = null,
    statusWorkspaceImpl,
    importCoreImpl = () => import('./main.js'),
    importLogCommandsImpl = () => import('./commands/logCommands.js'),
    importConfigImpl = () => import('./utils/config.js'),
    importForegroundImpl = () => import('./commands/foregroundCommand.js'),
    bootstrapAgentLibImpl = bootstrapAgentLibRuntime,
    spawnActivationImpl = spawnSync,
    writeActiveImpl = writeActiveDescriptor,
    writeTransactionImpl = writeTransactionDescriptor,
    clearTransactionImpl = clearTransactionDescriptor,
    readActiveImpl = readActiveDescriptor,
    attestDeploymentImpl = null,
    input = process.stdin,
    env = process.env,
    errorOutput = process.stderr,
} = {}) {
    const workspaceRoot = resolveWorkspaceRoot({ cwd: process.cwd(), env });
    const attestDeployment = async () => {
        const attest = attestDeploymentImpl
            || (await import('./utils/agentLibDeploymentAttestation.js')).attestAgentLibDeployment;
        return attest({ env, workspaceRoot });
    };
    const restorePreviousDeployment = (error, previous, candidate, action = 'restart') => {
        if (!previous || !selectionsDiffer(previous, candidate)) return false;
        try {
            const { sourceDir, descriptor } = resolveDescriptorSource(previous, workspaceRoot);
            const prior = {
                ...descriptor,
                sourceDir,
                workspaceRoot,
            };
            revalidateSelection(prior);
            writeTransactionImpl(workspaceRoot, prior);
            const rollback = spawnActivationImpl(process.execPath, [
                fileURLToPath(import.meta.url),
                AGENTLIB_ACTIVATE_TRANSACTION,
                action,
            ], { stdio: 'inherit', env: { ...env, PLOINKY_WORKSPACE_ROOT: workspaceRoot } });
            if (rollback?.status !== 0) {
                error.message += `; prior AgentLib rollback failed with status ${String(rollback?.status)}`;
                return false;
            }
            return true;
        } catch (rollbackError) {
            error.message += `; prior AgentLib rollback was unsafe: ${rollbackError.message}`;
            return false;
        }
    };

    if (args[0] === AGENTLIB_ACTIVATE_TRANSACTION) {
        const action = String(args[1] || 'restart');
        if (!['restart', 'commit'].includes(action)) {
            throw new Error(`Unsupported AgentLib transaction activation '${action}'.`);
        }
        const selection = transactionSelection(workspaceRoot);
        await bootstrapAgentLibImpl({
            env,
            cwd: workspaceRoot,
            force: true,
            select: async () => ({ selection, mode: selection.mode }),
        });
        let runCoreCli;
        try {
            if (action === 'restart') {
                ({ runCoreCli } = await importCoreImpl());
                const code = await runCoreCli(['restart']);
                if (commandFailed(code)) throw new Error(`restart failed with status ${code}`);
                await attestDeployment();
            } else {
                const { buildAgentLibAttestation } = await import('../agentlib/runtime.mjs');
                buildAgentLibAttestation({ env });
            }
            revalidateSelection(selection);
            writeActiveImpl(workspaceRoot, selection);
            clearTransactionImpl(workspaceRoot);
            return 0;
        } catch (error) {
            if (runCoreCli) {
                try { await runCoreCli(['stop']); } catch (_) {}
            }
            throw error;
        }
    }

    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
        showHelpImpl(args[0] === 'help' ? args.slice(1) : [], { surface: 'core' });
        return 0;
    }
    if (args.length === 1 && args[0] === 'status') {
        // Status reports the selected AgentLib source, so it needs the runtime
        // contract — but in read-only mode, which never clones, fetches, or
        // creates workspace state.
        await bootstrapAgentLibImpl({ env, readOnly: true });
        const renderStatus = statusWorkspaceImpl
            || (await import('./utils/status.js')).statusWorkspace;
        await renderStatus();
        return 0;
    }
    if (args.length === 1 && args[0] === 'cli') {
        await bootstrapAgentLibImpl({ env, readOnly: true });
        const runShell = runOuterRuntimeShellImpl
            || (await import('./sandbox/runtimeShell.js')).runOuterRuntimeShell;
        return runShell();
    }
    // Logs are observational, so they bypass dependency assertion, environment
    // initialization, and repository bootstrap. Stdout carries only log bytes;
    // every informational message goes to stderr.
    const { commandArgs, debug } = extractGlobalDebugFlag(args);
    if (commandArgs[0] === 'logs') {
        if (debug) {
            const { setDebugMode } = await importConfigImpl();
            setDebugMode(true);
            errorOutput.write('[INFO] Debug mode enabled.\n');
        }
        const { runLogCommand } = await importLogCommandsImpl();
        // A follower runs until the operator interrupts it, so the coordinator
        // owns SIGINT/SIGTERM for the whole command and maps them to 130/143
        // only after the follower has released its child and descriptors.
        const { getForegroundCommandCoordinator } = await importForegroundImpl();
        const coordinator = getForegroundCommandCoordinator();
        const running = coordinator.run(({ signal }) => runLogCommand(commandArgs, { signal }));
        if (env.PLOINKY_BOX_LOG_STREAM !== '1') return (await running).code;

        const onEof = () => coordinator.cancel();
        input.once?.('end', onEof);
        input.once?.('close', onEof);
        input.resume?.();
        try {
            return (await running).code;
        } finally {
            input.removeListener?.('end', onEof);
            input.removeListener?.('close', onEof);
        }
    }
    // Establish the achillesAgentLib runtime contract before importing any core
    // module. Outside the Box this selects (and, for a managed source, stages)
    // the one workspace source; inside the Box it only validates the mount the
    // host supervisor established. Help, logs, and single-word status returned
    // above, so they stay free of any clone or fetch side effect.
    const branchPolicy = ['restart', 'update'].includes(commandArgs[0])
        ? parseBranchPolicy(args)
        : safeBranchPolicy(args);
    const bootstrap = (await bootstrapAgentLibImpl({ env, branchPolicy }))
        || { owned: false, selection: null };
    const { runCoreCli } = await importCoreImpl();
    const effectiveArgs = ['restart', 'update'].includes(commandArgs[0])
        ? stripBranchPolicyArgs(args)
        : args;
    const previous = bootstrap.owned ? readActiveImpl(workspaceRoot) : null;
    let result;
    try {
        result = await runCoreCli(effectiveArgs, { agentLibBranchPolicy: branchPolicy });
        if (commandFailed(result)) {
            throw new Error(`${commandArgs[0] || 'command'} failed with status ${result}`);
        }
    } catch (error) {
        if (bootstrap.owned && ['start', 'restart'].includes(commandArgs[0])) {
            try { await runCoreCli(['stop']); } catch (_) {}
            restorePreviousDeployment(error, previous, bootstrap.selection);
        }
        throw error;
    }

    if (!bootstrap.owned) return result;

    if (['start', 'restart'].includes(commandArgs[0])) {
        try {
            const attestation = await attestDeployment();
            revalidateSelection(bootstrap.selection);
            writeActiveImpl(workspaceRoot, bootstrap.selection);
            return result ?? (attestation ? 0 : result);
        } catch (error) {
            try { await runCoreCli(['stop']); } catch (_) {}
            // A different prior managed/local source can be restored only when
            // its exact old identity and fingerprint still exist.
            restorePreviousDeployment(error, previous, bootstrap.selection);
            throw error;
        }
    }

    const updateTransition = commandArgs[0] === 'update' ? result?.agentLib : null;
    if (!updateTransition?.selection) return result;

    writeTransactionImpl(workspaceRoot, updateTransition.selection);
    const registryModule = await import('./utils/agentRegistrySnapshot.js');
    const registry = registryModule.readAgentRegistrySnapshot({ workspaceRoot });
    const configured = Boolean(registry?._config?.static?.agent && registry?._config?.static?.port);
    const activationArgs = [
        fileURLToPath(import.meta.url),
        AGENTLIB_ACTIVATE_TRANSACTION,
        configured ? 'restart' : 'commit',
    ];
    const activation = spawnActivationImpl(process.execPath, activationArgs, {
        stdio: 'inherit',
        env: { ...env, PLOINKY_WORKSPACE_ROOT: workspaceRoot },
    });
    if (activation?.status === 0) return result;

    const activationError = new Error(
        `achillesAgentLib activation failed with status ${String(activation?.status)}; active.json was not advanced.`,
    );
    const priorDescriptor = updateTransition.previous || previous;
    restorePreviousDeployment(
        activationError,
        priorDescriptor,
        updateTransition.selection,
        configured ? 'restart' : 'commit',
    );
    throw activationError;
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
    launchCli().then(code => {
        if (Number.isInteger(code)) process.exitCode = code;
    }).catch(error => {
        console.error('❌ Error: ' + error.message);
        process.exitCode = 1;
    });
}
