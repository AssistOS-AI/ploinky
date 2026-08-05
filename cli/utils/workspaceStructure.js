import fs from 'fs';
import path from 'path';
import { PLOINKY_WORKSPACE_ROOT, PLOINKY_DIR, AGENTS_DATA_DIR, CODE_DIR, SKILLS_DIR, REPOS_DIR } from './config.js';

export const AGENT_HOME_ABI = 'ploinky-home-v2';
export const AGENT_HOME_ABI_SCHEMA_VERSION = 2;
export const AGENT_HOME_ABI_MARKER = '.ploinky-home-abi.json';
export const SANDBOX_AGENT_HOME_SUFFIX = '.sandbox-v2';

const AGENT_HOME_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const AGENT_HOME_COMPONENT_MAX_BYTES = 255;
const SANDBOX_RUNTIME_KEY_MAX_BYTES = AGENT_HOME_COMPONENT_MAX_BYTES
    - Buffer.byteLength(SANDBOX_AGENT_HOME_SUFFIX, 'utf8');
const AGENT_HOME_MARKER_KEYS = Object.freeze([
    'abi',
    'createdByGeneration',
    'homeKey',
    'schemaVersion',
]);
const AGENT_HOME_MARKER_MAX_BYTES = 4096;
const AGENT_HOME_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/;

export class AgentHomeStateIncompatibleError extends Error {
    constructor(reason) {
        super([
            'Agent HOME state is incompatible with the ploinky-home-v2 ABI.',
            'Archive or reset this agent HOME explicitly, then retry.',
            'Ploinky did not migrate, rewrite, or remove the existing HOME state.',
        ].join(' '));
        this.name = 'AgentHomeStateIncompatibleError';
        this.code = 'PLOINKY_HOME_STATE_INCOMPATIBLE';
        this.context = Object.freeze({ reason });
    }
}

function homeStateError(reason) {
    return new AgentHomeStateIncompatibleError(reason);
}

function requireSandboxRuntimeKey(runtimeKey) {
    if (typeof runtimeKey !== 'string'
        || !AGENT_HOME_KEY_PATTERN.test(runtimeKey)
        || Buffer.byteLength(runtimeKey, 'utf8') > SANDBOX_RUNTIME_KEY_MAX_BYTES
        || runtimeKey === '.'
        || runtimeKey === '..') {
        throw homeStateError('invalid-home-key');
    }
    return runtimeKey;
}

function sandboxHomeKey(runtimeKey) {
    return `${requireSandboxRuntimeKey(runtimeKey)}${SANDBOX_AGENT_HOME_SUFFIX}`;
}

function requireGeneration(generation) {
    if (typeof generation !== 'string'
        || generation.length === 0
        || Buffer.byteLength(generation, 'utf8') > 255
        || generation.trim() !== generation
        || !AGENT_HOME_GENERATION_PATTERN.test(generation)) {
        throw homeStateError('invalid-generation');
    }
    return generation;
}

function currentUid() {
    if (typeof process.getuid !== 'function') {
        throw homeStateError('uid-unavailable');
    }
    const uid = process.getuid();
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw homeStateError('uid-unavailable');
    }
    return uid;
}

function sameFilesystemObject(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}

function exactMode(stats) {
    return stats.mode & 0o7777;
}

function inspectDataRoot(agentsDataDir, expectedUid) {
    let dataPath;
    let stats;
    let realPath;
    let realStats;
    try {
        dataPath = path.resolve(agentsDataDir);
        stats = fs.lstatSync(dataPath);
        realPath = fs.realpathSync(dataPath);
        realStats = fs.statSync(realPath);
    } catch (_) {
        throw homeStateError('invalid-data-root');
    }
    if (stats.isSymbolicLink()
        || !stats.isDirectory()
        || !realStats.isDirectory()
        || !sameFilesystemObject(stats, realStats)
        || stats.uid !== expectedUid) {
        throw homeStateError('invalid-data-root');
    }
    return Object.freeze({ dataPath, realPath, stats });
}

