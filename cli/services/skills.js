import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { REPOS_DIR } from './config.js';
import * as reposSvc from './repos.js';

export const AGENT_SKILL_TARGETS = Object.freeze({
    'claude-code': '.claude/skills',
    'agents':      '.agents/skills',
});
export const SKILLS_MANIFEST_FILE = 'ploinky-skills-manifest.json';

const CANONICAL_AGENT_DIR = '.agents';
const CLAUDE_SYMLINK = '.claude';
const CANONICAL_SKILLS_DIR = AGENT_SKILL_TARGETS['agents'];
const SKILLS_DISCOVERY_IGNORED_DIRS = new Set(['.git', 'node_modules', 'globalDeps', '.ploinky']);

const GITIGNORE_MARKER_START = '# >>> ploinky default-skills >>>';
const GITIGNORE_MARKER_END = '# <<< ploinky default-skills <<<';

function ensureRepoCloned(repoName) {
    const repoPath = path.join(REPOS_DIR, repoName);
    if (fs.existsSync(repoPath)) return repoPath;
    const result = reposSvc.addRepo(repoName, null);
    return result.path;
}

function listSkillDirectories(skillsRoot) {
    return fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name);
}

function parseSkillsManifest(rawPath) {
    let rawManifest;
    try {
        rawManifest = fs.readFileSync(rawPath, 'utf8');
    } catch (err) {
        throw new Error(`Cannot read skills manifest '${rawPath}': ${err?.message || String(err)}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(rawManifest || '');
    } catch (err) {
        throw new Error(`Invalid JSON in skills manifest '${rawPath}': ${err?.message || String(err)}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error(`Invalid skills manifest '${rawPath}': expected an array of repository links.`);
    }

    return parsed.map((entry, index) => {
        if (typeof entry !== 'string') {
            throw new Error(`Invalid skills manifest '${rawPath}': entry at index ${index} must be a string.`);
        }
        const trimmed = entry.trim();
        if (!trimmed) {
            throw new Error(`Invalid skills manifest '${rawPath}': entry at index ${index} is empty.`);
        }
        return trimmed;
    });
}

function resolveRepoFromManifestLink(link, manifestDir) {
    const candidate = path.resolve(manifestDir, link);
    if (fs.existsSync(candidate)) {
        return {
            repoPath: candidate,
            cleanup: () => {},
            source: link,
        };
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-repo-'));
    const clonedRepoPath = path.join(tmpRoot, 'repo');
    try {
        execFileSync('git', ['clone', '--quiet', '--depth', '1', link, clonedRepoPath], { stdio: 'ignore' });
        return {
            repoPath: clonedRepoPath,
            cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
            source: link,
        };
    } catch (err) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        throw new Error(`Failed to clone skill repository '${link}': ${err?.message || String(err)}`);
    }
}

export function copySkill(srcDir, destDir) {
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.cpSync(srcDir, destDir, { recursive: true, force: true });
}

function pathExists(targetPath) {
    try {
        fs.lstatSync(targetPath);
        return true;
    } catch (_) {
        return false;
    }
}

function listExistingSkillDirectories(skillsDir) {
    try {
        return fs.readdirSync(skillsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
            .map(entry => entry.name);
    } catch (_) {
        return [];
    }
}

export function ensureGitignoreEntries(workspaceRoot, relPaths) {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    let content = '';
    try {
        content = fs.readFileSync(gitignorePath, 'utf8');
    } catch (_) {
        content = '';
    }

    const desired = relPaths.map(p => {
        if (p.includes('/')) return p.endsWith('/') ? p : `${p}/`;
        return p;
    });
    const startIdx = content.indexOf(GITIGNORE_MARKER_START);
    const endIdx = content.indexOf(GITIGNORE_MARKER_END);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const before = content.slice(0, startIdx);
        const after = content.slice(endIdx + GITIGNORE_MARKER_END.length);
        const newBlock = `${GITIGNORE_MARKER_START}\n${desired.join('\n')}\n${GITIGNORE_MARKER_END}`;
        const newContent = `${before}${newBlock}${after}`;
        if (newContent === content) return false;
        fs.writeFileSync(gitignorePath, newContent);
        return true;
    }

    const needsLeadingNewline = content.length > 0 && !content.endsWith('\n');
    const block = `${needsLeadingNewline ? '\n' : ''}${GITIGNORE_MARKER_START}\n${desired.join('\n')}\n${GITIGNORE_MARKER_END}\n`;
    fs.writeFileSync(gitignorePath, content + block);
    return true;
}

export function readSkillsManifest(manifestPath) {
    return parseSkillsManifest(manifestPath);
}

export function installSkillsFromManifest(manifestPath, { targetRoot } = {}) {
    if (!manifestPath || typeof manifestPath !== 'string') {
        throw new Error('Missing skills manifest path.');
    }

    const links = parseSkillsManifest(manifestPath);
    if (!links.length) {
        throw new Error(`Skills manifest '${manifestPath}' has no repositories.`);
    }

    const destRoot = targetRoot || process.cwd();
    const resolvedLinks = links.map(link => String(link).trim()).filter(Boolean);
    const manifestDir = path.dirname(manifestPath);

    const acquired = [];
    const sourceRepos = [];
    const skillConflicts = [];
    const skillSource = new Map();
    try {
        for (const link of resolvedLinks) {
            const source = resolveRepoFromManifestLink(link, manifestDir);
            acquired.push(source);
            const skillsRoot = path.join(source.repoPath, 'skills');
            if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
                throw new Error(`No skills/ folder in source repo '${link}' (expected ${skillsRoot}).`);
            }
            const skills = listSkillDirectories(skillsRoot);
            if (!skills.length) {
                throw new Error(`No skill subdirectories found under ${skillsRoot} for source '${link}'.`);
            }
            sourceRepos.push({
                source: link,
                repoPath: source.repoPath,
                skills,
                cleanup: source.cleanup,
            });
            for (const skill of skills) {
                const previousSource = skillSource.get(skill);
                if (previousSource) {
                    skillConflicts.push({
                        skill,
                        previousSource,
                        chosenSource: link,
                    });
                }
                skillSource.set(skill, link);
            }
        }

        const incomingSkills = Array.from(skillSource.keys());
        const isGitRepoTarget = reposSvc.isGitRepository(destRoot);
        const agentsSkillsDir = path.join(destRoot, CANONICAL_SKILLS_DIR);
        fs.rmSync(agentsSkillsDir, { recursive: true, force: true });
        fs.mkdirSync(agentsSkillsDir, { recursive: true });

        for (const source of sourceRepos) {
            const sourceSkillsRoot = path.join(source.repoPath, 'skills');
            for (const skill of source.skills) {
                copySkill(path.join(sourceSkillsRoot, skill), path.join(agentsSkillsDir, skill));
            }
        }

        const claudeLink = ensureClaudeSymlink(destRoot);
        let gitignoreUpdated = false;
        if (isGitRepoTarget) {
            const gitignoreEntries = [
                ...incomingSkills.map(skill => `${CANONICAL_SKILLS_DIR}/${skill}`),
                CANONICAL_AGENT_DIR,
                CLAUDE_SYMLINK,
            ];
            gitignoreUpdated = ensureGitignoreEntries(destRoot, gitignoreEntries);
        }

        return {
            manifestPath,
            repoCount: links.length,
            repos: sourceRepos.map((repo) => ({
                source: repo.source,
                skills: repo.skills,
            })),
            skills: incomingSkills,
            targets: [{ agent: 'agents', relDir: CANONICAL_SKILLS_DIR, skills: incomingSkills }],
            destRoot,
            gitignoreUpdated,
            symlinkCreated: claudeLink.changed,
            claudeLink,
            duplicateSkills: skillConflicts,
            legacyMigration: { migratedSkills: [], skippedExistingSkills: [] },
        };
    } finally {
        for (const source of acquired) {
            try {
                source.cleanup();
            } catch (_) {}
        }
    }
}

