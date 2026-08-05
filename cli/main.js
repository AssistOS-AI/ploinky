import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    HISTORY_FILE,
    initEnvironment,
    logPloinkyDirectory,
    setDebugMode,
} from './utils/config.js';
import { handleCommand, getAgentNames, getRepoNames, cleanupSessionContainers as cleanupCliSessions } from './commands/cli.js';
import { getCommandRegistry } from './commands/commandRegistry.js';
import { debugLog } from './utils/utils.js';
import * as inputState from './commands/inputState.js';
import { runReplCommand } from './sandbox/replCommandRunner.js';
import { bootstrap } from './commands/ploinkyboot.js';
import { enableMultilineNavigation } from './commands/multilineNavigation.js';
import { getPredefinedRepos, parseStartArgs } from './utils/repos.js';

const COMMANDS = getCommandRegistry();
const PLOINKY_ROOT = process.env.PLOINKY_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function commandOwnsRuntimeAdmission(args) {
    const command = String(args?.[0] || '').trim().toLowerCase();
    if (['start', 'restart', 'reinstall', 'cli', 'shell'].includes(command)) return true;
    if (command !== 'enable') return false;
    const targetKind = String(args?.[1] || '').trim().toLowerCase();
    return !['repo', 'repository', 'sandbox', 'host-sandbox', 'lite-sandbox'].includes(targetKind);
}

function assertRuntimeDependencies() {
    const missing = ['achillesAgentLib', 'mcp-sdk'].filter((dep) => {
        try {
            return !fs.statSync(path.join(PLOINKY_ROOT, 'node_modules', dep)).isDirectory();
        } catch (_) {
            return true;
        }
    });
    if (missing.length === 0) return;
    console.error(`Ploinky dependencies missing: ${missing.map((dep) => path.join(PLOINKY_ROOT, 'node_modules', dep)).join(', ')}`);
    console.error('WARNING: Ploinky cannot run until dependencies are installed.');
    console.error(`Install them with: ${path.join(PLOINKY_ROOT, 'bin', 'ploinky-install-deps')}`);
    process.exit(1);
}

function getPredefinedRepoNames() {
    return Object.keys(getPredefinedRepos() || {}).sort();
}

