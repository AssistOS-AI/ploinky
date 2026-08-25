#!/usr/bin/env node

import readline from 'readline';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import {
    suggestCommandWithLLM,
    extractSingleCommandFromSuggestion,
    formatValidApiKeyList,
    promptToExecuteSuggestedCommand,
    handleSystemCommand,
    resetLlmInvokerCache,
} from './commands/llmSystemCommands.js';
import { bootstrapAgentLibRuntime } from '../agentlib/bootstrap.mjs';
import { importAgentLib } from '../agentlib/runtime.mjs';
import {
    loadValidLlmApiKeys,
    collectAvailableLlmKeys,
    populateProcessEnvFromEnvFile,
    resolveEnvFilePath,
} from './commands/llmProviderUtils.js';
import { loadSoulModelCatalog, runSettingsMenu } from './commands/settingsMenu.js';
import { getSecret } from './utils/security/secretInjector.js';
import * as inputState from './commands/inputState.js';

const WORKSPACE_ENV_FILENAME = '.env';
const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_MAGENTA = '\x1b[35m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BLUE = '\x1b[34m';
const SHELL_TAG = `${ANSI_BOLD}${ANSI_MAGENTA}[Ploinky Shell]${ANSI_RESET}`;
const SETTINGS_COMMAND = '/settings';
const SETTINGS_ALIAS = 'settings';
const SHELL_COMMANDS = [SETTINGS_COMMAND, SETTINGS_ALIAS, '/help', 'help'];
let envInfoLogged = false;
let modelsInfoLogged = false;
let cachedKeyState = null;

function resetEnvCaches() {
    cachedKeyState = null;
    envInfoLogged = false;
    modelsInfoLogged = false;
    resetLlmInvokerCache();
}

function maskApiKey(value) {
    const trimmed = (value || '').trim();
    if (!trimmed) return '';
    if (trimmed.length <= 8) {
        return `${trimmed.slice(0, 2)}****${trimmed.slice(-2)}`;
    }
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function printUsage() {
    console.log('Ploinky Shell only provides LLM-based command recommendations.');
    console.log('Usage:');
    console.log('  ploinky -l                   # Interactive shell mode');
    console.log('  ploinky -l <command or text> # Single recommendation and exit');
}

function printShellHelp() {
    console.log('Ploinky Shell commands:');
    console.log('  /settings   Open the interactive settings menu for model/tag selectors');
    console.log('  /help, help Show this help');
    console.log('All other input is sent to the LLM for command recommendations.');
}

async function ensureLlmKeyAvailability() {
    if (cachedKeyState) return cachedKeyState;
    const envPath = resolveEnvFilePath(process.cwd());
    populateProcessEnvFromEnvFile(envPath);
    const availableKeys = collectAvailableLlmKeys(envPath);
    const validKeys = loadValidLlmApiKeys();
    cachedKeyState = {
        availableKeys,
        validKeys,
        ok: availableKeys.length > 0,
        envPath,
    };
    return cachedKeyState;
}

async function handleSetEnv() {
    await runSettingsMenu({
        onEnvChange: () => {
            resetEnvCaches();
        }
    });
    // Refresh cache with new values for subsequent calls
    cachedKeyState = null;
    await ensureLlmKeyAvailability();
    if (process.stdin.isTTY) {
        try {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
        } catch (_) { /* ignore */ }
    }
    await logCurrentModelChoice();
}

function showMissingKeyMessage(validKeys) {
    const validKeysList = formatValidApiKeyList(validKeys);
    console.log(`[Ploinky Shell] No LLM API key configured. Add one of ${validKeysList} to ${WORKSPACE_ENV_FILENAME} or export it as an environment variable before retrying.`);
}

async function logAvailableModels(availableKeys = []) {
    if (modelsInfoLogged) return;
    modelsInfoLogged = true;
    try {
        const catalog = await loadSoulModelCatalog();
        const combined = (catalog.models || []).map((entry) => ({
            name: entry?.name,
            provider: entry?.providerKey || 'unknown',
            tags: Array.isArray(entry?.tags) ? entry.tags : [],
        })).filter((entry) => entry?.name);
        const grouped = combined.reduce((acc, entry) => {
            const provider = entry.provider || 'unknown';
            if (!acc[provider]) acc[provider] = [];
            const tags = entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
            acc[provider].push(`${entry.name}${tags}`);
            return acc;
        }, {});

        if (catalog.warning) {
            console.log(`${SHELL_TAG} ${ANSI_YELLOW}${catalog.warning}${ANSI_RESET}`);
            return;
        }

        const providerNames = Object.keys(grouped);
        if (providerNames.length) {
            const segments = providerNames.sort().map((provider) => {
                const models = grouped[provider] || [];
                return `${provider}: ${models.join(', ')}`;
            });
            console.log(`${SHELL_TAG} ${ANSI_GREEN}Available LLM models (by key):${ANSI_RESET} ${segments.join(' | ')}`);
        } else {
            console.log(`${SHELL_TAG} ${ANSI_YELLOW}No LLM models available for the detected API keys.${ANSI_RESET}`);
        }
    } catch (error) {
        console.log(`${SHELL_TAG} ${ANSI_YELLOW}Failed to list LLM models: ${error?.message || error}${ANSI_RESET}`);
    }
}

async function logCurrentModelChoice() {
    try {
        const configured = String(getSecret('ACHILLES_MODEL_PLAN') || '').trim();
        // Loaded lazily from the one selected achillesAgentLib source, after
        // the launcher has established the runtime contract.
        const { getPrioritizedModels } = await importAgentLib('utils/LLMClient.mjs');
        const prioritized = await getPrioritizedModels(configured || null);
        const current = Array.isArray(prioritized) && prioritized.length ? prioritized[0] : null;
        if (current) {
            console.log(`${SHELL_TAG} ${ANSI_GREEN}Current LLM model:${ANSI_RESET} ${current}`);
        } else {
            console.log(`${SHELL_TAG} ${ANSI_YELLOW}No LLM model available for current settings.${ANSI_RESET}`);
        }
    } catch (error) {
        console.log(`${SHELL_TAG} ${ANSI_YELLOW}Unable to resolve current LLM model: ${error?.message || error}${ANSI_RESET}`);
    }
}

function logEnvDetails(envPath) {
    if (envInfoLogged) return;
    envInfoLogged = true;
    const validKeys = new Set(loadValidLlmApiKeys());
    console.log('');
    if (envPath) {
        const label = fs.existsSync(envPath) ? 'Resolved .env' : 'No .env found';
        console.log(`${SHELL_TAG} ${ANSI_CYAN}${label}${ANSI_RESET} ${ANSI_DIM}${envPath}${ANSI_RESET}`);
    } else {
        console.log(`${SHELL_TAG} ${ANSI_CYAN}No .env path resolved.${ANSI_RESET}`);
    }

    const envKeyLines = Array.from(validKeys).map((key) => {
        const value = getSecret(key);
        if (typeof value !== 'string' || !value.trim()) return null;
        return `${key}=${maskApiKey(value)}`;
    }).filter(Boolean);
    if (envKeyLines.length) {
        console.log(`${SHELL_TAG} ${ANSI_YELLOW}LLM API keys in use:${ANSI_RESET} ${envKeyLines.join(', ')}`);
    } else {
        console.log(`${SHELL_TAG} ${ANSI_YELLOW}No LLM API keys detected in environment.${ANSI_RESET}`);
    }

    const debugVars = [
        'ACHILLES_DEBUG',
        'ACHILLES_MODEL_PLAN',
        'ACHILLES_MODEL_CODE',
    ];
    const activeDebugVars = debugVars
        .map((key) => [key, getSecret(key)])
        .filter(([, value]) => typeof value === 'string' && value.trim().length);
    if (activeDebugVars.length) {
        const flags = activeDebugVars.map(([key, value]) => `${key}=${value}`);
        console.log(`${SHELL_TAG} ${ANSI_BLUE}Debug/override flags:${ANSI_RESET} ${flags.join(', ')}`);
    }
    console.log('');
}

function getRelativePath() {
    const home = process.env.HOME || process.env.USERPROFILE;
    const cwd = process.cwd();
    if (home && cwd === home) return '~';
    if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
    return cwd;
}

function getColoredPrompt() {
    return `${ANSI_BOLD}${ANSI_MAGENTA}ploinky-shell${ANSI_RESET} ${ANSI_CYAN}${getRelativePath()}${ANSI_RESET}${ANSI_GREEN}>${ANSI_RESET} `;
}

function shellCompleter(line) {
    const words = line.split(/\s+/).filter(Boolean);
    const lineFragment = line.endsWith(' ') ? '' : (words[words.length - 1] || '');
    const commands = Array.from(new Set(SHELL_COMMANDS));

    // If we're typing the first token, suggest only shell commands (no file paths).
    if (words.length <= 1 && !line.endsWith(' ')) {
        const hits = commands.filter((cmd) => cmd.startsWith(lineFragment));
        return [hits, lineFragment];
    }

    // If the first token is a known shell command, no further completion.
    const firstToken = words[0];
    if (commands.includes(firstToken)) {
        return [[], lineFragment];
    }

    // Otherwise, fall back to file path completion for non-shell commands/text.
    let completions = [];

    // Complete file/dir paths based on the last fragment
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

    if (dirPath.startsWith('~')) {
        dirPath = dirPath.replace('~', process.env.HOME || process.env.USERPROFILE);
    }

    try {
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
            const files = fs.readdirSync(dirPath);
            const fileMatches = files
                .filter((f) => f.startsWith(filePrefix))
                .map((f) => {
                    const fullPath = path.join(dirPath, f);
                    const isDir = fs.statSync(fullPath).isDirectory();
                    if (pathToComplete.includes('/')) {
                        const prefix = pathToComplete.substring(0, pathToComplete.lastIndexOf('/') + 1);
                        return prefix + f + (isDir ? '/' : '');
                    }
                    return f + (isDir ? '/' : '');
                });
            completions = [...new Set([...completions, ...fileMatches])];
        }
    } catch (_) {
        completions = [...new Set(completions)];
    }

    const hits = completions.filter((c) => c.startsWith(lineFragment));
    if (hits.length === 1 && hits[0] === lineFragment && !lineFragment.endsWith('/')) {
        return [[hits[0] + ' '], lineFragment];
    }
    return [hits, lineFragment];
}

function renderLlmSuggestion(llmResult) {
    if (!llmResult?.status) {
        console.log('No suggestion received from the LLM. Try rephrasing your request.');
        return { ok: false, singleCommand: null };
    }

    if (llmResult.status === 'ok' && llmResult.suggestion) {
        const singleCommand = extractSingleCommandFromSuggestion(llmResult.suggestion);
        if (!singleCommand) {
            console.log('LLM suggested:');
            console.log(llmResult.suggestion);
        }
        return { ok: true, singleCommand };
    }

    if (llmResult.status === 'error' && llmResult.error) {
        if (llmResult.error.code === 401) {
            console.log('LLM call failed: API key invalid.');
        } else {
            console.log(`LLM call failed: ${llmResult.error.message}`);
        }
        return { ok: false, singleCommand: null };
    }

    console.log('No suggestion received from the LLM. Try rephrasing your request.');
    return { ok: false, singleCommand: null };
}

async function runSuggestedCommand(commandText) {
    const trimmedSuggestion = (commandText || '').trim();
    if (!trimmedSuggestion) return;
    const shellMetaPattern = /[|&;<>(){}\[\]`$]/;
    if (shellMetaPattern.test(trimmedSuggestion)) {
        console.log(`[LLM] Executing shell command: ${trimmedSuggestion}`);
        await new Promise((resolve) => {
            const restoreInput = inputState.prepareForExternalCommand?.() || (() => {});
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                try { restoreInput(); } catch (_) {}
                resolve();
            };
            let child;
            try {
                child = spawn(process.env.SHELL || 'bash', ['-lc', trimmedSuggestion], { stdio: 'inherit' });
            } catch (error) {
                console.error(`[LLM] Failed to start suggested command: ${error?.message || error}`);
                finish();
                return;
            }
            child.on('exit', (code) => {
                if (code && code !== 0) {
                    console.error(`[LLM] Command exited with code ${code}`);
                }
                finish();
            });
            child.on('error', (error) => {
                console.error(`[LLM] Failed to run suggested command: ${error?.message || error}`);
                finish();
            });
        });
        return;
    }

    const argsToRun = trimmedSuggestion.split(/\s+/).filter(Boolean);
    if (!argsToRun.length) return;
    await new Promise((resolve) => {
        const restoreInput = inputState.prepareForExternalCommand?.() || (() => {});
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            try { restoreInput(); } catch (_) {}
            resolve();
        };
        let child;
        try {
            child = spawn(argsToRun[0], argsToRun.slice(1), { stdio: 'inherit' });
        } catch (error) {
            console.error(`[LLM] Failed to start suggested command: ${error?.message || error}`);
            finish();
            return;
        }
        child.on('exit', (code) => {
            if (code && code !== 0) {
                console.error(`[LLM] Command exited with code ${code}`);
            }
            finish();
        });
        child.on('error', (error) => {
            console.error(`[LLM] Failed to run suggested command: ${error?.message || error}`);
            finish();
        });
    });
}

async function handleUserInput(rawInput) {
    const normalized = (rawInput || '').trim();
    if (!normalized) {
        console.log('Enter a command or question to get an LLM recommendation.');
        return false;
    }

    if (normalized === '/help' || normalized === 'help') {
        printShellHelp();
        return true;
    }

    if (normalized === SETTINGS_COMMAND || normalized === SETTINGS_ALIAS) {
        await handleSetEnv();
        return true;
    }

    // Attempt to run as a system command first (mirrors main CLI behavior)
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length) {
        const [cmd, ...options] = parts;
        const handled = await handleSystemCommand(cmd, options);
        if (handled) return true;
    }

    const keyState = await ensureLlmKeyAvailability();
    if (!keyState.ok) {
        showMissingKeyMessage(keyState.validKeys);
        return false;
    }

    console.log('Asking the LLM for guidance...');
    const llmResult = await suggestCommandWithLLM(normalized);
    const { ok, singleCommand } = renderLlmSuggestion(llmResult);
    if (!ok) {
        return false;
    }

    if (singleCommand) {
        if (process.stdin.isTTY) {
            const shouldExecute = await promptToExecuteSuggestedCommand(singleCommand);
            if (shouldExecute) {
                await runSuggestedCommand(singleCommand);
            }
        } else {
            console.log('LLM suggested command:');
            console.log(singleCommand);
        }
    }

    return true;
}

function startInteractiveMode() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: process.stdin.isTTY ? shellCompleter : undefined,
        prompt: getColoredPrompt(),
    });
    inputState.registerInterface?.(rl);
    ensureLlmKeyAvailability()
        .then((state) => {
            const envPath = state?.envPath || resolveEnvFilePath(process.cwd());
            logEnvDetails(envPath);
            return logAvailableModels(state?.availableKeys || []);
        })
        .catch(() => {});

    console.log('Ploinky Shell mode. Ploinky commands are disabled; only LLM recommendations are available. Type \'exit\' or \'quit\' to leave.');
    logCurrentModelChoice()
        .catch(() => {})
        .finally(() => {
            rl.prompt();
        });

    rl.on('line', async (line) => {
        if (inputState.isSuspended && inputState.isSuspended()) {
            return;
        }
        const trimmed = (line || '').trim();
        if (trimmed === 'exit' || trimmed === 'quit') {
            rl.close();
            return;
        }
        await handleUserInput(trimmed);
        rl.setPrompt(getColoredPrompt());
        rl.prompt();
    });

    rl.on('SIGINT', () => {
        try { process.stdout.write('\n'); } catch (_) {}
        rl.close();
    });

    rl.on('close', () => {
        inputState.registerInterface?.(null);
        process.exit(0);
    });
}

async function main() {
    const args = process.argv.slice(2);
    const state = await ensureLlmKeyAvailability();
    const envPath = state?.envPath || resolveEnvFilePath(process.cwd());
    logEnvDetails(envPath);
    await logAvailableModels(state?.availableKeys || []);
    if (args.includes('-h') || args.includes('--help')) {
        printUsage();
        return;
    }

    if (args.join(' ').trim() === SETTINGS_COMMAND || args.join(' ').trim() === SETTINGS_ALIAS) {
        await handleSetEnv();
        process.exit(0);
    }

    if (args.length === 0) {
        startInteractiveMode();
        return;
    }

    await logCurrentModelChoice();

    const inlineInput = args.join(' ');
    const ok = await handleUserInput(inlineInput);
    process.exit(ok ? 0 : 1);
}

// The shell surfaces LLM recommendations, so it needs the same AgentLib runtime
// contract the core CLI establishes before importing framework code.
bootstrapAgentLibRuntime()
    .then(() => main())
    .catch((error) => {
        console.error(`ploinky-shell failed: ${error?.message || error}`);
        process.exit(1);
    });
