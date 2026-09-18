import fs from 'node:fs';
import path from 'node:path';
import { PLOINKY_WORKSPACE_ROOT } from './config.js';

const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const invalid = message => Object.assign(new Error(message), { code: 'REPOSITORY_INSTALL_INVALID' });

// Resolve parents, but never dereference the final link for removal or replacement.
function destinationPath(value, root, create = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw invalid('destination must be an absolute workspace path');
    const destination = path.resolve(value);
    if (!inside(root, destination) || destination === root) throw invalid('destination must be inside the workspace');
    let current = root;
    for (const part of path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        let info = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!info && create) { fs.mkdirSync(current); info = fs.lstatSync(current); }
        if (info) {
            const canonical = fs.realpathSync(current);
            if (!inside(root, canonical) || !fs.statSync(current).isDirectory()) throw invalid('destination parent escapes workspace or is not a directory');
        }
    }
    return destination;
}

// linkParent is the final runtime parent when a staged directory will be mounted or moved.
export function ensureRepositoryLink(destination, source, root, { linkParent = path.dirname(destination) } = {}) {
    destinationPath(destination, root, true);
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (existing) {
        if (existing.isSymbolicLink() && path.resolve(linkParent, fs.readlinkSync(destination)) === source) {
            return { destination, source, status: 'present' };
        }
        return { destination, source, status: 'conflict' };
    }
    fs.symlinkSync(path.relative(linkParent, source), destination, 'dir');
    return { destination, source, status: 'installed' };
}

function sourcePath(repository, relative, root) {
    if (!repository || typeof repository.source !== 'string') throw invalid('repository is not installed');
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw invalid('invalid repository subdirectory');
    const base = fs.realpathSync(repository.source);
    const source = fs.realpathSync(path.join(base, relative));
    if (!inside(root, base) || !inside(base, source) || !fs.statSync(source).isDirectory()) throw invalid('source must be a directory inside its workspace repository');
    return source;
}

export function installRepositoryLinks(input, { workspaceRoot = PLOINKY_WORKSPACE_ROOT, resolveRepository } = {}) {
    const root = fs.realpathSync(workspaceRoot);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('install requires repos and/or skillRepos');
    const repos = input.repos || [], skillRepos = input.skillRepos || [];
    if (!Array.isArray(repos) || !Array.isArray(skillRepos) || repos.length + skillRepos.length > 1000) throw invalid('invalid installation batch');
    const links = [], directories = new Set();
    for (const entry of repos) {
        const destination = destinationPath(entry.destination, root);
        links.push({ destination, source: sourcePath(resolveRepository(entry.repoName), entry.sourcePath || '', root) });
    }
    for (const entry of skillRepos) {
        if (typeof entry.destination !== 'string' || !path.isAbsolute(entry.destination)) throw invalid('destination must be an absolute workspace path');
        const destination = path.resolve(entry.destination);
        destinationPath(path.join(destination, '.validation'), root);
        if (!Array.isArray(entry.skills) || entry.skills.length > 1000) throw invalid('skills must be an explicit array');
        const repository = entry.skills.length ? resolveRepository(entry.repoName) : null;
        const agents = path.join(destination, '.agents');
        const skills = path.join(agents, 'skills');
        destinationPath(path.join(skills, '.validation'), root);
        directories.add(skills);
        links.push({ destination: path.join(destination, '.claude'), source: agents });
        for (const name of entry.skills) {
            if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw invalid('invalid skill name');
            const source = sourcePath(repository, `skills/${name}`, root);
            if (!fs.lstatSync(path.join(source, 'SKILL.md')).isFile()) throw invalid(`missing SKILL.md: ${name}`);
            links.push({ destination: path.join(skills, name), source });
        }
    }
    const planned = new Map();
    for (const link of links) {
        if (planned.has(link.destination) && planned.get(link.destination) !== link.source) throw invalid('conflicting destinations in installation batch');
        planned.set(link.destination, link.source);
    }
    // Validate all sources and parents before starting publication. Existing data is never overwritten.
    for (const directory of directories) destinationPath(path.join(directory, '.validation'), root, true);
    const results = [...planned].map(([destination, source]) => ensureRepositoryLink(destination, source, root));
    return { results, conflicts: results.filter(result => result.status === 'conflict') };
}

export function removeRepositoryLinks(paths, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    const root = fs.realpathSync(workspaceRoot);
    if (!Array.isArray(paths) || paths.length > 1000) throw invalid('remove requires an array of destination paths');
    const destinations = [...new Set(paths.map(value => destinationPath(value, root)))];
    const results = destinations.map(destination => {
        const info = fs.lstatSync(destination, { throwIfNoEntry: false });
        if (!info) return { destination, status: 'absent' };
        if (!info.isSymbolicLink()) return { destination, status: 'conflict' };
        fs.unlinkSync(destination);
        return { destination, status: 'removed' };
    });
    return { results, conflicts: results.filter(result => result.status === 'conflict') };
}