function inspectHome(homePath, homeKey, dataRoot, expectedUid) {
    let stats;
    let realPath;
    let realStats;
    try {
        stats = fs.lstatSync(homePath);
        realPath = fs.realpathSync(homePath);
        realStats = fs.statSync(realPath);
    } catch (_) {
        throw homeStateError('invalid-home-root');
    }
    if (stats.isSymbolicLink()
        || !stats.isDirectory()
        || !realStats.isDirectory()
        || !sameFilesystemObject(stats, realStats)
        || stats.uid !== expectedUid
        || exactMode(stats) !== 0o700
        || path.dirname(realPath) !== dataRoot.realPath
        || path.basename(realPath) !== homeKey) {
        throw homeStateError('invalid-home-root');
    }
    return Object.freeze({ realPath, stats });
}

function canonicalHomeMarker(marker) {
    return `${JSON.stringify({
        abi: marker.abi,
        createdByGeneration: marker.createdByGeneration,
        homeKey: marker.homeKey,
        schemaVersion: marker.schemaVersion,
    })}\n`;
}

function expectedHomeMarker(homeKey, createdByGeneration) {
    return Object.freeze({
        abi: AGENT_HOME_ABI,
        createdByGeneration,
        homeKey,
        schemaVersion: AGENT_HOME_ABI_SCHEMA_VERSION,
    });
}

function inspectHomeMarker(markerPath, homeKey, expectedUid) {
    let stats;
    let raw;
    let marker;
    try {
        stats = fs.lstatSync(markerPath);
        if (stats.isSymbolicLink()
            || !stats.isFile()
            || stats.uid !== expectedUid
            || exactMode(stats) !== 0o600
            || stats.size > AGENT_HOME_MARKER_MAX_BYTES) {
            throw homeStateError('invalid-home-marker');
        }
        raw = fs.readFileSync(markerPath, 'utf8');
        marker = JSON.parse(raw);
    } catch (error) {
        if (error?.code === 'PLOINKY_HOME_STATE_INCOMPATIBLE') throw error;
        throw homeStateError('invalid-home-marker');
    }
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
        throw homeStateError('invalid-home-marker');
    }
    const keys = Object.keys(marker).sort();
    const expectedKeys = [...AGENT_HOME_MARKER_KEYS].sort();
    if (keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])
        || marker.abi !== AGENT_HOME_ABI
        || typeof marker.createdByGeneration !== 'string'
        || marker.createdByGeneration.length === 0
        || Buffer.byteLength(marker.createdByGeneration, 'utf8') > 255
        || !AGENT_HOME_GENERATION_PATTERN.test(marker.createdByGeneration)
        || marker.homeKey !== homeKey
        || marker.schemaVersion !== AGENT_HOME_ABI_SCHEMA_VERSION
        || raw !== canonicalHomeMarker(marker)) {
        throw homeStateError('invalid-home-marker');
    }
    return Object.freeze(marker);
}

function createHomeMarker(markerPath, marker, expectedUid) {
    const noFollow = fs.constants.O_NOFOLLOW;
    if (!Number.isInteger(noFollow)) {
        throw homeStateError('atomic-marker-unavailable');
    }
    const flags = fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | noFollow;
    let fd;
    try {
        fd = fs.openSync(markerPath, flags, 0o600);
        fs.fchmodSync(fd, 0o600);
        const stats = fs.fstatSync(fd);
        if (!stats.isFile() || stats.uid !== expectedUid || exactMode(stats) !== 0o600) {
            throw homeStateError('invalid-created-marker');
        }
        fs.writeFileSync(fd, canonicalHomeMarker(marker), 'utf8');
        fs.fsyncSync(fd);
    } catch (error) {
        if (error?.code === 'PLOINKY_HOME_STATE_INCOMPATIBLE') throw error;
        throw homeStateError('marker-creation-race');
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch (_) {}
        }
    }
}