export function findSkillsManifestPath(targetRoot) {
    const manifestPath = path.join(targetRoot, SKILLS_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) return null;
    return manifestPath;
}

export function findWorkspaceFoldersWithSkillsManifest(searchRoot) {
    const root = String(searchRoot || '').trim();
    if (!root) throw new Error('Search root must be a non-empty directory path.');

    const resolvedRoot = path.resolve(root);
    if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
        throw new Error(`Search root '${resolvedRoot}' is not a directory.`);
    }

    const folders = [];

    function visit(dir) {
        const manifestPath = path.join(dir, SKILLS_MANIFEST_FILE);
        if (fs.existsSync(manifestPath)) {
            folders.push(dir);
        }

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            if (err?.code === 'EACCES' || err?.code === 'EPERM') return;
            throw err;
        }

        for (const entry of entries
            .filter(entry => entry.isDirectory())
            .filter(entry => !entry.name.startsWith('.'))
            .filter(entry => !SKILLS_DISCOVERY_IGNORED_DIRS.has(entry.name))
            .sort((a, b) => a.name.localeCompare(b.name))) {
            visit(path.join(dir, entry.name));
        }
    }

    visit(resolvedRoot);
    return folders;
}

function migrateLegacyClaudeSkills(destRoot, incomingSkills, agentsSkillsDir) {
    const claudePath = path.join(destRoot, CLAUDE_SYMLINK);
    const claudeSkillsDir = path.join(claudePath, 'skills');
    const incoming = new Set(incomingSkills);
    const migratedSkills = [];
    const skippedExistingSkills = [];

    let claudeStat;
    try { claudeStat = fs.lstatSync(claudePath); } catch (_) { claudeStat = null; }
    if (!claudeStat) {
        return { migratedSkills, skippedExistingSkills };
    }

    if (claudeStat.isSymbolicLink()) {
        try {
            const canonicalReal = fs.realpathSync(path.join(destRoot, CANONICAL_AGENT_DIR));
            const claudeReal = fs.realpathSync(claudePath);
            if (canonicalReal === claudeReal) {
                return { migratedSkills, skippedExistingSkills };
            }
        } catch (_) { }
    }

    for (const skill of listExistingSkillDirectories(claudeSkillsDir)) {
        if (incoming.has(skill)) continue;

        const srcDir = path.join(claudeSkillsDir, skill);
        const destDir = path.join(agentsSkillsDir, skill);
        if (pathExists(destDir)) {
            skippedExistingSkills.push(skill);
            continue;
        }
        fs.cpSync(srcDir, destDir, { recursive: true, force: true });
        migratedSkills.push(skill);
    }

    if (!claudeStat.isSymbolicLink() && pathExists(claudeSkillsDir)) {
        fs.rmSync(claudeSkillsDir, { recursive: true, force: true });
    }

    return { migratedSkills, skippedExistingSkills };
}

