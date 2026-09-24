import fs from 'node:fs';
import path from 'node:path';
import { PLOINKY_WORKSPACE_ROOT } from './config.js';
import { MARKETPLACE_OWNER, publishSkillExports, withSkillExportLocks } from './skills/exportTransaction.mjs';
import { createSkillExclusionPlanner } from './skills/exportExclusions.mjs';

const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const invalid = message => Object.assign(new Error(message), { code: 'REPOSITORY_INSTALL_INVALID' });

// Canonicalize the deepest existing ancestor of `parent` and re-append the
// components that do not exist yet. Missing components cannot be links.
function canonicalParent(parent) {
    const missing = [];
    let existing = parent;
    while (!fs.lstatSync(existing, { throwIfNoEntry: false })) {
        const up = path.dirname(existing);
        if (up === existing) break;
        missing.unshift(path.basename(existing));
        existing = up;
    }
    try {
        return path.join(fs.realpathSync(existing), ...missing);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') {
            throw invalid('destination parent escapes workspace or is not a directory');
        }
        throw error;
    }
}

function ancestorInside(requested, root) {
    for (let dir = path.dirname(requested); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
        try { if (inside(root, canonicalParent(dir))) return true; } catch (_) {}
    }
    return false;
}

// Resolve parents to their canonical location, but never dereference the
// final link for removal or replacement. `root` must already be canonical.
// Returns the canonical destination, which callers must use for publication.
function destinationPath(value, root, create = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw invalid('destination must be an absolute workspace path');
    const requested = path.resolve(value);
    if (requested === path.parse(requested).root) throw invalid('destination must be inside the workspace');
    const parent = canonicalParent(path.dirname(requested));
    const destination = path.join(parent, path.basename(requested));
    if (!inside(root, destination) || destination === root) {
        // A path whose ancestor is really inside the workspace escaped through a link.
        if (destination !== root && ancestorInside(requested, root)) throw invalid('destination parent escapes workspace or is not a directory');
        throw invalid('destination must be inside the workspace');
    }
    let current = root;
    for (const part of path.relative(root, parent).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        let info = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!info && create) { fs.mkdirSync(current); info = fs.lstatSync(current); }
        if (info) {
            const canonical = fs.realpathSync(current);
            if (canonical !== current || !inside(root, canonical) || !fs.statSync(current).isDirectory()) throw invalid('destination parent escapes workspace or is not a directory');
        }
    }
    return destination;
}

// linkParent is the final runtime parent when a staged directory will be mounted
// or moved (for example `/Agent/linked`); it is deliberately not canonicalized.
// Without it, link text and idempotence use the canonical destination parent.
export function ensureRepositoryLink(destination, source, root, { linkParent } = {}) {
    const canonicalDestination = destinationPath(destination, fs.realpathSync(root), true);
    const parent = linkParent ?? path.dirname(canonicalDestination);
    const existing = fs.lstatSync(canonicalDestination, { throwIfNoEntry: false });
    if (existing) {
        if (existing.isSymbolicLink() && path.resolve(parent, fs.readlinkSync(canonicalDestination)) === source) {
            return { destination: canonicalDestination, source, status: 'present' };
        }
        return { destination: canonicalDestination, source, status: 'conflict' };
    }
    fs.symlinkSync(path.relative(parent, source), canonicalDestination, 'dir');
    return { destination: canonicalDestination, source, status: 'installed' };
}

function sourcePath(repository, relative, root) {
    if (!repository || typeof repository.source !== 'string') throw invalid('repository is not installed');
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw invalid('invalid repository subdirectory');
    const base = fs.realpathSync(repository.source);
    const source = fs.realpathSync(path.join(base, relative));
    if (!inside(root, base) || !inside(base, source) || !fs.statSync(source).isDirectory()) throw invalid('source must be a directory inside its workspace repository');
    return source;
}