/**
 * Initialize the workspace directory structure.
 * Creates: .ploinky/, .ploinky/code/, .ploinky/skills/, .ploinky/logs/, .ploinky/shared/, .data/
 * @param {string} [workspacePath] - Optional workspace path, defaults to CWD
 */
export function initWorkspaceStructure(workspacePath = PLOINKY_WORKSPACE_ROOT) {
    const runtimeRoot = path.join(workspacePath, '.ploinky');
    const dirs = [
        runtimeRoot,
        path.join(runtimeRoot, 'code'),
        path.join(runtimeRoot, 'skills'),
        path.join(runtimeRoot, 'logs'),
        path.join(runtimeRoot, 'shared'),
        path.join(workspacePath, '.data')
    ];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

/**
 * Create symlinks for agent code and skills directories.
 * - $PLOINKY_WORKSPACE_ROOT/.ploinky/code/<agentName> -> .ploinky/repos/<repo>/<agent>/code/
 * - $PLOINKY_WORKSPACE_ROOT/.ploinky/skills/<agentName> -> .ploinky/repos/<repo>/<agent>/skills/
 * @param {string} agentName - The agent name
 * @param {string} repoName - The repository name
 * @param {string} agentPath - The full path to the agent directory in repos
 */
export function createAgentSymlinks(agentName, repoName, agentPath) {
    // Ensure code and skills directories exist
    const codeDir = CODE_DIR;
    const skillsDir = SKILLS_DIR;

    if (!fs.existsSync(codeDir)) {
        fs.mkdirSync(codeDir, { recursive: true });
    }
    if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
    }

    // Create symlink for code: $PLOINKY_WORKSPACE_ROOT/.ploinky/code/<agentName> -> agent source
    const codeSymlinkPath = path.join(codeDir, agentName);
    const codeTargetPath = path.join(agentPath, 'code');

    // If no code subfolder exists, link to the agent directory itself
    const actualCodeTarget = fs.existsSync(codeTargetPath) ? codeTargetPath : agentPath;

    // Remove existing symlink if it exists, warn if blocked by real directory
    let codeBlocked = false;
    try {
        const stat = fs.lstatSync(codeSymlinkPath);
        if (stat.isSymbolicLink()) {
            fs.unlinkSync(codeSymlinkPath);
        } else {
            // Path exists but is not a symlink (real file/directory)
            console.warn(`Warning: ${codeSymlinkPath} exists and is not a symlink. Skipping code symlink for ${agentName}.`);
            codeBlocked = true;
        }
    } catch (_) {
        // Path doesn't exist, safe to create symlink
    }

    if (!codeBlocked) {
        try {
            fs.symlinkSync(actualCodeTarget, codeSymlinkPath, 'dir');
        } catch (err) {
            if (err.code !== 'EEXIST') {
                console.error(`Failed to create code symlink for ${agentName}: ${err.message}`);
            }
        }
    }

    // Create symlink for skills: $PLOINKY_WORKSPACE_ROOT/.ploinky/skills/<agentName> -> agent skills
    const skillsSymlinkPath = path.join(skillsDir, agentName);
    const skillsTargetPath = path.join(agentPath, 'skills');

    // Only create skills symlink if skills folder exists
    if (fs.existsSync(skillsTargetPath)) {
        // Remove existing symlink if it exists, warn if blocked by real directory
        let skillsBlocked = false;
        try {
            const stat = fs.lstatSync(skillsSymlinkPath);
            if (stat.isSymbolicLink()) {
                fs.unlinkSync(skillsSymlinkPath);
            } else {
                console.warn(`Warning: ${skillsSymlinkPath} exists and is not a symlink. Skipping skills symlink for ${agentName}.`);
                skillsBlocked = true;
            }
        } catch (_) {
            // Path doesn't exist, safe to create symlink
        }

        if (!skillsBlocked) {
            try {
                fs.symlinkSync(skillsTargetPath, skillsSymlinkPath, 'dir');
            } catch (err) {
                if (err.code !== 'EEXIST') {
                    console.error(`Failed to create skills symlink for ${agentName}: ${err.message}`);
                }
            }
        }
    }
}