function completer(line) {
    const words = line.split(/\s+/).filter(Boolean);
    const lineFragment = line.endsWith(' ') ? '' : (words[words.length - 1] || '');

    let completions = [];
    let context = 'commands';

    // Check if it's a known Ploinky command
    if (words.length > 0 && COMMANDS.hasOwnProperty(words[0])) {
        const command = words[0];
        const subcommands = COMMANDS[command];

        // Determine the context for completion
            if (line.endsWith(' ')) {
            if ((command === 'add' || command === 'install' || command === 'remove' || command === 'uninstall') && words.length === 1) {
                context = 'args';
            } else if (words.length === 1 && subcommands.length > 0 && command !== 'reinstall' && command !== 'update') {
                context = 'subcommands';
            } else if (command === 'help' && words.length === 1) {
                // For help command, show all available commands
                context = 'help-topics';
            } else if (command === 'cloud' && words.length === 2) {
                // For cloud commands, show sub-subcommands
                const cloudSubcommand = words[1];
                if (['host', 'repo', 'agent', 'admin'].includes(cloudSubcommand)) {
                    context = 'cloud-sub';
                } else {
                    context = 'args';
                }
            } else if (command === 'client' && words.length === 2) {
                // For client commands, show agent names where appropriate
                const clientSubcommand = words[1];
                if (['methods', 'status', 'task', 'task-status'].includes(clientSubcommand)) {
                    context = 'args'; // Will show agent names
                } else {
                    context = 'none';
                }
            } else if (command === 'list' && words.length === 2) {
                // After list agents/repos, don't show anything
                context = 'none';
            } else if (command === 'reinstall' && words.length === 1) {
                context = 'args';
            } else if (command === 'update' && words.length === 1) {
                context = 'args';
            } else if (command === 'default-skills' && words.length === 1) {
                context = 'args';
            } else if ((command === 'start') && words.length === 2) {
                context = 'subcommands';
            } else if (words.length === 2) {
                context = 'args';
            } else {
                // Only show files for commands that actually need them
                // Most internal commands don't need file completion
                const fileCommands = ['cd', 'cat', 'ls', 'rm', 'cp', 'mv', 'mkdir', 'touch'];
                if (fileCommands.includes(command)) {
                    context = 'files';
                } else {
                    context = 'none';
                }
            }
        } else {
            if (words.length === 1) context = 'commands';
            else if ((command === 'add' || command === 'install' || command === 'remove' || command === 'uninstall') && words.length === 2) {
                context = 'args';
            } else if (words.length === 2 && subcommands.length > 0) {
                if ((command === 'disable' || command === 'reinstall' || command === 'update') && !subcommands.includes(words[1])) {
                    context = 'args';
                } else {
                    context = 'subcommands';
                }
            } else if (command === 'reinstall' && words.length === 2) {
                context = 'args';
            }
            else if (command === 'help' && words.length === 2) {
                // Completing help topics
                context = 'help-topics';
            } else if (command === 'cloud' && words.length === 3) {
                const cloudSubcommand = words[1];
                if (['host', 'repo', 'agent', 'admin'].includes(cloudSubcommand)) {
                    context = 'cloud-sub';
                }
            } else if (command === 'client' && words.length === 3) {
                const clientSubcommand = words[1];
                if (['methods', 'status', 'task', 'task-status'].includes(clientSubcommand)) {
                    context = 'args'; // Will show agent names
                }
            } else {
                // Only show files for commands that actually need them
                const fileCommands = ['cd', 'cat', 'ls', 'rm', 'cp', 'mv', 'mkdir', 'touch'];
                if (fileCommands.includes(command)) {
                    context = 'files';
                } else {
                    context = 'none';
                }
            }
        }

        // Get potential completions based on context
        if (context === 'subcommands') {
            completions = subcommands;
            if (command === 'disable') {
                completions = [...new Set([...subcommands, ...getAgentNames()])];
            }
            if (command === 'reinstall') {
                completions = [...new Set([...subcommands, ...getAgentNames()])];
            }
        } else if (context === 'help-topics') {
            // For help command, suggest all available commands
            completions = Object.keys(COMMANDS).filter(cmd => cmd !== 'help' && cmd !== 'exit' && cmd !== 'quit' && cmd !== 'clear');
        } else if (context === 'cloud-sub') {
            // Cloud sub-subcommands
            const cloudSubcommand = words[1];
            const cloudSubSubcommands = {
                'host': ['add', 'remove', 'list'],
                'repo': ['add', 'remove', 'list'],
                'agent': ['list', 'info', 'start', 'stop', 'restart'],
                'admin': ['add', 'password']
            };
            completions = cloudSubSubcommands[cloudSubcommand] || [];
        } else if (context === 'args') {
            const subcommand = words[1];
            if ((command === 'shell') ||
                (command === 'cli') ||
                (command === 'reinstall' && (subcommand === 'agent' || words.length <= 2)) ||
                (command === 'enable' && subcommand === 'agent') ||
                (command === 'client' && ['methods', 'status', 'task', 'task-status'].includes(subcommand))) {
                completions = getAgentNames();
            } else if (command === 'update') {
                const repos = getRepoNames();
                if (words.length <= 2) {
                    completions = ['all', 'repos', 'repo', ...repos];
                } else if (subcommand === 'repo' || subcommand === 'repository') {
                    completions = repos;
                } else {
                    completions = repos;
                }
            } else if (command === 'logs' && subcommand === 'tail') {
                completions = ['router'];
            } else if (command === 'logs' && subcommand === 'last') {
                // may accept count then optional type; if third token, suggest type
                if (words.length >= 4) completions = ['router'];
            } else if (command === 'expose') {
                // expose <EXPOSED> <$VAR|value> <agent>
                if (words.length >= 4) completions = getAgentNames();
            } else if (command === 'disable') {
                if (subcommand === 'sandbox') {
                    completions = [];
                } else {
                    completions = [...new Set(['sandbox', 'agents-all', ...getAgentNames()])];
                }
            } else if (command === 'enable' && subcommand === 'sandbox') {
                completions = [];
            } else if (command === 'remove' || command === 'uninstall') {
                completions = getRepoNames();
            } else if (command === 'add' || command === 'install') {
                completions = [];
            } else if (command === 'sandbox') {
                completions = COMMANDS.sandbox;
            } else if (command === 'default-skills') {
                const predefined = Object.keys(getPredefinedRepos() || {});
                completions = Array.from(new Set([...getRepoNames(), ...predefined])).sort();
            } else if (command === 'help' && subcommand) {
                // For help <command>, show subcommands of that command
                if (COMMANDS[subcommand]) {
                    completions = COMMANDS[subcommand];
                }
            } else {
                // Don't show files for most internal commands
                completions = [];
            }
        }

        if (context === 'commands') {
            completions = Object.keys(COMMANDS);
        }
    } else {
        // Not a known Ploinky command, could be a system command or need file completion
        if (words.length === 0 || (words.length === 1 && !line.endsWith(' '))) {
            // First word - could be a command
            completions = Object.keys(COMMANDS);
        } else {
            // Treat as file path for unknown commands
            context = 'files';
        }
    }

    // File path completion
    if (context === 'files') {
        try {
            // Parse the path to complete
            let pathToComplete = lineFragment;
            let dirPath = '.';
            let filePrefix = '';

            if (pathToComplete.includes('/')) {
                const lastSlash = pathToComplete.lastIndexOf('/');
                dirPath = pathToComplete.substring(0, lastSlash) || '.';
                filePrefix = pathToComplete.substring(lastSlash + 1);
            } else {
                filePrefix = pathToComplete;
            }

            // Resolve ~ to home directory
            if (dirPath.startsWith('~')) {
                dirPath = dirPath.replace('~', process.env.HOME || process.env.USERPROFILE);
            }

            // Read directory contents
            if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
                const files = fs.readdirSync(dirPath);
                const matchingFiles = files
                    .filter(f => f.startsWith(filePrefix))
                    .map(f => {
                        const fullPath = path.join(dirPath, f);
                        const isDir = fs.statSync(fullPath).isDirectory();
                        // Reconstruct the path as it should appear in completion
                        if (pathToComplete.includes('/')) {
                            const prefix = pathToComplete.substring(0, pathToComplete.lastIndexOf('/') + 1);
                            return prefix + f + (isDir ? '/' : '');
                        }
                        return f + (isDir ? '/' : '');
                    });
                completions = matchingFiles;
            }
        } catch (err) {
            // If file reading fails, fall back to no completions
            debugLog('File completion error:', err.message);
        }
    }

    const hits = completions.filter((c) => c.startsWith(lineFragment));

    // If there's a single, exact match, add a space only if it's not a directory
    if (hits.length === 1 && hits[0] === lineFragment && !lineFragment.endsWith('/')) {
        return [[hits[0] + ' '], lineFragment];
    }

    return [hits, lineFragment];
}