const exportLink = (staged, target, root, skills) => ensureRepositoryLink(staged, target, root, { linkParent: skills });
// Marketplace changes refresh the target's private exclusions like every
// other participating skill export operation.
const marketplaceExclusions = () => createSkillExclusionPlanner({ authorizeComposition: process.env.PLOINKY_SKILL_EXCLUDES_COMPOSE === '1' });
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Skill links are published through the skill export transaction under the
// marketplace owner; only links the transaction creates become owned.
// `repos` links are ordinary workspace links outside the skill ledger.
export function installRepositoryLinks(input, { workspaceRoot = PLOINKY_WORKSPACE_ROOT, resolveRepository, authority = null, lock = {} } = {}) {
    const root = fs.realpathSync(workspaceRoot);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('install requires repos and/or skillRepos');
    const repos = input.repos || [], skillRepos = input.skillRepos || [];
    if (!Array.isArray(repos) || !Array.isArray(skillRepos) || repos.length + skillRepos.length > 1000) throw invalid('invalid installation batch');
    const links = [], directories = new Set(), targets = new Map();
    for (const entry of repos) {
        const destination = destinationPath(entry.destination, root);
        links.push({ destination, source: sourcePath(resolveRepository(entry.repoName), entry.sourcePath || '', root), kind: 'repository' });
    }
    for (const entry of skillRepos) {
        if (typeof entry.destination !== 'string' || !path.isAbsolute(entry.destination)) throw invalid('destination must be an absolute workspace path');
        const destination = path.dirname(destinationPath(path.join(path.resolve(entry.destination), '.validation'), root));
        if (!Array.isArray(entry.skills) || entry.skills.length > 1000) throw invalid('skills must be an explicit array');
        const repository = entry.skills.length ? resolveRepository(entry.repoName) : null;
        // The `.claude` link text is computed against these canonical paths.
        const skills = path.dirname(destinationPath(path.join(destination, '.agents', 'skills', '.validation'), root));
        const agents = path.dirname(skills);
        directories.add(skills);
        if (!targets.has(destination)) targets.set(destination, new Map());
        links.push({ destination: path.join(destination, '.claude'), source: agents, kind: 'claude' });
        for (const name of entry.skills) {
            if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw invalid('invalid skill name');
            const source = sourcePath(repository, `skills/${name}`, root);
            if (!fs.lstatSync(path.join(source, 'SKILL.md')).isFile()) throw invalid(`missing SKILL.md: ${name}`);
            links.push({ destination: path.join(skills, name), source, kind: 'skill' });
            targets.get(destination).set(name, { name, path: source, source: { name: entry.repoName } });
        }
    }
    const planned = new Map();
    for (const link of links) {
        if (planned.has(link.destination) && planned.get(link.destination).source !== link.source) throw invalid('conflicting destinations in installation batch');
        planned.set(link.destination, link);
    }
    // Validate all sources and parents before starting publication. Existing data is never overwritten.
    for (const directory of directories) destinationPath(path.join(directory, '.validation'), root, true);
    const statuses = new Map();
    // Every target export lock of the batch is held before any publication.
    const exclusions = marketplaceExclusions();
    withSkillExportLocks([...targets.keys()], handles => {
        for (const handle of handles) {
            const published = publishSkillExports(handle, {
                owner: MARKETPLACE_OWNER, policy: 'additive', mode: 'symlink', linker: exportLink,
                sources: [...targets.get(handle.root).values()], claude: 'root-strict', exclusions, lock,
            });
            for (const status of published.statuses) statuses.set(status.destination, status);
            const claude = published.artifacts.claude;
            statuses.set(path.join(handle.root, '.claude'), {
                status: claude?.mode !== 'root' ? 'conflict' : claude.changed ? 'installed' : 'present',
            });
        }
    }, { ...lock, exclusions, authority: lock.authority ?? authority });
    const results = [...planned.values()].map(link => {
        if (link.kind === 'repository') return ensureRepositoryLink(link.destination, link.source, root);
        const status = statuses.get(link.destination);
        return { destination: link.destination, source: link.source, status: status?.status || 'conflict', ...(status?.reason ? { reason: status.reason } : {}) };
    });
    return { results, conflicts: results.filter(result => result.status === 'conflict') };
}

function skillExportDestination(destination) {
    const skills = path.dirname(destination);
    const agents = path.dirname(skills);
    if (path.basename(skills) !== 'skills' || path.basename(agents) !== '.agents' || !SKILL_NAME.test(path.basename(destination))) return null;
    return { folder: path.dirname(agents), name: path.basename(destination) };
}

// Exported skill links are removed only when the marketplace owner created
// them and they are unchanged; other output is preserved and reported.
export function removeRepositoryLinks(paths, { workspaceRoot = PLOINKY_WORKSPACE_ROOT, authority = null, lock = {} } = {}) {
    const root = fs.realpathSync(workspaceRoot);
    if (!Array.isArray(paths) || paths.length > 1000) throw invalid('remove requires an array of destination paths');
    const destinations = [...new Set(paths.map(value => destinationPath(value, root)))];
    const skillTargets = new Map();
    for (const destination of destinations) {
        const target = skillExportDestination(destination);
        if (!target) continue;
        if (!skillTargets.has(target.folder)) skillTargets.set(target.folder, []);
        skillTargets.get(target.folder).push(target.name);
    }
    const statuses = new Map();
    if (skillTargets.size) {
        const exclusions = marketplaceExclusions();
        withSkillExportLocks([...skillTargets.keys()], handles => {
            for (const handle of handles) {
                const removed = publishSkillExports(handle, { owner: MARKETPLACE_OWNER, policy: 'remove', removeNames: skillTargets.get(handle.root), exclusions, lock });
                for (const status of removed.statuses) statuses.set(status.destination, status);
            }
        }, { ...lock, exclusions, authority: lock.authority ?? authority, create: false });
    }
    const results = destinations.map(destination => {
        if (skillExportDestination(destination)) {
            const status = statuses.get(destination);
            if (status) return { destination, status: status.status, ...(status.reason ? { reason: status.reason } : {}) };
            // No export folder exists, so nothing can be owned there.
            return { destination, status: fs.lstatSync(destination, { throwIfNoEntry: false }) ? 'conflict' : 'absent' };
        }
        const info = fs.lstatSync(destination, { throwIfNoEntry: false });
        if (!info) return { destination, status: 'absent' };
        if (!info.isSymbolicLink()) return { destination, status: 'conflict' };
        fs.unlinkSync(destination);
        return { destination, status: 'removed' };
    });
    return { results, conflicts: results.filter(result => result.status === 'conflict') };
}