/**
 * Remove symlinks for agent code and skills directories.
 * @param {string} agentName - The agent name
 */
export function removeAgentSymlinks(agentName) {
    const codeSymlinkPath = path.join(CODE_DIR, agentName);
    const skillsSymlinkPath = path.join(SKILLS_DIR, agentName);

    // Remove code symlink
    try {
        if (fs.lstatSync(codeSymlinkPath).isSymbolicLink()) {
            fs.unlinkSync(codeSymlinkPath);
        }
    } catch (_) {}

    // Remove skills symlink
    try {
        if (fs.lstatSync(skillsSymlinkPath).isSymbolicLink()) {
            fs.unlinkSync(skillsSymlinkPath);
        }
    } catch (_) {}
}

/**
 * Get the agent working directory path.
 * @param {string} agentName - The agent name
 * @returns {string} The path to $PLOINKY_WORKSPACE_ROOT/.data/<agentName>/
 */
export function getAgentWorkDir(agentName) {
    return path.join(AGENTS_DATA_DIR, sanitizeAgentDataName(agentName));
}

export function getAgentDataDir(instanceName) {
    return path.join(AGENTS_DATA_DIR, sanitizeAgentDataName(instanceName));
}

/**
 * Resolve the sandbox-only provider HOME backing directory without sanitizing
 * or otherwise changing the admitted runtime key. The ABI suffix is always
 * appended here so callers cannot accidentally select the container HOME.
 *
 * @param {string} runtimeKey - Exact effective runtime key before ABI suffix
 * @param {{ agentsDataDir?: string }} [options]
 * @returns {string} The physical HOME path below .data
 */
export function getAgentHomeAbiPath(runtimeKey, {
    agentsDataDir = AGENTS_DATA_DIR,
} = {}) {
    const exactHomeKey = sandboxHomeKey(runtimeKey);
    if (typeof agentsDataDir !== 'string' || agentsDataDir.length === 0) {
        throw homeStateError('invalid-data-root');
    }
    return path.join(path.resolve(agentsDataDir), exactHomeKey);
}

/**
 * Create or validate the clean sandbox provider HOME ABI. Existing marked
 * sandbox state is accepted without rewriting its immutable creation
 * provenance. The unsuffixed container HOME is never inspected or changed.
 * Existing unmarked sandbox state is never migrated or removed.
 *
 * @param {string} runtimeKey - Exact effective runtime key before ABI suffix
 * @param {string} createdByGeneration - Exact nonempty creation generation
 * @param {{ agentsDataDir?: string }} [options]
 * @returns {{ homePath: string, homeKey: string, createdByGeneration: string, markerPath: string }}
 */
