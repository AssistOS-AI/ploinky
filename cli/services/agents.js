import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadAgents, saveAgents } from './workspace.js';
import { resolveMasterKey, setUsersPayload } from './encryptedPasswordStore.js';
import { hashPassword } from './localAuthPasswords.js';
import {
    getAgentContainerName,
    parseManifestPorts,
    containerExists,
    isContainerRunning,
    collectLiveAgentContainers
} from './docker/index.js';
import { findAgent } from './utils.js';
import { REPOS_DIR, PLOINKY_WORKSPACE_ROOT } from './config.js';
import {
    createAgentSymlinks,
    removeAgentSymlinks,
    createAgentWorkDir,
    removeAgentWorkDir,
    getAgentWorkDir
} from './workspaceStructure.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESERVED_AGENT_KEYS = new Set(['_config']);
const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const AUTH_MODES = new Set(['none', 'local', 'pwd', 'sso', 'guest']);

function isPathUnderRoot(candidate) {
    if (!candidate) return false;
    const root = path.resolve(PLOINKY_WORKSPACE_ROOT);
    const resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeExistingProjectPath(candidate, runMode) {
    if (!candidate || typeof candidate !== 'string') return '';
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) return '';
    if ((runMode || 'isolated') === 'isolated' && !isPathUnderRoot(resolved)) {
        return '';
    }
    return resolved;
}

function normalizeAlias(aliasInput) {
    if (aliasInput === undefined || aliasInput === null) {
        return '';
    }
    if (typeof aliasInput === 'string' && !aliasInput.trim()) {
        return '';
    }
    const alias = String(aliasInput).trim();
    if (!alias) return '';
    if (!ALIAS_PATTERN.test(alias)) {
        throw new Error("Alias must start with a letter or number and may contain only letters, numbers, '.', '_' or '-'.");
    }
    if (RESERVED_AGENT_KEYS.has(alias)) {
        throw new Error(`Alias '${alias}' is reserved. Choose a different alias.`);
    }
    return alias;
}

function normalizeAuthMode(authMode) {
    const normalized = String(authMode || 'none').trim().toLowerCase();
    if (!AUTH_MODES.has(normalized)) {
        throw new Error(`Unknown auth mode '${authMode}'. Allowed: none | pwd | sso`);
    }
    return normalized === 'pwd' ? 'local' : normalized;
}

function buildDefaultLocalAuthVars(routeKey) {
    const suffix = String(routeKey || 'agent')
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase() || 'AGENT';
    return {
        usersVar: `PLOINKY_AUTH_${suffix}_USERS`
    };
}

