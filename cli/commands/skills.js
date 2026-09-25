import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveSkillRepositorySource } from '../utils/skillRepositorySource.js';
import { resolveAgentRepositoryPath } from '../utils/agentRepositorySource.mjs';
import * as reposSvc from '../utils/repos.js';
import { runGitCommand, sanitizeGitDiagnostic } from '../utils/gitCommand.js';
import { syncManagedSkillExports } from '../utils/skills/managedExports.js';
import { createSkillExclusionPlanner } from '../utils/skills/exportExclusions.mjs';
import { readExportLedger, refreshSkillExportExclusions } from '../utils/skills/exportTransaction.mjs';

export const AGENT_SKILL_TARGETS = Object.freeze({
    'claude-code': '.claude/skills',
    'agents':      '.agents/skills',
});
export const SKILLS_MANIFEST_FILE = 'ploinky-skills-manifest.json';

const CANONICAL_AGENT_DIR = '.agents';
const CLAUDE_SYMLINK = '.claude';
const CANONICAL_SKILLS_DIR = AGENT_SKILL_TARGETS['agents'];
const SKILLS_DISCOVERY_IGNORED_DIRS = new Set(['.git', 'node_modules', 'globalDeps', '.ploinky']);

function skillRepositoryPath(name, url = '') {
    const preferred = resolveSkillRepositorySource(name, url);
    return preferred.origin === 'workspace' ? preferred.source : resolveAgentRepositoryPath(name);
}