function ensureClaudeSymlink(destRoot) {
    const symlinkPath = path.join(destRoot, CLAUDE_SYMLINK);
    const target = CANONICAL_AGENT_DIR;

    let stat;
    try { stat = fs.lstatSync(symlinkPath); } catch (_) { stat = null; }

    if (stat) {
        if (stat.isSymbolicLink()) {
            const existing = fs.readlinkSync(symlinkPath);
            if (existing === target) return { changed: false, mode: 'root' };
            fs.unlinkSync(symlinkPath);
        } else if (stat.isDirectory()) {
            const entries = fs.readdirSync(symlinkPath).filter(name => name !== '.DS_Store');
            if (entries.length) {
                const skillsSymlinkPath = path.join(symlinkPath, 'skills');
                if (pathExists(skillsSymlinkPath)) {
                    const skillsStat = fs.lstatSync(skillsSymlinkPath);
                    if (skillsStat.isSymbolicLink()
                        && fs.readlinkSync(skillsSymlinkPath) === `../${CANONICAL_SKILLS_DIR}`) {
                        return { changed: false, mode: 'skills' };
                    }
                    fs.rmSync(skillsSymlinkPath, { recursive: true, force: true });
                }
                fs.symlinkSync(`../${CANONICAL_SKILLS_DIR}`, skillsSymlinkPath, 'dir');
                return { changed: true, mode: 'skills' };
            }
            fs.rmSync(symlinkPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(symlinkPath);
        }
    }

    fs.symlinkSync(target, symlinkPath, 'dir');
    return { changed: true, mode: 'root' };
}

export function installDefaultSkills(repoName, { only, skip, targetRoot } = {}) {
    if (!repoName || typeof repoName !== 'string') {
        throw new Error('Missing repository name.');
    }

    const destRoot = targetRoot || process.cwd();

    const knownAgents = Object.keys(AGENT_SKILL_TARGETS);
    if (Array.isArray(only) && only.length) {
        const unknown = only.filter(agent => !AGENT_SKILL_TARGETS[agent]);
        if (unknown.length) {
            throw new Error(`Unknown agent(s) in --only: ${unknown.join(', ')}. Known: ${knownAgents.join(', ')}`);
        }
    }

    if (Array.isArray(skip) && skip.length) {
        const unknown = skip.filter(agent => !AGENT_SKILL_TARGETS[agent]);
        if (unknown.length) {
            throw new Error(`Unknown agent(s) in --skip: ${unknown.join(', ')}. Known: ${knownAgents.join(', ')}`);
        }
    }

    const repoPath = ensureRepoCloned(repoName);

    if (reposSvc.classifyRepoKind(repoName) === 'agents') {
        const skillsRepos = Object.entries(reposSvc.getPredefinedRepos())
            .filter(([, info]) => info.kind === 'skills' || info.kind === 'mixed')
            .map(([n]) => n);
        const hint = skillsRepos.length ? ` Available skills repos: ${skillsRepos.join(', ')}.` : '';
        throw new Error(`Repo '${repoName}' is an agents repo and has no skills/ folder.${hint}`);
    }

    const skillsRoot = path.join(repoPath, 'skills');
    if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
        throw new Error(`No skills/ folder in repo '${repoName}' (expected ${skillsRoot}).`);
    }

    const skills = listSkillDirectories(skillsRoot);
    if (!skills.length) {
        throw new Error(`No skill subdirectories found under ${skillsRoot}.`);
    }

    const agentsSkillsDir = path.join(destRoot, CANONICAL_SKILLS_DIR);
    fs.mkdirSync(agentsSkillsDir, { recursive: true });
    const legacyMigration = migrateLegacyClaudeSkills(destRoot, skills, agentsSkillsDir);
    for (const skill of skills) {
        copySkill(path.join(skillsRoot, skill), path.join(agentsSkillsDir, skill));
    }

    const claudeLink = ensureClaudeSymlink(destRoot);

    const targets = [{ agent: 'agents', relDir: CANONICAL_SKILLS_DIR, skills }];

    const gitignoreEntries = [
        CLAUDE_SYMLINK,
        ...skills.map(skill => `${CANONICAL_SKILLS_DIR}/${skill}`),
    ];
    const gitignoreUpdated = ensureGitignoreEntries(destRoot, gitignoreEntries);

    return {
        repoName,
        repoPath,
        skills,
        targets,
        destRoot,
        gitignoreUpdated,
        symlinkCreated: claudeLink.changed,
        claudeLink,
        legacyMigration,
    };
}