function getRelativePath() {
    const home = process.env.HOME || process.env.USERPROFILE;
    const cwd = process.cwd();

    if (cwd === home) {
        return '~';
    } else if (cwd.startsWith(home)) {
        return '~' + cwd.slice(home.length);
    } else {
        return cwd;
    }
}

function getColoredPrompt() {
    // ANSI color codes
    const reset = '\x1b[0m';
    const bold = '\x1b[1m';
    const cyan = '\x1b[36m';
    const blue = '\x1b[34m';
    const green = '\x1b[32m';
    const magenta = '\x1b[35m';

    // Bold magenta for "ploinky", cyan for path, green for ">"
    return `${bold}${magenta}ploinky${reset} ${cyan}${getRelativePath()}${reset}${green}>${reset} `;
}

function startInteractiveMode() {
    // Ensure clean TTY state when entering interactive mode
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        try { process.stdin.setRawMode(false); } catch (_) {}
    }
    const restoreTTY = () => {
        try {
            if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
                process.stdin.setRawMode(false);
            }
            // Show cursor and reset attributes just in case
            try { process.stdout.write('\x1b[?25h\x1b[0m'); } catch(_) {}
        } catch(_) {}
    };
    // Keep CLI history under workspace .ploinky/
    const historyPath = HISTORY_FILE;
    let history = [];
    try {
        if (fs.existsSync(historyPath)) {
            // Read history and keep it in original order for readline
            // readline expects newest commands first in the array
            const lines = fs.readFileSync(historyPath, 'utf-8').split('\n').filter(Boolean);
            history = lines.slice(-1000).reverse(); // Keep last 1000 commands, newest first
        }
    } catch (e) {
        debugLog('Could not read history file:', e.message);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: getColoredPrompt(),
        history: history,
        historySize: 1000,
        completer: process.stdin.isTTY ? completer : undefined // Only use completer in TTY mode
    });
    inputState.registerInterface?.(rl);
    enableMultilineNavigation(rl);

    const cleanupAndExit = () => {
        try { cleanupCliSessions(); } catch (_) {}
        try { inputState.registerInterface?.(null); } catch (_) {}
        restoreTTY();
        try { rl.close(); } catch(_) {}
        process.exit(0);
    };

    // Handle signals to restore TTY
    try {
        process.on('SIGINT', () => cleanupAndExit());
        process.on('SIGTERM', () => cleanupAndExit());
        process.on('uncaughtException', (err) => { try { console.error(err); } catch(_) {}; cleanupAndExit(); });
        process.on('exit', () => { try { restoreTTY(); } catch(_) {} });
    } catch(_) {}

    rl.on('line', async (line) => {
        // If input is suspended (e.g., password prompt), ignore this line
        if (inputState.isSuspended()) {
            return;
        }
        const trimmedLine = line.trim();
            if (trimmedLine) {
            if (trimmedLine === 'exit' || trimmedLine === 'quit') { return cleanupAndExit(); }
            // Append to history file immediately
            try {
                fs.appendFileSync(historyPath, trimmedLine + '\n');
            } catch (e) {
                debugLog('Could not write to history file:', e.message);
            }
            await runReplCommand({
                args: trimmedLine.split(/\s+/),
                rl,
                handleCommandImpl: handleCommand,
                getPromptImpl: getColoredPrompt,
                onError: (error) => {
                    console.error(`Error: ${error.message}`);
                    debugLog(`Command error details: ${error.stack}`);
                },
            });
        } else if (process.stdin.isTTY) {
            rl.prompt();
        }
    }).on('close', async () => { restoreTTY(); try { cleanupCliSessions(); } catch (_) {} try { inputState.registerInterface?.(null); } catch (_) {} if (process.stdin.isTTY) { console.log('Bye.'); } process.exit(0); });

    // Ensure Ctrl-D (EOF) closes the CLI gracefully
    try {
        rl.input.on('end', () => { try { restoreTTY(); rl.close(); } catch(_) {} });
        process.stdin.on('end', () => { try { restoreTTY(); rl.close(); } catch(_) {} });
    } catch(_) {}

    // If input is not a TTY, we are in script mode. Don't show initial prompt.
    if (process.stdin.isTTY) {
        console.log('Welcome to Ploinky interactive mode.');
        console.log("Type 'help' for a list of commands. Use 'exit' to leave, 'shutdown' to close session containers, or 'destroy' to remove workspace containers while leaving the outer runtime running.");
        rl.prompt();
    }
}

