import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { REPOS_DIR } from '../utils/config.js';
import * as reposSvc from '../utils/repos.js';
import { runGitCommand, sanitizeGitDiagnostic } from '../utils/gitCommand.js';
import { syncManagedSkillExports, copyFreshSkillTree } from '../utils/skills/managedExports.js';

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
        .filter(entry => fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
        .map(entry => entry.name);
}

function normalizeSkillName(value, context) {
    const name = String(value || '').trim();
    if (!name) {
        throw new Error(`${context} is empty.`);
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
        throw new Error(`${context} '${name}' is invalid.`);
    }
    return name;
}

function normalizeManifestEntry(entry, index, manifestPath) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Invalid skills manifest '${manifestPath}': entry at index ${index} must be an object.`);
    }
    const url = String(entry.url || '').trim();
    if (!url) {
        throw new Error(`Invalid skills manifest '${manifestPath}': entry at index ${index} is missing url.`);
    }
    const name = normalizeSkillName(entry.name || reposSvc.deriveRepoNameFromUrl(url), `Invalid skills manifest '${manifestPath}': entry ${index} name`);
    const branch = entry.branch === undefined || entry.branch === null || String(entry.branch).trim() === ''
        ? null
        : String(entry.branch).trim();
    if (!Array.isArray(entry.skills)) {
        throw new Error(`Invalid skills manifest '${manifestPath}': entry at index ${index} is missing skills array.`);
    }
    const skills = Array.from(new Set(entry.skills.map((skill, skillIndex) => (
        normalizeSkillName(skill, `Invalid skills manifest '${manifestPath}': entry ${index} skill ${skillIndex}`)
    ))));
    return { url, name, branch, skills };
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
        throw new Error(sanitizeGitDiagnostic(`Invalid JSON in skills manifest '${rawPath}': ${err?.message || String(err)}`));
    }

    if (!Array.isArray(parsed)) {
        throw new Error(`Invalid skills manifest '${rawPath}': expected an array of repository objects.`);
    }

    return parsed.map((entry, index) => normalizeManifestEntry(entry, index, rawPath));
}

function normalizeRepoIdentity(rawUrl, basePath) {
    const value = String(rawUrl).trim();
    const stripGitSuffix = text => text.replace(/\/+$/, '').replace(/\.git$/, '');
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
        const url = new URL(value);
        if (url.protocol !== 'file:') {
            // Credentials do not change HTTP repository identity. Keep SSH users,
            // ports, protocol and path case because they can identify another repo.
            const user = url.protocol === 'ssh:' ? `${url.username}@` : '';
            return `${url.protocol}//${user}${url.host}${stripGitSuffix(url.pathname)}${url.search}`;
        }
        return normalizeRepoIdentity(fileURLToPath(url), basePath);
    }
    const scp = value.match(/^([^/@:]+@)?([^/:]+):(.+)$/);
    if (scp) return `${scp[1] || ''}${scp[2].toLowerCase()}:${stripGitSuffix(scp[3])}`;

    const resolvedPath = path.resolve(basePath, value);
    try {
        const stat = fs.statSync(resolvedPath);
        return `local:${stat.dev}:${stat.ino}`;
    } catch (_) {
        // Local repo.git and repo may be distinct directories: do not strip a
        // local suffix or lowercase paths when checking whether a cache is safe.
        return resolvedPath;
    }
}

function readCachedRepoSource(repoPath) {
    const urls = String(runGitCommand(['-C', repoPath, 'config', '--get-all', 'remote.origin.url'], { stdio: 'pipe' })).trim().split('\n');
    if (urls.length !== 1 || !urls[0]) {
        throw new Error(`Cached origin at '${repoPath}' must have exactly one fetch URL. Inspect its remote.origin.url configuration before retrying.`);
    }
    return urls[0];
}

function skillSourceError(manifestPath, entry, error) {
    const repoPath = path.join(REPOS_DIR, entry.name);
    return new Error(sanitizeGitDiagnostic(
        `Skills manifest '${manifestPath}', source repo '${entry.name}' ` +
        `(URL '${entry.url}', requested branch '${entry.branch || '(unspecified; cached branch or remote default)'}', ` +
        `cache '${repoPath}'): ${error?.message || String(error)}`
    ));
}