export function ensureAgentHomeAbi(runtimeKey, createdByGeneration, {
    agentsDataDir = AGENTS_DATA_DIR,
} = {}) {
    const exactRuntimeKey = requireSandboxRuntimeKey(runtimeKey);
    const exactHomeKey = sandboxHomeKey(exactRuntimeKey);
    const exactGeneration = requireGeneration(createdByGeneration);
    const expectedUid = currentUid();
    const dataRootBefore = inspectDataRoot(agentsDataDir, expectedUid);
    const homePath = getAgentHomeAbiPath(exactRuntimeKey, {
        agentsDataDir: dataRootBefore.dataPath,
    });

    let createdHome = false;
    try {
        fs.mkdirSync(homePath, { mode: 0o700 });
        createdHome = true;
        fs.chmodSync(homePath, 0o700);
    } catch (error) {
        if (error?.code !== 'EEXIST') {
            throw homeStateError('home-creation-failed');
        }
    }

    const homeBefore = inspectHome(
        homePath,
        exactHomeKey,
        dataRootBefore,
        expectedUid,
    );
    const markerPath = path.join(homePath, AGENT_HOME_ABI_MARKER);
    let entries;
    try {
        entries = fs.readdirSync(homePath);
    } catch (_) {
        throw homeStateError('home-read-failed');
    }
    let createdMarker = false;
    if (!entries.includes(AGENT_HOME_ABI_MARKER)) {
        if (entries.length !== 0) {
            throw homeStateError('unmarked-home-not-empty');
        }
        createHomeMarker(
            markerPath,
            expectedHomeMarker(exactHomeKey, exactGeneration),
            expectedUid,
        );
        createdMarker = true;
    } else if (createdHome || entries.filter((entry) => entry === AGENT_HOME_ABI_MARKER).length !== 1) {
        throw homeStateError('home-creation-race');
    }

    const dataRootAfter = inspectDataRoot(agentsDataDir, expectedUid);
    const homeAfter = inspectHome(
        homePath,
        exactHomeKey,
        dataRootAfter,
        expectedUid,
    );
    if (!sameFilesystemObject(dataRootBefore.stats, dataRootAfter.stats)
        || !sameFilesystemObject(homeBefore.stats, homeAfter.stats)) {
        throw homeStateError('home-identity-race');
    }
    if (createdMarker) {
        let initializedEntries;
        try {
            initializedEntries = fs.readdirSync(homePath);
        } catch (_) {
            throw homeStateError('home-read-failed');
        }
        if (initializedEntries.length !== 1
            || initializedEntries[0] !== AGENT_HOME_ABI_MARKER) {
            throw homeStateError('home-creation-race');
        }
    }
    const marker = inspectHomeMarker(markerPath, exactHomeKey, expectedUid);
    return Object.freeze({
        homePath,
        homeKey: exactHomeKey,
        createdByGeneration: marker.createdByGeneration,
        markerPath,
    });
}

function sanitizeAgentDataName(value) {
    return String(value || 'agent').replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * Get the agent code path (symlink location).
 * @param {string} agentName - The agent name
 * @returns {string} The path to $PLOINKY_WORKSPACE_ROOT/.ploinky/code/<agentName>/
 */
export function getAgentCodePath(agentName) {
    return path.join(CODE_DIR, agentName);
}

/**
 * Get the canonical repo-scoped agent root path.
 * @param {string} repoName - The repository name
 * @param {string} agentName - The agent name
 * @returns {string} The path to $PLOINKY_WORKSPACE_ROOT/.ploinky/repos/<repo>/<agent>/
 */
export function getRepoAgentRootPath(repoName, agentName) {
    return path.join(REPOS_DIR, repoName, agentName);
}

/**
 * Get the canonical repo-scoped code path for an agent.
 * If the agent has a `code/` subfolder, return that; otherwise return the
 * agent root itself.
 *
 * @param {string} repoName - The repository name
 * @param {string} agentName - The agent name
 * @returns {string} The repo-scoped code path
 */
export function getRepoAgentCodePath(repoName, agentName) {
    const agentRootPath = getRepoAgentRootPath(repoName, agentName);
    const codePath = path.join(agentRootPath, 'code');
    return fs.existsSync(codePath) ? codePath : agentRootPath;
}

/**
 * Get the agent skills path (symlink location).
 * @param {string} agentName - The agent name
 * @returns {string} The path to $PLOINKY_WORKSPACE_ROOT/.ploinky/skills/<agentName>/
 */
export function getAgentSkillsPath(agentName) {
    return path.join(SKILLS_DIR, agentName);
}

/**
 * Create the agent working directory.
 * @param {string} agentName - The agent name
 * @returns {string} The created directory path
 */
export function createAgentWorkDir(agentName) {
    const workDir = getAgentWorkDir(agentName);
    if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
    }
    return workDir;
}

/**
 * Remove the agent working directory.
 * @param {string} agentName - The agent name
 * @param {boolean} [force=false] - If true, removes even if not empty
 */