export async function runCoreCli(args = []) {
    assertRuntimeDependencies();
    logPloinkyDirectory();
    const debug = parseCoreDebugArguments(args);
    args = debug.argv;

    if (debug.enabled) {
        setDebugMode(true);
        console.log('[INFO] Debug mode enabled.');
    }

    debugLog('Raw arguments:', args);
    const runtimeAdmissionOwned = commandOwnsRuntimeAdmission(args);
    if (!runtimeAdmissionOwned) initEnvironment();
    let startParsed;
    let branchPolicy;
    if (args.length && args[0] === 'start') {
        try {
            startParsed = parseStartArgs(args.slice(1));
            branchPolicy = startParsed.branchPolicy;
        } catch (_) {}
    }
    if (!runtimeAdmissionOwned) {
        try {
            bootstrap({ branchPolicy, staticAgent: startParsed?.staticAgent });
        } catch (error) {
            if (branchPolicy?.fallback === 'fail') throw error;
        }
    }

    if (args.length === 0) return startInteractiveMode();
    return handleCommand(args);
}

export function parseCoreDebugArguments(rawArgs = []) {
    const args = [...rawArgs];
    const leadingCommandIndex = args.findIndex((arg) => arg !== '--debug' && arg !== '-d');
    const command = leadingCommandIndex >= 0 ? args[leadingCommandIndex] : '';
    const debugIndex = command === 'cli'
        ? args.findIndex((arg, index) => index < leadingCommandIndex && (arg === '--debug' || arg === '-d'))
        : args.findIndex((arg) => arg === '--debug' || arg === '-d');
    if (debugIndex < 0) {
        return { argv: args, enabled: false };
    }
    args.splice(debugIndex, 1);
    return { argv: args, enabled: true };
}