function registerManifestCacheBranch(entry, cacheBranches) {
    const repoPath = path.resolve(REPOS_DIR, entry.name);
    let cacheIdentity;
    try {
        const stat = fs.statSync(repoPath);
        // Filesystem identity also catches symlink aliases and case variants on
        // case-insensitive filesystems, where distinct names share one checkout.
        cacheIdentity = `existing:${stat.dev}:${stat.ino}`;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        cacheIdentity = `missing:${repoPath}`;
    }
    const previous = cacheBranches.get(cacheIdentity);
    if (previous && previous.branch !== entry.branch) {
        throw new Error(
            `Manifest entries '${previous.name}' and '${entry.name}' share cache '${repoPath}' with different branches. ` +
            'Use a distinct name for each branch that resolves to a separate cache directory.'
        );
    }
    cacheBranches.set(cacheIdentity, entry);
}

function ensureManifestRepoCached(entry) {
    const repoPath = path.join(REPOS_DIR, entry.name);
    if (entry.branch) {
        runGitCommand(['check-ref-format', '--branch', entry.branch], { stdio: 'pipe' });
    }
    if (fs.existsSync(repoPath)) {
        if (!reposSvc.isGitRepository(repoPath)) {
            throw new Error(`Cached source is not a Git repository. Inspect '${repoPath}' and move it aside before retrying.`);
        }
        const actualUrl = readCachedRepoSource(repoPath);
        if (normalizeRepoIdentity(actualUrl, repoPath) !== normalizeRepoIdentity(entry.url, process.cwd())) {
            throw new Error(
                `Cached origin URL '${actualUrl}' does not match requested URL '${entry.url}'. ` +
                `Use a different manifest name for the requested source, or inspect and move aside cache '${repoPath}' before retrying.`
            );
        }
        if (entry.branch) {
            const result = reposSvc.ensureRepoOnBranch(entry.name, {
                branch: entry.branch,
                resetRepos: false,
                fallback: 'fail',
                fetchRequestedBranch: true,
                stdio: 'inherit',
            });
            if (result.branch !== entry.branch) {
                throw new Error(`Could not select requested branch '${entry.branch}' (actual '${result.branch || 'unknown'}').`);
            }
        }
        reposSvc.updateRepo(entry.name, { branch: entry.branch, stdio: 'inherit' });
    } else {
        reposSvc.installRepo(entry.url, entry.name, entry.branch, { stdio: 'inherit' });
    }
    const actualBranch = String(runGitCommand(['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })).trim();
    if (entry.branch && actualBranch !== entry.branch) {
        throw new Error(`Expected branch '${entry.branch}', but cached source is on '${actualBranch}'.`);
    }
    return { repoPath, branch: actualBranch, source: sanitizeGitDiagnostic(readCachedRepoSource(repoPath)) };
}

// Low-level copies may only create a fresh destination; managed replacement
// requires the recorded content/mode proof in syncManagedSkillExports.
export function copySkill(srcDir, destDir) {
    if (pathExists(destDir)) throw new Error(`Refusing to replace unverified skill output: ${destDir}`);
    copyFreshSkillTree(srcDir, destDir);
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

    const entries = parseSkillsManifest(manifestPath);

    const destRoot = targetRoot || process.cwd();
    const sourceRepos = [];
    const skillConflicts = [];
    const skillSource = new Map();
    const cacheBranches = new Map();

    for (const entry of entries) {
        try {
            registerManifestCacheBranch(entry, cacheBranches);
        } catch (error) {
            throw skillSourceError(manifestPath, entry, error);
        }
    }

    for (const entry of entries) {
        try {
            // Recheck after earlier sources have been cloned: a previously absent
            // name can now resolve to the same checkout through a filesystem alias.
            registerManifestCacheBranch(entry, cacheBranches);
            const { repoPath, branch, source } = ensureManifestRepoCached(entry);
            registerManifestCacheBranch(entry, cacheBranches);
            const skillsRoot = path.join(repoPath, 'skills');
            if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
                throw new Error(`No skills/ folder in source repo '${entry.name}' (expected ${skillsRoot}).`);
            }
            const availableSkills = listSkillDirectories(skillsRoot);
            const available = new Set(availableSkills);
            for (const skill of entry.skills) {
                if (!available.has(skill)) {
                    const choices = availableSkills.slice(0, 20).join(', ') || '(none)';
                    const remainder = availableSkills.length > 20 ? ` (and ${availableSkills.length - 20} more)` : '';
                    throw new Error(`Skill '${skill}' was not found under '${skillsRoot}'. Available skills: ${choices}${remainder}. Update the manifest to request an available skill, or restore it in the source repository.`);
                }
                const previousSource = skillSource.get(skill);
                if (previousSource) {
                    throw new Error(`Duplicate skill '${skill}' from '${previousSource.source}' and '${entry.name}'; choose one source explicitly.`);
                }
                skillSource.set(skill, {
                    source: entry.name,
                    repoPath,
                    skill,
                    entry,
                });
            }
            sourceRepos.push({
                source,
                name: entry.name,
                branch,
                repoPath,
                skills: entry.skills,
                availableSkills,
            });
        } catch (error) {
            throw skillSourceError(manifestPath, entry, error);
        }
    }

    const incomingSkills = Array.from(skillSource.keys());
    const isGitRepoTarget = reposSvc.isGitRepository(destRoot);
    const agentsSkillsDir = path.join(destRoot, CANONICAL_SKILLS_DIR);
    const managedExport = syncManagedSkillExports({
        folder: destRoot,
        owner: 'manifest',
        sources: [...skillSource.entries()].map(([name, source]) => ({
            name, path: path.join(source.repoPath, 'skills', name),
            source: { name: source.source, url: sanitizeGitDiagnostic(source.entry.url), branch: source.entry.branch },
        })),
    });
    reportExportDiagnostics(managedExport);

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
        repoCount: entries.length,
        repos: sourceRepos.map((repo) => ({
            source: repo.source,
            name: repo.name,
            branch: repo.branch,
            skills: repo.skills,
            availableSkills: repo.availableSkills,
        })),
        skills: incomingSkills,
        targets: [{ agent: 'agents', relDir: CANONICAL_SKILLS_DIR, skills: incomingSkills }],
        destRoot,
        gitignoreUpdated,
        symlinkCreated: claudeLink.changed,
        claudeLink,
        duplicateSkills: skillConflicts,
        managedExport,
        legacyMigration: { migratedSkills: [], skippedExistingSkills: [] },
    };
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

function reportExportDiagnostics(result) {
    for (const entry of result.diagnostics) console.warn(`[skills] '${entry.name}': ${entry.reason}; existing output preserved.`);
}

function ensureClaudeSymlink(destRoot) {
    const claude = path.join(destRoot, CLAUDE_SYMLINK);
    if (!pathExists(claude)) {
        fs.symlinkSync(CANONICAL_AGENT_DIR, claude, 'dir');
        return { changed: true, mode: 'root' };
    }
    if (fs.lstatSync(claude).isSymbolicLink()) {
        return { changed: false, mode: fs.readlinkSync(claude) === CANONICAL_AGENT_DIR ? 'root' : 'preserved' };
    }
    if (fs.lstatSync(claude).isDirectory()) {
        const skills = path.join(claude, 'skills');
        if (!pathExists(skills)) {
            fs.symlinkSync(`../${CANONICAL_SKILLS_DIR}`, skills, 'dir');
            return { changed: true, mode: 'skills' };
        }
        if (fs.lstatSync(skills).isSymbolicLink() && fs.readlinkSync(skills) === `../${CANONICAL_SKILLS_DIR}`) return { changed: false, mode: 'skills' };
    }
    console.warn(`[skills] Independent .claude content preserved at '${claude}'.`);
    return { changed: false, mode: 'preserved' };
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

    const agentsSkillsDir = path.join(destRoot, CANONICAL_SKILLS_DIR);
    const managedExport = syncManagedSkillExports({
        folder: destRoot,
        owner: `defaults:${repoName}`,
        sources: skills.map(name => ({ name, path: path.join(skillsRoot, name), source: { name: repoName } })),
    });
    reportExportDiagnostics(managedExport);
    const legacyMigration = { migratedSkills: [], skippedExistingSkills: [] };

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
        managedExport,
    };
}