function parsePloinkyDirectives(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue.flatMap((item) => parsePloinkyDirectives(item)).filter(Boolean);
    }
    if (typeof rawValue !== 'string') {
        return [];
    }
    return rawValue
        .split(/[,\n;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

function normalizeManifestPwdUsers(manifest) {
    const users = Array.isArray(manifest?.pwd?.users) ? manifest.pwd.users : [];
    return users
        .map((entry) => {
            const username = String(entry?.username ?? entry?.user ?? '').trim();
            const password = String(entry?.password ?? '');
            const name = String(entry?.name ?? username).trim();
            const email = String(entry?.email ?? '').trim();
            const roles = Array.isArray(entry?.roles) ? entry.roles.map((role) => String(role || '').trim()).filter(Boolean) : [];
            if (!username || !password) {
                return null;
            }
            return {
                id: `local:${username}`,
                username,
                name: name || username,
                email: email || null,
                passwordHash: hashPassword(password),
                roles: roles.length ? Array.from(new Set(['local', ...roles])) : ['local'],
                rev: 1
            };
        })
        .filter(Boolean);
}

function resolveManifestAuthMode(manifest) {
    if (manifest?.guest === true) {
        return 'guest';
    }
    const ploinkyDirectives = parsePloinkyDirectives(manifest?.ploinky);
    if (ploinkyDirectives.includes('pwd enable')) {
        return 'local';
    }
    if (ploinkyDirectives.includes('sso enable')) {
        return 'sso';
    }
    return 'none';
}

function normalizeEnableArgs(agentName, mode, repoNameParam) {
    if (typeof agentName !== 'string') {
        return { agentName, mode, repoNameParam };
    }
    const trimmed = agentName.trim();
    if (!trimmed) {
        return { agentName: trimmed, mode, repoNameParam };
    }
    if (mode) {
        return { agentName: trimmed, mode, repoNameParam };
    }

    let parsedAgent = trimmed;
    let parsedMode = mode;
    let parsedRepo = repoNameParam;

    const spaceTokens = trimmed.split(/\s+/).filter(Boolean);
    if (spaceTokens.length > 1) {
        const candidateMode = spaceTokens[1].toLowerCase();
        if (candidateMode === 'global' || candidateMode === 'devel') {
            parsedAgent = spaceTokens[0];
            parsedMode = candidateMode;
            if (candidateMode === 'devel' && parsedRepo === undefined) {
                const remainder = spaceTokens.slice(2).join(' ').trim();
                if (remainder) parsedRepo = remainder;
            }
        }
    }

    if (parsedMode) {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const target = trimmed.slice(0, colonIndex).trim();
    const remainder = trimmed.slice(colonIndex + 1).trim();
    if (!target || !remainder) {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const tokens = remainder.split(/\s+/).filter(Boolean);
    if (!tokens.length) {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const inferredMode = tokens[0].toLowerCase();
    if (inferredMode !== 'global' && inferredMode !== 'devel') {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const repoFromDirective = tokens.slice(1).join(' ');
    return {
        agentName: target,
        mode: inferredMode,
        repoNameParam: inferredMode === 'devel'
            ? (repoNameParam !== undefined ? repoNameParam : repoFromDirective)
            : (repoNameParam !== undefined ? repoNameParam : undefined)
    };
}

export function enableAgent(agentName, mode, repoNameParam, aliasParam, authModeParam, authOptions = {}) {
    const normalized = normalizeEnableArgs(agentName, mode, repoNameParam);
    const { manifestPath, repo: repoName, shortAgentName } = findAgent(normalized.agentName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const agentPath = path.dirname(manifestPath);
    const alias = normalizeAlias(aliasParam);
    const map = loadAgents();
    if (alias) {
        const aliasExists = Object.entries(map || {}).some(([key, value]) => {
            if (key === alias) return true;
            return value && value.type === 'agent' && value.alias === alias;
        });
        if (aliasExists) {
            throw new Error('alias already exists');
        }
    }
    const containerBaseName = alias || shortAgentName;
    const containerName = getAgentContainerName(containerBaseName, repoName);
    const routeKey = alias || shortAgentName;
    const authMode = authModeParam === undefined || authModeParam === null || String(authModeParam).trim() === ''
        ? resolveManifestAuthMode(manifest)
        : normalizeAuthMode(authModeParam);
    const manifestPwdUsers = normalizeManifestPwdUsers(manifest);
    const username = typeof authOptions?.username === 'string' && authOptions.username.trim()
        ? authOptions.username.trim()
        : '';
    const password = typeof authOptions?.password === 'string' && authOptions.password.length
        ? authOptions.password
        : '';
    const profile = typeof authOptions?.profile === 'string' && authOptions.profile.trim()
        ? authOptions.profile.trim().toLowerCase()
        : '';
    if ((username || password) && authMode !== 'local') {
        throw new Error('The --user and --password options are only valid with --auth pwd.');
    }
    if ((username && !password) || (!username && password)) {
        throw new Error('Use --user and --password together.');
    }

    const normalizedMode = (normalized.mode || '').toLowerCase();
    let runMode = 'isolated';
    let projectPath = '';

    if (!normalizedMode || normalizedMode === 'default') {
        try {
            const existing = Object.values(map || {}).find(
                r => r && r.type === 'agent' && r.agentName === shortAgentName && r.repoName === repoName && !r.alias
            );
            if (existing && (!existing.runMode || existing.runMode === 'isolated') && existing.projectPath) {
                const normalizedPath = normalizeExistingProjectPath(existing.projectPath, existing.runMode || 'isolated');
                if (normalizedPath) {
                    projectPath = normalizedPath;
                    runMode = 'isolated';
                }
            }
        } catch (_) {}
        if (!projectPath) {
            runMode = 'isolated';
            // Use workspace structure: $PLOINKY_WORKSPACE_ROOT/.ploinky/agents/<agentName>/
            projectPath = getAgentWorkDir(shortAgentName);
            try { fs.mkdirSync(projectPath, { recursive: true }); } catch (_) {}
        }
    } else if (normalizedMode === 'global') {
        runMode = 'global';
        projectPath = PLOINKY_WORKSPACE_ROOT;
    } else if (normalizedMode === 'devel') {
        const repoCandidate = String(normalized.repoNameParam || '').trim();
        if (!repoCandidate) {
            throw new Error("enable agent devel: missing repoName. Usage: enable agent <name> devel <repoName>");
        }
        const repoPath = path.join(REPOS_DIR, repoCandidate);
        if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
            throw new Error(`Repository '${repoCandidate}' not found in ${path.join(REPOS_DIR)}`);
        }
        runMode = 'devel';
        projectPath = repoPath;
    } else {
        const errorMode = normalized.mode || mode || '';
        throw new Error(`Unknown mode '${errorMode}'. Allowed: global | devel`);
    }

    // Parse port mappings from manifest
    const { portMappings } = parseManifestPorts(manifest);
    // If no ports specified, use default 7000
    const ports = portMappings.length > 0 ? portMappings : [{ containerPort: 7000 }];
    
    const record = {
        agentName: shortAgentName,
        repoName,
        containerImage: manifest.container || manifest.image || 'node:18-alpine',
        createdAt: new Date().toISOString(),
        projectPath,
        runMode,
        develRepo: runMode === 'devel' ? String(normalized.repoNameParam || '') : undefined,
        type: 'agent',
        config: {
            binds: [
                { source: projectPath, target: projectPath },
                { source: path.resolve(__dirname, '../../../Agent'), target: '/Agent' },
                { source: agentPath, target: '/code' }
            ],
            env: [],
            ports
        }
    };
    if (authMode === 'local') {
        resolveMasterKey();
        record.auth = {
            mode: authMode,
            ...buildDefaultLocalAuthVars(routeKey)
        };
        if (username && password) {
            setUsersPayload(record.auth.usersVar, {
                version: 1,
                users: [{
                    id: `local:${username}`,
                    username,
                    name: username,
                    email: null,
                    passwordHash: hashPassword(password),
                    roles: ['local', 'admin'],
                    rev: 1
                }]
            });
        } else if (manifestPwdUsers.length) {
            setUsersPayload(record.auth.usersVar, {
                version: 1,
                users: manifestPwdUsers
            });
        }
    } else {
        record.auth = { mode: authMode };
    }
    if (alias) {
        record.alias = alias;
    }
    if (profile) {
        record.profile = profile;
    }

    for (const key of Object.keys(map)) {
        if (RESERVED_AGENT_KEYS.has(key)) continue;
        if (!map[key] || typeof map[key] !== 'object') continue;
        if (alias && key === containerName) continue;
        const r = map[key];
        if (!r || r.type !== 'agent') continue;
        const sameAgent = r.agentName === shortAgentName && r.repoName === repoName;
        if (!sameAgent) continue;
        if (alias || r.alias) continue;
        if (key === containerName) continue;
        try { delete map[key]; } catch (_) {}
    }
    map[containerName] = record;
    saveAgents(map);

    // Create workspace structure for the agent
    try {
        // Create agent working directory: $PLOINKY_WORKSPACE_ROOT/.ploinky/agents/<agentName>/
        createAgentWorkDir(shortAgentName);

        // Create symlinks: $PLOINKY_WORKSPACE_ROOT/.ploinky/code/<agentName> and .ploinky/skills/<agentName>
        createAgentSymlinks(shortAgentName, repoName, agentPath);
    } catch (err) {
        console.error(`Warning: Failed to create workspace structure for ${shortAgentName}: ${err.message}`);
    }

    return { containerName, repoName, shortAgentName, alias: alias || undefined, auth: record.auth };
}

export function disableAgent(agentRef) {
    const input = typeof agentRef === 'string' ? agentRef.trim() : '';
    if (!input) {
        throw new Error("disable agent: missing agent name. Usage: disable <agentName>");
    }

    const hasNamespace = /[:/]/.test(input);
    let targetRepo = null;
    let targetAgent = input;

    if (hasNamespace) {
        const parts = input.split(/[:/]/).filter(Boolean);
        if (parts.length !== 2) {
            throw new Error(`disable agent: invalid identifier '${input}'. Use <repo>/<agent>.`);
        }
        [targetRepo, targetAgent] = parts;
    }

    const map = loadAgents();
    const config = (map && typeof map._config === 'object') ? map._config : null;
    const directRecord = (map && map[input] && map[input].type === 'agent') ? map[input] : null;

    const clearStaticConfig = ({ repoName, shortName, containerName, rawInput }) => {
        if (!config || !config.static) return false;
        const comparisons = new Set();
        if (shortName) comparisons.add(String(shortName).trim().toLowerCase());
        if (repoName && shortName) {
            const repo = String(repoName).trim().toLowerCase();
            const short = String(shortName).trim().toLowerCase();
            comparisons.add(`${repo}/${short}`);
            comparisons.add(`${repo}:${short}`);
        }
        if (rawInput) comparisons.add(String(rawInput).trim().toLowerCase());

        const staticAgent = String(config.static.agent || '').trim().toLowerCase();
        const staticContainer = String(config.static.container || '').trim();

        const matchesAgent = staticAgent && (comparisons.has(staticAgent));
        const matchesContainer = containerName && staticContainer && staticContainer === containerName;

        if (!matchesAgent && !matchesContainer) return false;

        delete config.static;
        if (Object.keys(config).length === 0) {
            delete map._config;
        } else {
            map._config = config;
        }
        return true;
    };

    const entries = Object.entries(map || {})
        .filter(([key, value]) => key !== '_config' && value && typeof value === 'object')
        .filter(([, value]) => value.type === 'agent');

    const aliasEntry = (!directRecord)
        ? entries.find(([, value]) => {
            if (!value || !value.alias) return false;
            if (value.alias === input) return true;
            if (hasNamespace) {
                return value.alias === targetAgent;
            }
            return false;
        })
        : null;

    let matches;
    if (directRecord) {
        matches = [[input, directRecord]];
    } else if (aliasEntry) {
        matches = [[aliasEntry[0], aliasEntry[1]]];
    } else {
        matches = entries.filter(([, value]) => {
            const repoName = String(value.repoName || '').trim();
            const agentName = String(value.agentName || '').trim();
            if (!agentName) return false;
            if (hasNamespace) {
                return agentName === targetAgent && repoName === targetRepo;
            }
            return agentName === targetAgent;
        });
    }

    if (!matches.length) {
        const staticCleared = clearStaticConfig({ repoName: targetRepo, shortName: targetAgent, rawInput: input, containerName: null });
        if (staticCleared) {
            saveAgents(map);
            return {
                status: 'static-removed',
                requested: input
            };
        }
        return {
            status: 'not-found',
            requested: input
        };
    }

    if (!hasNamespace && !directRecord && matches.length > 1) {
        return {
            status: 'ambiguous',
            requested: input,
            matches: matches.map(([, value]) => `${value.repoName}/${value.agentName}`)
        };
    }

    const [containerName, record] = matches[0];

    let isActive = false;
    try {
        const liveSet = new Set((collectLiveAgentContainers() || []).map(item => item.containerName));
        if (liveSet.size && liveSet.has(containerName)) {
            isActive = true;
        }
    } catch (_) {}

    if (!isActive) {
        try {
            if (isContainerRunning(containerName)) {
                isActive = true;
            }
        } catch (_) {}
    }

    if (!isActive) {
        try {
            if (containerExists(containerName)) {
                isActive = true;
            }
        } catch (error) {
            // If we cannot determine container existence, err on the safe side
            isActive = true;
        }
    }

    if (isActive) {
        return {
            status: 'container-exists',
            containerName,
            shortAgentName: record.agentName,
            repoName: record.repoName
        };
    }

    delete map[containerName];

    clearStaticConfig({
        repoName: record.repoName,
        shortName: record.agentName,
        containerName,
        rawInput: input
    });

    saveAgents(map);

    // Remove workspace structure for the agent
    try {
        // Remove symlinks: $CWD/code/<agentName> and $CWD/skills/<agentName>
        removeAgentSymlinks(record.agentName);

        // Note: We don't remove the agent work directory by default to preserve data
        // Use removeAgentWorkDir(record.agentName, true) to force removal if needed
    } catch (err) {
        console.error(`Warning: Failed to remove workspace structure for ${record.agentName}: ${err.message}`);
    }

    return {
        status: 'removed',
        containerName,
        shortAgentName: record.agentName,
        repoName: record.repoName
    };
}

export function resolveEnabledAgentRecord(agentRef) {
    const input = typeof agentRef === 'string' ? agentRef.trim() : '';
    if (!input) return null;

    const map = loadAgents();
    if (!map || typeof map !== 'object') return null;

    const direct = map[input];
    if (direct && direct.type === 'agent') {
        return { containerName: input, record: direct };
    }

    const hasNamespace = /[:/]/.test(input);
    let repoFilter = null;
    let agentFilter = input;
    if (hasNamespace) {
        const parts = input.split(/[:/]/).filter(Boolean);
        if (parts.length === 2) {
            [repoFilter, agentFilter] = parts;
        }
    }

    let aliasEntry = Object.entries(map || {})
        .filter(([key]) => !RESERVED_AGENT_KEYS.has(key))
        .find(([, value]) => value && value.type === 'agent' && value.alias === input);
    if (!aliasEntry && hasNamespace) {
        aliasEntry = Object.entries(map || {})
            .filter(([key]) => !RESERVED_AGENT_KEYS.has(key))
            .find(([, value]) => value && value.type === 'agent' && value.alias === agentFilter);
    }
    if (aliasEntry) {
        return { containerName: aliasEntry[0], record: aliasEntry[1] };
    }

    const matches = Object.entries(map)
        .filter(([key, value]) => !RESERVED_AGENT_KEYS.has(key) && value && typeof value === 'object')
        .filter(([, value]) => value.type === 'agent')
        .filter(([, value]) => {
            if (!value.agentName) return false;
            if (repoFilter && value.repoName !== repoFilter) return false;
            return value.agentName === agentFilter;
        });

    if (!matches.length) {
        return null;
    }

    if (matches.length > 1) {
        const aliasList = matches.map(([containerName, value]) => value.alias || containerName);
        const err = new Error(`Multiple containers found for agent '${agentRef}'. Use alias: ${aliasList.join(', ')}`);
        err.code = 'AGENT_ALIAS_AMBIGUOUS';
        throw err;
    }

    const [containerName, record] = matches[0];
    return { containerName, record };
}
