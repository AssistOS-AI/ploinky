import fs from 'node:fs';
import { workspaceRepositories } from './repositorySource.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertSourceSetFixed } from './runtime/sourceProtectionGate.mjs';
import { AGENT_SOURCE_CHANGED, displaySourcePath, validLinkPin } from './agentSourcePin.mjs';

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
// `branchPolicy.branch` (the start's `--branch`) selects the branch of a new
// clone and is checked, never applied, against an existing workspace checkout.
// Without it no remote is queried and no branch is inspected.
// `pinned` is the agent record's `linkedRepositories` ({ name, origin,
// realpath }) recorded at its first launch: a pinned declaration mounts exactly
// that folder, without searching the workspace, and refuses (never substitutes
// or clones) when the folder is gone, replaced, or carries another origin.
export function prepareLinkedRepositories(manifest, { workspaceRoot, create = true, writable = false,
    execFile = execFileSync, branchPolicy = null, log = console.log, pinned = null } = {}) {
    const declarations = linkInstallDeclarations(manifest);
    if (!declarations.length) return [];
    const pins = new Map();
    if (pinned !== null && pinned !== undefined) {
        if (!Array.isArray(pinned) || !pinned.every(validLinkPin)) {
            throw linkPinError('the recorded link-install checkouts of this agent are malformed', null, workspaceRoot);
        }
        for (const pin of pinned) pins.set(pin.name, pin);
    }
    const requestedBranch = branchPolicy?.branch || null;
    const strict = branchPolicy?.fallback === 'fail';
    const root = fs.realpathSync(workspaceRoot);
    // A writable link-install alias of a source checkout changes the protected source set (inert without a store).
    if (writable) assertSourceSetFixed({ workspaceRoot: root, kind: 'link-install-writable' });
    const git = args => execFile('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const origin = directory => {
        // Never inherit the workspace's own origin for a non-repository directory.
        if (!fs.existsSync(path.join(directory, '.git'))) return null;
        try { return repository(String(git(['-C', directory, 'config', '--get', 'remote.origin.url'])).trim()).identity; }
        catch { return null; }
    };
    // Read only when an unpinned declaration needs the origin scan.
    let knownEntries = null;
    const known = () => {
        knownEntries ||= workspaceRepositories(root).map(entry => ({ directory: entry.directory, identity: origin(entry.directory) }));
        return knownEntries;
    };
    const checkedOutBranch = directory => {
        try { return String(git(['-C', directory, 'symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null; }
        catch { return null; }
    };
    // The branch to honour for this repository, or null when the requested one
    // is absent from the remote (or the remote cannot be queried) and the
    // fallback policy allows the repository's own default or current branch.
    const branchFor = (repo, outcome) => {
        if (!requestedBranch) return null;
        // Same timeout and non-interactive environment as the clone.
        let listing;
        try { listing = String(git(['ls-remote', '--heads', repo.url, `refs/heads/${requestedBranch}`])); }
        catch { listing = null; }
        if (listing?.trim()) return requestedBranch;
        if (listing === null) {
            if (strict) {
                throw new Error(`Could not query the remote of repo '${repo.name}' for branch '${requestedBranch}'. Aborting (--branch-fallback fail).`);
            }
            log(`[link-install] Could not query the remote for '${repo.name}' to check branch '${requestedBranch}'; ${outcome}.`);
            return null;
        }
        if (strict) {
            throw new Error(`Branch '${requestedBranch}' does not exist on remote for repo '${repo.name}'. Aborting (--branch-fallback fail).`);
        }
        log(`[link-install] Branch '${requestedBranch}' not found on remote for '${repo.name}'; ${outcome}.`);
        return null;
    };
    return declarations.map(repo => {
        const pin = pins.get(repo.name);
        if (pin) {
            const refuse = problem => { throw linkPinError(problem, pin, root, repo.name); };
            if (pin.origin !== repo.identity) refuse('its manifest now declares a different repository');
            const stat = fs.lstatSync(pin.realpath, { throwIfNoEntry: false });
            if (!stat) refuse('that folder no longer exists');
            if (!stat.isDirectory() || fs.realpathSync(pin.realpath) !== pin.realpath) refuse('that folder was replaced');
            if (origin(pin.realpath) !== repo.identity) refuse('its Git origin is no longer the declared repository');
            if (requestedBranch) {
                const branch = branchFor(repo, 'keeping the recorded checkout');
                const current = branch && checkedOutBranch(pin.realpath);
                if (branch && current !== branch) {
                    throw new Error(`link-install repository ${repo.name} is on '${current || 'detached HEAD'}', not requested branch '${branch}'; switch it yourself (Ploinky never modifies workspace checkouts)`);
                }
            }
            return { name: repo.name, source: pin.realpath, target: pin.realpath,
                link: `linked/${repo.name}`, readOnly: !writable };
        }
        const matches = known().filter(entry => entry.identity === repo.identity);
        if (matches.length > 1) {
            throw new Error(`Multiple workspace repositories match link-install ${repo.name}: `
                + `${matches.map(entry => `'${path.basename(entry.directory)}'`).sort().join(' and ')} both have its Git origin. `
                + 'Remove or rename the folder that should not supply it.');
        }
        let source = matches[0]?.directory;
        if (!source) {
            source = path.join(root, repo.name);
            if (fs.existsSync(source) || fs.lstatSync(source, { throwIfNoEntry: false })) {
                throw new Error(`link-install target ${repo.name} exists but has a different or missing Git origin`);
            }
            if (!create) throw new Error(`link-install repository ${repo.name} is missing from the workspace`);
            assertSourceSetFixed({ workspaceRoot: root, kind: 'link-install-clone' });
            const cloneBranch = branchFor(repo, 'falling back to default branch');
            const temporary = fs.mkdtempSync(path.join(root, '.ploinky-link-install-'));
            try {
                // A complete clone is published atomically. Existing checkouts are never fetched/reset.
                git(['-c', 'core.hooksPath=/dev/null', 'clone', ...(cloneBranch ? ['--branch', cloneBranch] : []), '--', repo.url, temporary]);
                if (origin(temporary) !== repo.identity) throw new Error('Cloned repository origin does not match');
                if (fs.existsSync(source)) throw new Error('link-install destination appeared during clone');
                fs.renameSync(temporary, source);
            } catch {
                throw new Error(`Could not clone link-install repository ${repo.name}; check Git access and the workspace destination`);
            } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
            known().push({ directory: source, identity: repo.identity });
        }
        if (!fs.lstatSync(source).isDirectory() || fs.realpathSync(source) !== source || origin(source) !== repo.identity) {
            throw new Error(`link-install repository identity changed: ${repo.name}`);
        }
        if (requestedBranch && matches.length) {
            // An adopted checkout belongs to the developer: report, never switch.
            const branch = branchFor(repo, 'keeping the existing checkout');
            const current = branch && checkedOutBranch(source);
            if (branch && current !== branch) {
                throw new Error(`link-install repository ${repo.name} is on '${current || 'detached HEAD'}', not requested branch '${branch}'; switch it yourself (Ploinky never modifies workspace checkouts)`);
            }
        }
        // The checkout keeps its workspace path in the agent runtime, matching
        // the same-path project grant of global and development agents.
        return { name: repo.name, source, target: source,
            link: `linked/${repo.name}`, readOnly: !writable };
    });
}

function linkPinError(problem, pin, root, name = pin?.name || '') {
    const where = pin ? ` was recorded at ${displaySourcePath(pin.realpath, root)} (Git origin ${pin.origin}) when this agent was first launched, but` : '';
    const error = new Error(`link-install repository ${name}${where} ${problem}. Ploinky does not substitute another `
        + 'checkout: restore that folder, or enable the agent again to record a new one.');
    error.code = AGENT_SOURCE_CHANGED;
    error.status = 409;
    return error;
}

/** The link-install pins a launch records: { name, origin, realpath } per mounted checkout. */
export function linkedRepositoryPins(manifest, mounts) {
    const identities = new Map(linkInstallDeclarations(manifest).map(repo => [repo.name, repo.identity]));
    return mounts.map(({ name, source }) => ({ name, origin: identities.get(name) || '', realpath: source }));
}

// `start --branch` resolves every link-install repository of the whole admitted
// graph once, in the parent and before any agent (including a detached no-wait
// worker) launches, so a mismatch or `--branch-fallback fail` stops the start.
// The per-agent preparation later adopts the checkouts resolved here.
export function preflightLinkedRepositories(manifests, options = {}) {
    if (!options.branchPolicy?.branch) return [];
    const unique = new Map();
    for (const manifest of manifests) {
        for (const declaration of linkInstallDeclarations(manifest)) {
            if (!unique.has(declaration.identity)) unique.set(declaration.identity, declaration.url);
        }
    }
    return prepareLinkedRepositories({ 'link-install': [...unique.values()] }, { ...options, create: true });
}