export function removeAgentWorkDir(agentName, force = false) {
    const workDir = getAgentWorkDir(agentName);
    try {
        if (fs.existsSync(workDir)) {
            if (force) {
                fs.rmSync(workDir, { recursive: true, force: true });
            } else {
                fs.rmdirSync(workDir);
            }
        }
    } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') {
            console.error(`Failed to remove agent work dir for ${agentName}: ${err.message}`);
        }
    }
}

/**
 * Verify the workspace structure integrity.
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function verifyWorkspaceStructure() {
    const cwd = PLOINKY_WORKSPACE_ROOT;
    const issues = [];
    const runtimeRoot = path.join(cwd, '.ploinky');

    const requiredDirs = [
        { path: runtimeRoot, name: '.ploinky' },
        { path: path.join(runtimeRoot, 'code'), name: '.ploinky/code' },
        { path: path.join(runtimeRoot, 'skills'), name: '.ploinky/skills' },
        { path: path.join(runtimeRoot, 'logs'), name: '.ploinky/logs' },
        { path: path.join(runtimeRoot, 'shared'), name: '.ploinky/shared' },
        { path: AGENTS_DATA_DIR, name: '.data' }
    ];

    for (const dir of requiredDirs) {
        if (!fs.existsSync(dir.path)) {
            issues.push(`Missing directory: ${dir.name}`);
        } else if (!fs.statSync(dir.path).isDirectory()) {
            issues.push(`${dir.name} exists but is not a directory`);
        }
    }

    // Check symlinks in .ploinky/code/ and .ploinky/skills/
    const codeDir = path.join(runtimeRoot, 'code');
    const skillsDir = path.join(runtimeRoot, 'skills');

    if (fs.existsSync(codeDir)) {
        const codeEntries = fs.readdirSync(codeDir);
        for (const entry of codeEntries) {
            const entryPath = path.join(codeDir, entry);
            try {
                const stat = fs.lstatSync(entryPath);
                if (stat.isSymbolicLink()) {
                    const target = fs.readlinkSync(entryPath);
                    const resolvedTarget = path.resolve(codeDir, target);
                    if (!fs.existsSync(resolvedTarget)) {
                        issues.push(`Broken symlink: .ploinky/code/${entry} -> ${target}`);
                    }
                }
            } catch (_) {}
        }
    }

    if (fs.existsSync(skillsDir)) {
        const skillsEntries = fs.readdirSync(skillsDir);
        for (const entry of skillsEntries) {
            const entryPath = path.join(skillsDir, entry);
            try {
                const stat = fs.lstatSync(entryPath);
                if (stat.isSymbolicLink()) {
                    const target = fs.readlinkSync(entryPath);
                    const resolvedTarget = path.resolve(skillsDir, target);
                    if (!fs.existsSync(resolvedTarget)) {
                        issues.push(`Broken symlink: .ploinky/skills/${entry} -> ${target}`);
                    }
                }
            } catch (_) {}
        }
    }

    return {
        valid: issues.length === 0,
        issues
    };
}

/**
 * Get the path to the package.base.json template.
 * @returns {string} The path to the base package.json template
 */
export function getPackageBaseTemplatePath() {
    // Check local templates first, then fall back to ploinky templates
    const localTemplate = path.join(PLOINKY_DIR, 'package.base.json');
    if (fs.existsSync(localTemplate)) {
        return localTemplate;
    }

    // Use the default template from ploinky
    return path.join(path.dirname(new URL(import.meta.url).pathname), '../../templates/package.base.json');
}

/**
 * Check if an agent has a package.json in its code directory.
 * @param {string} agentName - The agent name
 * @returns {boolean}
 */
export function agentHasPackageJson(agentName) {
    const codePath = getAgentCodePath(agentName);
    const packagePath = path.join(codePath, 'package.json');
    return fs.existsSync(packagePath);
}