function ensureRepoCloned(repoName) {
    const repoPath = skillRepositoryPath(repoName);
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

function availableRepoSkills(repoPath, { allowMissing = false } = {}) {
    const skillsRoot = path.join(repoPath, 'skills');
    try {
        if (!fs.statSync(skillsRoot).isDirectory()) throw new Error(`No skills/ folder in repo '${path.basename(repoPath)}' (expected ${skillsRoot}).`);
        return listSkillDirectories(skillsRoot);
    } catch (error) {
        if (allowMissing && error.code === 'ENOENT' && reposSvc.isGitRepository(repoPath)
            && !fs.lstatSync(skillsRoot, { throwIfNoEntry: false })) return [];
        if (error.code === 'ENOENT') throw new Error(`No skills/ folder in repo '${path.basename(repoPath)}' (expected ${skillsRoot}).`);
        throw error;
    }
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

function parseSkillsManifest(rawPath, contents) {
    let rawManifest;
    try {
        rawManifest = contents ?? fs.readFileSync(rawPath, 'utf8');
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
    const repoPath = skillRepositoryPath(entry.name, entry.url);
    return new Error(sanitizeGitDiagnostic(
        `Skills manifest '${manifestPath}', source repo '${entry.name}' ` +
        `(URL '${entry.url}', requested branch '${entry.branch || '(unspecified; cached branch or remote default)'}', ` +
        `cache '${repoPath}'): ${error?.message || String(error)}`
    ));
}

function registerManifestCacheBranch(entry, cacheBranches) {
    const repoPath = path.resolve(skillRepositoryPath(entry.name, entry.url));
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

// Source records of the single update operation set, keyed by checkout.
// Accepts a Map or object keyed by path, or an array of operation records.
function sourceOutcomeLookup(sourceOutcomes) {
    if (!sourceOutcomes) return null;
    const byPath = new Map();
    const pairs = Array.isArray(sourceOutcomes)
        ? sourceOutcomes.map(record => [record?.details?.checkout?.path || record?.id, record])
        : sourceOutcomes instanceof Map ? [...sourceOutcomes.entries()] : Object.entries(sourceOutcomes);
    for (const [key, record] of pairs) if (key) byPath.set(canonicalPath(key), record);
    return checkout => checkout ? byPath.get(canonicalPath(checkout)) : undefined;
}

function canonicalPath(target) {
    try { return fs.realpathSync(target); } catch (_) { return path.resolve(target); }
}

const verifiedSourceRecord = record => record?.outcome === 'changed' || record?.outcome === 'unchanged';

class SkillSourceUnavailable extends Error {
    constructor(code, message, record = null) {
        super(message);
        this.code = code;
        this.record = record;
    }
}

// During `ploinky update` sources are never pulled here: the update's one
// operation set already ran (or refused) each checkout. A skipped or failed
// update left the checkout untouched, so it is used as it is but never
// prunes ('stale'); an uncertain one is not read at all.
function useUpdatedSource(entry, repoPath, outcomeFor) {
    const record = outcomeFor(repoPath);
    if (record?.outcome === 'uncertain' || (record && !verifiedSourceRecord(record) && !['skipped', 'failed'].includes(record.outcome))) {
        throw new SkillSourceUnavailable(record.code || record.outcome, `source update ${record.outcome}: ${record.reason || record.code || 'not verified'}`, record);
    }
    if (record && !verifiedSourceRecord(record)) return 'stale';
    return record ? (record.outcome === 'changed' ? 'updated' : 'current') : 'not-updated';
}

function ensureManifestRepoCached(entry, { outcomeFor = null } = {}) {
    const repoPath = skillRepositoryPath(entry.name, entry.url);
    if (entry.branch) {
        runGitCommand(['check-ref-format', '--branch', entry.branch], { stdio: 'pipe' });
    }
    if (resolveSkillRepositorySource(entry.name, entry.url).origin === 'workspace') {
        const state = outcomeFor ? useUpdatedSource(entry, repoPath, outcomeFor) : 'workspace';
        const actualBranch = String(runGitCommand(['-C', repoPath, 'branch', '--show-current'], { stdio: 'pipe' })).trim() || null;
        if (entry.branch && actualBranch !== entry.branch) {
            throw new Error(`Workspace repository is on '${actualBranch}', not requested branch '${entry.branch}'.`);
        }
        return { repoPath, branch: actualBranch, source: repoPath, state };
    }
    if (outcomeFor && fs.existsSync(repoPath)) {
        if (!reposSvc.isGitRepository(repoPath)) {
            throw new SkillSourceUnavailable('not-a-git-checkout', `Cached source is not a Git repository. Inspect '${repoPath}' and move it aside before retrying.`);
        }
        const actualUrl = readCachedRepoSource(repoPath);
        if (normalizeRepoIdentity(actualUrl, repoPath) !== normalizeRepoIdentity(entry.url, process.cwd())) {
            throw new SkillSourceUnavailable('origin-mismatch', `Cached origin URL '${actualUrl}' does not match requested URL '${entry.url}'.`);
        }
        const state = useUpdatedSource(entry, repoPath, outcomeFor);
        const actualBranch = String(runGitCommand(['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })).trim();
        if (entry.branch && actualBranch !== entry.branch) {
            throw new SkillSourceUnavailable('branch-mismatch', `Expected branch '${entry.branch}', but cached source is on '${actualBranch}'.`);
        }
        return { repoPath, branch: actualBranch, source: sanitizeGitDiagnostic(actualUrl), state };
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
    return { repoPath, branch: actualBranch, source: sanitizeGitDiagnostic(readCachedRepoSource(repoPath)), state: 'ensured' };
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

export function readSkillsManifest(manifestPath) {
    return parseSkillsManifest(manifestPath);
}

/** Install or refresh a folder's manifest skills as one `manifest` owner.
 * The desired set always spans every source of the manifest.
 * `sourceOutcomes` (during `ploinky update` or a targeted refresh) switches to
 * consuming the single operation set: no source is pulled here, and a source
 * whose record is skipped, failed or uncertain, or whose identity cannot be
 * verified, is retained: its selected output is neither refreshed nor pruned.
 */
export function installSkillsFromManifest(manifestPath, { targetRoot, pruneMissing = false, sourceOutcomes = null } = {}) {
    if (!manifestPath || typeof manifestPath !== 'string') {
        throw new Error('Missing skills manifest path.');
    }

    const originalManifest = fs.readFileSync(manifestPath, 'utf8');
    const entries = parseSkillsManifest(manifestPath, originalManifest);
    const prunedSkills = [];

    const destRoot = targetRoot || process.cwd();
    const sourceRepos = [];
    const skillConflicts = [];
    const skillSource = new Map();
    const cacheBranches = new Map();
    const outcomeFor = sourceOutcomeLookup(sourceOutcomes);
    const sourceStates = [];
    const retainedSkills = [];

    for (const entry of entries) {
        try {
            registerManifestCacheBranch(entry, cacheBranches);
        } catch (error) {
            throw skillSourceError(manifestPath, entry, error);
        }
    }

    for (let entry of entries) {
        try {
            // Recheck after earlier sources have been cloned: a previously absent
            // name can now resolve to the same checkout through a filesystem alias.
            registerManifestCacheBranch(entry, cacheBranches);
            let cached;
            let availableSkills;
            try {
                cached = ensureManifestRepoCached(entry, { outcomeFor });
                availableSkills = availableRepoSkills(cached.repoPath, { allowMissing: pruneMissing || cached.state === 'stale' });
            } catch (error) {
                if (!outcomeFor) throw error;
                // Failed or unknown source state never prunes output.
                const checkoutPath = canonicalPath(skillRepositoryPath(entry.name, entry.url));
                sourceStates.push({ name: entry.name, checkoutPath, state: 'retained', code: error.code || 'source-unavailable', reason: sanitizeGitDiagnostic(error.message) });
                retainedSkills.push(...entry.skills);
                continue;
            }
            const { repoPath, branch, source } = cached;
            const sourceRecord = outcomeFor ? outcomeFor(repoPath) : undefined;
            sourceStates.push({ name: entry.name, checkoutPath: canonicalPath(repoPath), state: cached.state, ...(cached.state === 'stale' ? { code: sourceRecord?.code || sourceRecord?.outcome } : {}) });
            registerManifestCacheBranch(entry, cacheBranches);
            const skillsRoot = path.join(repoPath, 'skills');
            const available = new Set(availableSkills);
            if (cached.state === 'stale') {
                // An unrefreshed source proves nothing about removals.
                const missing = entry.skills.filter(skill => !available.has(skill));
                retainedSkills.push(...missing);
                sourceStates[sourceStates.length - 1].missingRetained = missing;
                entry = { ...entry, skills: entry.skills.filter(skill => available.has(skill)) };
            } else if (pruneMissing) {
                const missing = entry.skills.filter(skill => !available.has(skill));
                prunedSkills.push(...missing.map(skill => ({ repository: entry.name, skill })));
                entry.skills = entry.skills.filter(skill => available.has(skill));
            }
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
    // One transaction publishes the links, the pruned manifest (compared
    // against the bytes parsed above), the .claude link and the private
    // local exclusions for the verified owned output.
    const managedExport = syncManagedSkillExports({
        folder: destRoot,
        owner: 'manifest',
        sources: [...skillSource.entries()].map(([name, source]) => ({
            name, path: path.join(source.repoPath, 'skills', name),
            source: { name: source.source, url: sanitizeGitDiagnostic(source.entry.url), branch: source.entry.branch },
        })),
        manifest: {
            path: manifestPath,
            expected: originalManifest,
            next: prunedSkills.length
                ? JSON.stringify(JSON.parse(originalManifest).map((entry, index) => ({ ...entry, skills: entries[index].skills })), null, 2) + '\n'
                : null,
            changedMessage: `Skills manifest changed during update: ${manifestPath}`,
        },
        claude: 'root-or-skills',
        exclusions: skillExclusions({ nonGitBlock: false }),
        retain: retainedSkills,
        consumer: { selection: 'explicit', policy: 'manifest' },
        authority: skillExportAuthority,
    });
    const repositoryOwned = classifyRepositoryOwnedOutput(destRoot, managedExport);
    reportExportDiagnostics(managedExport);
    for (const state of sourceStates.filter(item => item.state === 'retained' || item.state === 'stale')) {
        console.warn(`[skills] Source '${state.name}' was not updated${state.code ? ` (${state.code})` : ''}; nothing is pruned for it.`);
    }
    const claudeLink = reportClaudeLink(destRoot, managedExport);
    const gitignoreUpdated = nonGitBlockWritten(managedExport);

    return {
        manifestPath,
        sources: sourceStates,
        retainedSkills: managedExport.retained,
        repositoryOwned,
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
        exclusions: managedExport.exclusions,
        symlinkCreated: claudeLink.changed,
        claudeLink,
        duplicateSkills: skillConflicts,
        prunedSkills,
        managedExport,
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

// Preserved output that the target repository itself tracks is repository
// content, not a conflict: classify it with the target's own Git index.
function classifyRepositoryOwnedOutput(destRoot, managedExport) {
    const summary = { count: 0, unchanged: [], modified: [] };
    const candidates = managedExport.diagnostics.filter(item => item.reason === 'unrecorded-output-preserved');
    if (!candidates.length) return summary;
    const git = args => { try { return runGitCommand(['-C', destRoot, ...args], { stdio: 'pipe' }); } catch (error) { return error; } };
    for (const item of candidates) {
        const relative = `${CANONICAL_SKILLS_DIR}/${item.name}`;
        const tracked = git(['ls-files', '-z', '--', relative]);
        if (tracked instanceof Error || !String(tracked)) continue;
        const clean = !(git(['diff', '--quiet', '--', relative]) instanceof Error)
            && !String(git(['ls-files', '-z', '--others', '--exclude-standard', '--', relative]) || '');
        item.reason = clean ? 'repository-owned-output-preserved' : 'repository-owned-output-modified-preserved';
        (clean ? summary.unchanged : summary.modified).push(item.name);
        summary.count += 1;
    }
    return summary;
}

function reportExportDiagnostics(result) {
    const owned = result.diagnostics.filter(entry => entry.reason === 'repository-owned-output-preserved');
    if (owned.length) console.log(`[skills] ${owned.length} skill(s) tracked by the target repository are kept as repository content: ${owned.map(entry => entry.name).join(', ')}.`);
    for (const entry of result.diagnostics) {
        if (entry.reason === 'repository-owned-output-preserved') continue;
        if (entry.reason === 'unrecorded-output-preserved') {
            console.warn(`[skills] '${entry.name}': existing output was not created by Ploinky and is kept; move it aside to let Ploinky install this skill.`);
            continue;
        }
        console.warn(`[skills] '${entry.name}': ${entry.reason}; existing output preserved.`);
    }
    if (result.recovery?.status && result.recovery.status !== 'none') {
        console.warn(`[skills] Interrupted skill export ${result.recovery.transaction} was ${result.recovery.status}.`);
    }
    const exclusions = result.exclusions;
    if (exclusions && ['deferred', 'preserved', 'relinquished'].includes(exclusions.status)) {
        console.warn(`[skills] Local exclusions ${exclusions.status} (${exclusions.code}): ${exclusions.reason}`);
    }
    for (const warning of exclusions?.warnings || []) console.warn(`[skills] ${warning.reason}`);
}

// Composing a live external excludes policy requires explicit consent.
function skillExclusions(options) {
    return createSkillExclusionPlanner({ authorizeComposition: process.env.PLOINKY_SKILL_EXCLUDES_COMPOSE === '1', ...options });
}

const nonGitBlockWritten = managedExport => managedExport.exclusions?.mode === 'non-git' && managedExport.exclusions.status === 'published';

// The transaction creates `.claude -> .agents`, or `.claude/skills` inside an
// existing real `.claude` directory; any other .claude content is preserved.
function reportClaudeLink(destRoot, managedExport) {
    const claudeLink = managedExport.artifacts.claude || { changed: false, mode: 'preserved' };
    const claude = path.join(destRoot, CLAUDE_SYMLINK);
    if (claudeLink.mode === 'preserved' && pathExists(claude) && !fs.lstatSync(claude).isSymbolicLink()) {
        console.warn(`[skills] Independent .claude content preserved at '${claude}'.`);
    }
    return claudeLink;
}

// Recorded in the export lock owner record; not a credential.
const skillExportAuthority = { kind: 'ploinky-cli', operation: 'skills-export' };

function ownedDefaultSkills(destRoot, owner) {
    try {
        const { ledger } = readExportLedger(path.join(fs.realpathSync(destRoot), CANONICAL_AGENT_DIR));
        return Object.keys(ledger.entries).filter(name => ledger.entries[name]?.owner === owner);
    } catch (_) {
        return [];
    }
}

/** Export a source repository's default skills into a consumer folder. The
 * consumer takes every available default skill; its ledger records that
 * selection. `sourceOutcomes` makes an update consume the source's single
 * operation record instead of touching the source.
 */
export function installDefaultSkills(repoName, { only, skip, targetRoot, pruneMissing = false, sourceOutcomes = null } = {}) {
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

    const outcomeFor = sourceOutcomeLookup(sourceOutcomes);
    const record = outcomeFor ? outcomeFor(repoPath) : undefined;
    const stale = Boolean(record) && ['skipped', 'failed'].includes(record.outcome);
    if (record && !verifiedSourceRecord(record) && !stale) {
        // Never pull again and never prune: the consumer keeps its output.
        console.warn(`[skills] Default skills from '${repoName}' were not refreshed in ${destRoot} (${record.code || record.outcome}).`);
        return {
            repoName, repoPath, skills: [], targets: [], destRoot, gitignoreUpdated: false, exclusions: null,
            symlinkCreated: false, claudeLink: { changed: false, mode: 'unchanged' },
            managedExport: null, sourceSkipped: { code: record.code || record.outcome, reason: record.reason || '', record },
        };
    }

    const skillsRoot = path.join(repoPath, 'skills');
    const available = availableRepoSkills(repoPath, { allowMissing: pruneMissing || stale });
    const owner = `defaults:${repoName}`;
    // A skipped or failed source update left the checkout as it was: use it,
    // but never prune owned output that it no longer offers.
    const retain = stale ? ownedDefaultSkills(destRoot, owner).filter(name => !available.includes(name)) : [];
    const skills = available;

    // Git targets get private worktree exclusions; a non-git folder keeps a
    // receipt-backed managed block in its own .gitignore.
    const managedExport = syncManagedSkillExports({
        folder: destRoot,
        owner,
        sources: skills.map(name => ({ name, path: path.join(skillsRoot, name), source: { name: repoName } })),
        claude: 'root-or-skills',
        exclusions: skillExclusions({ nonGitBlock: true }),
        consumer: { selection: 'all', source: repoName },
        retain,
        authority: skillExportAuthority,
    });
    const repositoryOwned = classifyRepositoryOwnedOutput(destRoot, managedExport);
    reportExportDiagnostics(managedExport);
    const claudeLink = reportClaudeLink(destRoot, managedExport);
    const targets = [{ agent: 'agents', relDir: CANONICAL_SKILLS_DIR, skills }];
    const gitignoreUpdated = nonGitBlockWritten(managedExport);

    return {
        repoName,
        repoPath,
        skills,
        targets,
        destRoot,
        gitignoreUpdated,
        exclusions: managedExport.exclusions,
        symlinkCreated: claudeLink.changed,
        claudeLink,
        managedExport,
        repositoryOwned,
        sourceState: stale ? 'stale' : record ? (record.outcome === 'changed' ? 'updated' : 'current') : (outcomeFor ? 'not-updated' : 'local'),
        retainedSkills: managedExport.retained,
    };
}

/** Declared skill sources of the manifests in `folders`, for building the
 * update operation set. Reads manifests only; never touches Git or network. */
export function listDeclaredSkillSources(folders = []) {
    const sources = [];
    for (const folder of folders) {
        const manifestPath = findSkillsManifestPath(folder);
        if (!manifestPath) continue;
        let entries;
        try {
            entries = parseSkillsManifest(manifestPath);
        } catch (error) {
            sources.push({ folder, manifestPath, error: sanitizeGitDiagnostic(error.message) });
            continue;
        }
        for (const entry of entries) {
            const resolved = resolveSkillRepositorySource(entry.name, entry.url);
            const checkout = skillRepositoryPath(entry.name, entry.url);
            sources.push({
                folder,
                manifestPath,
                name: entry.name,
                url: sanitizeGitDiagnostic(entry.url),
                branch: entry.branch,
                origin: resolved.origin === 'workspace' ? 'workspace' : 'managed',
                checkoutPath: canonicalPath(checkout),
                exists: fs.existsSync(checkout),
            });
        }
    }
    return sources;
}

/** Targeted refresh: re-evaluate every consumer folder whose manifest
 * declares `sourcePath`, with its complete owner set. Nothing is pulled here;
 * other sources are used as they are. */
export function refreshSkillConsumersForSource({ folders = [], sourcePath, sourceOutcomes = null, pruneMissing = true } = {}) {
    const target = canonicalPath(sourcePath);
    const consumers = [...new Map(listDeclaredSkillSources(folders)
        .filter(item => item.checkoutPath === target)
        .map(item => [item.folder, item])).values()];
    const refreshed = [];
    const failed = [];
    for (const consumer of consumers) {
        try {
            refreshed.push(installSkillsFromManifest(consumer.manifestPath, { targetRoot: consumer.folder, pruneMissing, sourceOutcomes: sourceOutcomes || new Map() }));
        } catch (error) {
            failed.push({ folder: consumer.folder, manifestPath: consumer.manifestPath, message: sanitizeGitDiagnostic(error.message) });
        }
    }
    return { sourcePath: target, refreshed, failed };
}

/** Host-side refresh of local exclusions after a container run deferred
 * them (`exclusions-executor-view-unverified`). Publishes only exclusion
 * artifacts from verified owned output; no skill publication, no pulls. */
export function refreshExportExclusions({ folder, executor = 'host' } = {}) {
    if (!folder) throw new Error('refreshExportExclusions requires a folder');
    return refreshSkillExportExclusions(folder, {
        exclusions: skillExclusions({ nonGitBlock: false }),
        authority: { kind: 'ploinky-cli', operation: 'exclusions-refresh', executor },
    });
}
