import fs from 'node:fs';
import path from 'node:path';
import { workspaceRepositoryPath } from './repositorySource.mjs';
import { PLOINKY_WORKSPACE_ROOT } from './config.js';
import { workspaceCheckoutsAllowed } from './reposSource.mjs';
import { skillsetMDParser } from './skillsetMDParser.mjs';

// Recommendations use the workspace checkout before a managed repository.
// This is discovery only: never clone, pull, or modify either source here.
// With PLOINKY_REPOS_SOURCE=prod only the managed repository is considered.
export function resolveSkillRepositorySource(name, url, { workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '')) return { source: url, origin: 'remote' };
    const workspace = fs.realpathSync(workspaceRoot);
    const candidates = [
        ...(workspaceCheckoutsAllowed()
            ? [['workspace', workspaceRepositoryPath(name, { workspaceRoot: workspace, url }) || path.join(workspace, name)]]
            : []),
        ['installed', path.join(workspace, '.ploinky', 'repos', name)],
    ];
    for (const [origin, candidate] of candidates) {
        try {
            const source = fs.realpathSync(candidate);
            if (!source.startsWith(`${workspace}${path.sep}`) || !fs.statSync(source).isDirectory()) continue;
            // Both ordinary checkouts and Git worktrees count as local repositories.
            const git = fs.statSync(path.join(source, '.git'));
            if (git.isDirectory() || git.isFile()) return { source, origin };
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
    }
    return { source: url, origin: 'remote' };
}

function validDescriptor(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const source = fs.readFileSync(file, 'utf8');
    const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!frontmatter) return null;
    const fields = new Map();
    const lines = frontmatter[1].split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const field = lines[index].match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
        if (!field) continue;
        let value = field[2].trim();
        if (value === '|' || value === '>') {
            value = '';
            while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) value += ' ' + lines[++index].trim();
        }
        fields.set(field[1].toLowerCase(), value.replace(/^(['"])(.*)\1$/, '$2').trim());
    }
    const name = fields.get('name');
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || '') && fields.get('description') ? name : null;
}

// AchillesAgentLib/MainAgent/services/discoverSkills.mjs owns these typed formats.
const AGENTLIB_DESCRIPTORS = new Set(['oskill.md', 'cskill.md', 'dcgskill.md', 'tskill.md']);

function hasAgentLibDescriptors(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && AGENTLIB_DESCRIPTORS.has(entry.name)) return true;
        // Do not follow links or inspect dependencies and repository metadata.
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules'
            && hasAgentLibDescriptors(path.join(directory, entry.name))) return true;
    }
    return false;
}

const SKILLSETS_MAX_BYTES = 1024 * 1024;

// A skill is a real skills/<folder> holding a SKILL.md file, named by its folder. SKILL.md is never read.
function listSkillNames(source) {
    const skillsRoot = path.join(source, 'skills');
    if (!fs.lstatSync(skillsRoot, { throwIfNoEntry: false })?.isDirectory()) return [];
    return fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')
            && fs.lstatSync(path.join(skillsRoot, entry.name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile())
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right));
}

function readSkillsetDefinitions(source, skills) {
    const file = path.join(source, 'skillsets.md');
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isFile() || stat.size > SKILLSETS_MAX_BYTES) throw new Error('Invalid skillsets.md: expected a regular file of at most 1 MiB');
    return skillsetMDParser(fs.readFileSync(file, 'utf8'), skills);
}

// The skills and root skillsets.md declarations of one local checkout. A broken declaration is
// reported as a warning, so it cannot hide the repository's skills or fail the whole listing.
export function readRepositorySkillCatalog(source) {
    const catalog = { skills: [], skillsets: [], warnings: [] };
    try {
        catalog.skills = listSkillNames(source);
        catalog.skillsets = readSkillsetDefinitions(source, catalog.skills);
    } catch (error) {
        catalog.warnings.push(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)
            ? `Repository skills could not be read (${error.code})` : error.message);
    }
    return catalog;
}

export function listWorkspaceSkillRepositories({ workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    if (!workspaceCheckoutsAllowed()) return [];
    const workspace = fs.realpathSync(workspaceRoot);
    const repositories = [];
    for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        try {
            const source = path.join(workspace, entry.name);
            const git = fs.statSync(path.join(source, '.git'));
            if (!git.isDirectory() && !git.isFile()) continue;
            const skillsRoot = path.join(source, 'skills');
            if (!fs.lstatSync(skillsRoot).isDirectory()) continue;
            if (hasAgentLibDescriptors(skillsRoot)) continue;
            const children = fs.readdirSync(skillsRoot, { withFileTypes: true });
            const folders = children.filter(child => child.isDirectory() && !child.name.startsWith('.'));
            if (!folders.length || children.some(child => child.isSymbolicLink())) continue;
            const warnings = [];
            const names = [];
            for (const child of folders) {
                const descriptor = path.join(skillsRoot, child.name, 'SKILL.md');
                if (!fs.lstatSync(descriptor, { throwIfNoEntry: false })) {
                    warnings.push(`skills/${child.name}: missing SKILL.md`);
                    continue;
                }
                names.push(validDescriptor(descriptor));
            }
            if (names.some(name => !name) || new Set(names).size !== names.length) continue;
            repositories.push({ name: entry.name, source, origin: 'workspace', ...(warnings.length ? { warnings } : {}) });
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error;
        }
    }
    return repositories.sort((left, right) => left.name.localeCompare(right.name));
}
