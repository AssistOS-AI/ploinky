import fs from 'fs';
import path from 'path';
import { PLOINKY_WORKSPACE_ROOT, PLOINKY_DIR, AGENTS_WORK_DIR, CODE_DIR, SKILLS_DIR, REPOS_DIR } from './config.js';

/**
 * Initialize the workspace directory structure.
 * Creates: .ploinky/, .ploinky/agents/, .ploinky/code/, .ploinky/skills/, .ploinky/logs/, .ploinky/shared/
 * @param {string} [workspacePath] - Optional workspace path, defaults to CWD
 */
export function initWorkspaceStructure(workspacePath = PLOINKY_WORKSPACE_ROOT) {
    const runtimeRoot = path.join(workspacePath, '.ploinky');
    const dirs = [
        runtimeRoot,
        path.join(runtimeRoot, 'agents'),
        path.join(runtimeRoot, 'code'),
        path.join(runtimeRoot, 'skills'),
        path.join(runtimeRoot, 'logs'),
        path.join(runtimeRoot, 'shared')
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
 * @returns {string} The path to $PLOINKY_WORKSPACE_ROOT/.ploinky/agents/<agentName>/
 */
export function getAgentWorkDir(agentName) {
    return path.join(AGENTS_WORK_DIR, agentName);
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
        { path: path.join(runtimeRoot, 'agents'), name: '.ploinky/agents' },
        { path: path.join(runtimeRoot, 'code'), name: '.ploinky/code' },
        { path: path.join(runtimeRoot, 'skills'), name: '.ploinky/skills' },
        { path: path.join(runtimeRoot, 'logs'), name: '.ploinky/logs' },
        { path: path.join(runtimeRoot, 'shared'), name: '.ploinky/shared' }
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
