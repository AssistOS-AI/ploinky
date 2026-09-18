import fs from 'node:fs';
import { workspaceRepositories } from './repositorySource.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function repository(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('link-install entries must be Git URLs');
    const raw = value.trim().replace(/^git\+/, '').replace(/^git@([^:]+):/, 'ssh://git@$1/');
    let url;
    try { url = new URL(raw); } catch { throw new Error('Invalid link-install Git URL'); }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash
        || (url.username && (url.protocol !== 'ssh:' || url.username !== 'git'))) {
        throw new Error('link-install requires HTTPS or SSH Git URLs without embedded credentials or refs');
    }
    const repoPath = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    const name = path.posix.basename(repoPath);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name) || name === 'node_modules') throw new Error('Invalid link-install repository name');
    const host = url.hostname.toLowerCase();
    return { url: raw, name, identity: `${host}${url.port ? `:${url.port}` : ''}${host === 'github.com' ? repoPath.toLowerCase() : repoPath}` };
}

export function linkInstallDeclarations(manifest) {
    const values = manifest?.['link-install'];
    if (values === undefined) return [];
    if (!Array.isArray(values)) throw new Error('manifest link-install must be an array of Git URLs');
    const names = new Map();
    for (const value of values) {
        const repo = repository(value);
        if (names.has(repo.name) && names.get(repo.name).identity !== repo.identity) {
            throw new Error(`link-install repository name collision: ${repo.name}`);
        }
        names.set(repo.name, repo);
    }
    return [...names.values()];
}

// Called under the lifecycle workspace mutation lease. Adoption uses create:false.
export function prepareLinkedRepositories(manifest, { workspaceRoot, create = true, writable = false,
    execFile = execFileSync } = {}) {
    const declarations = linkInstallDeclarations(manifest);
    if (!declarations.length) return [];
    const root = fs.realpathSync(workspaceRoot);
    const git = args => execFile('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const origin = directory => {
        // Never inherit the workspace's own origin for a non-repository directory.
        if (!fs.existsSync(path.join(directory, '.git'))) return null;
        try { return repository(String(git(['-C', directory, 'config', '--get', 'remote.origin.url'])).trim()).identity; }
        catch { return null; }
    };
    const known = workspaceRepositories(root).map(entry => ({ directory: entry.directory, identity: origin(entry.directory) }));
    return declarations.map(repo => {
        const matches = known.filter(entry => entry.identity === repo.identity);
        if (matches.length > 1) throw new Error(`Multiple workspace repositories match link-install ${repo.name}`);
        let source = matches[0]?.directory;
        if (!source) {
            source = path.join(root, repo.name);
            if (fs.existsSync(source) || fs.lstatSync(source, { throwIfNoEntry: false })) {
                throw new Error(`link-install target ${repo.name} exists but has a different or missing Git origin`);
            }
            if (!create) throw new Error(`link-install repository ${repo.name} is missing from the workspace`);
            const temporary = fs.mkdtempSync(path.join(root, '.ploinky-link-install-'));
            try {
                // A complete clone is published atomically. Existing checkouts are never fetched/reset.
                git(['-c', 'core.hooksPath=/dev/null', 'clone', '--', repo.url, temporary]);
                if (origin(temporary) !== repo.identity) throw new Error('Cloned repository origin does not match');
                if (fs.existsSync(source)) throw new Error('link-install destination appeared during clone');
                fs.renameSync(temporary, source);
            } catch {
                throw new Error(`Could not clone link-install repository ${repo.name}; check Git access and the workspace destination`);
            } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
            known.push({ directory: source, identity: repo.identity });
        }
        if (!fs.lstatSync(source).isDirectory() || fs.realpathSync(source) !== source || origin(source) !== repo.identity) {
            throw new Error(`link-install repository identity changed: ${repo.name}`);
        }
        // The checkout keeps its workspace path in the agent runtime, matching
        // the same-path project grant of global and development agents.
        return { name: repo.name, source, target: source,
            link: `linked/${repo.name}`, readOnly: !writable };
    });
}
