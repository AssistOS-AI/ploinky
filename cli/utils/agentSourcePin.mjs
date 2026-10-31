// The source pin of an enabled agent.
//
// Ploinky resolves an agent's repository folder by name, and by Git origin
// when no folder carries the repository's name. A new top-level folder can
// therefore change which folder a repository name resolves to. Enable records
// the folder it chose (`sourceIdentity`), and every later start, restart,
// reinstall and watchdog restart compares the folder resolved now with that
// pin: a different folder is refused until the operator enables the agent
// again. Nothing here switches a source on its own.
//
// The pin is the repository root's real path, the repository name and its Git
// origin identity. Device and inode numbers are deliberately not part of it:
// a managed checkout that is cloned again into the same path (the empty
// checkout repair, or a reinstalled repository) gets a new inode, and the
// device number of a bind-mounted workspace is not guaranteed across Box
// recreation.

import fs from 'node:fs';
import path from 'node:path';

import { PLOINKY_WORKSPACE_ROOT, REPOS_DIR } from './config.js';
import { repositoryOrigin } from './repositorySource.mjs';

export const AGENT_SOURCE_CHANGED = 'PLOINKY_AGENT_SOURCE_CHANGED';

function canonicalPath(target) {
    const resolved = path.resolve(String(target || ''));
    try { return fs.realpathSync(resolved); }
    catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return resolved;
        throw error;
    }
}

/** The repository root that holds an agent directory (`<repo>/<agent>`). */
export function agentRepositoryRoot(agentPath) {
    return path.dirname(path.resolve(String(agentPath || '')));
}

/**
 * The identity of the folder an agent currently resolves to. An origin that
 * cannot be read (no `.git`, Git unavailable or timed out) is recorded as ''.
 */
export function agentSourceIdentity({ repoName, agentPath, originOf = repositoryOrigin } = {}) {
    const realpath = canonicalPath(agentRepositoryRoot(agentPath));
    let origin = '';
    try { origin = String(originOf(realpath) || ''); } catch (_) { origin = ''; }
    return { repoName: String(repoName || ''), origin, realpath };
}

function validPin(pin) {
    return Boolean(pin && typeof pin === 'object' && !Array.isArray(pin)
        && typeof pin.repoName === 'string' && pin.repoName
        && typeof pin.realpath === 'string' && path.isAbsolute(pin.realpath)
        && typeof pin.origin === 'string');
}

/**
 * Compare a recorded pin with the current identity.
 * Returns { status: 'unpinned' | 'match' | 'mismatch', reasons }.
 * Only a missing pin is 'unpinned'; a malformed pin is a mismatch. An origin
 * that cannot be read now (or could not be read at enable) proves nothing on
 * its own, so only two readable, different origins count as a change.
 */
export function compareAgentSourcePin(pin, current) {
    if (pin === undefined || pin === null) return { status: 'unpinned', reasons: [] };
    if (!validPin(pin)) return { status: 'mismatch', reasons: ['pin'] };
    const reasons = [];
    if (pin.repoName !== String(current?.repoName || '')) reasons.push('repository');
    if (pin.realpath !== String(current?.realpath || '')) reasons.push('folder');
    if (pin.origin && current?.origin && pin.origin !== current.origin) reasons.push('origin');
    return { status: reasons.length ? 'mismatch' : 'match', reasons };
}

export function displaySourcePath(target, workspaceRoot = PLOINKY_WORKSPACE_ROOT) {
    const value = String(target || '');
    if (!value) return '(unknown folder)';
    const root = canonicalPath(workspaceRoot);
    const relative = path.relative(root, value);
    if (!relative) return 'the workspace root';
    return relative.startsWith('..') || path.isAbsolute(relative) ? value : relative;
}

function originText(origin) {
    return origin ? ` (Git origin ${origin})` : ' (no readable Git origin)';
}

export function reEnableCommand({ repoName, agentName, alias = '' } = {}) {
    return `ploinky enable agent ${repoName}/${agentName}${alias ? ` as ${alias}` : ''}`;
}

/** The plain refusal for an agent whose source no longer matches its pin. */
export function agentSourceChangedError({ repoName, agentName, alias = '', pin, current, workspaceRoot } = {}) {
    const pinned = validPin(pin)
        ? `${displaySourcePath(pin.realpath, workspaceRoot)}${originText(pin.origin)}`
        : 'a folder Ploinky can no longer read from its record';
    const error = new Error(
        `Agent '${repoName}/${agentName}' was enabled from ${pinned}, but its source now resolves to `
        + `${displaySourcePath(current?.realpath, workspaceRoot)}${originText(current?.origin)}. `
        + 'Ploinky does not move an enabled agent to a different folder on its own, so it will not start or restart this agent. '
        + `If the new folder is the one you want, run '${reEnableCommand({ repoName, agentName, alias })}' to accept it; `
        + 'otherwise remove or rename the folder that took its place.',
    );
    error.code = AGENT_SOURCE_CHANGED;
    error.status = 409;
    error.pinnedSource = validPin(pin) ? { ...pin } : null;
    error.currentSource = current ? { ...current } : null;
    return error;
}

function readRoutes(workspaceRoot) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(path.resolve(workspaceRoot), '.ploinky', 'routing.json'), 'utf8'));
        return parsed?.routes && typeof parsed.routes === 'object' && !Array.isArray(parsed.routes) ? parsed.routes : {};
    } catch (_) {
        return {};
    }
}

/**
 * For a record enabled before pins existed: the repository root it was
 * launched from, read from its own `/code` bind (or a same-path agent bind of
 * a native runtime), else from its route `hostPath`. Null when the record
 * carries no such evidence.
 */
export function legacySourceRoot(record, { routes } = {}) {
    const agentName = String(record?.agentName || '');
    if (!agentName) return null;
    const rootOf = (agentDirectory) => path.dirname(agentDirectory);
    const agentDirectoryOf = (source) => {
        const resolved = path.resolve(source);
        if (path.basename(resolved) === agentName) return resolved;
        if (path.basename(resolved) === 'code' && path.basename(path.dirname(resolved)) === agentName) return path.dirname(resolved);
        return null;
    };
    const binds = Array.isArray(record?.config?.binds) ? record.config.binds : [];
    for (const bind of binds) {
        if (!bind || typeof bind.source !== 'string' || !bind.source || bind.target !== '/code') continue;
        const directory = agentDirectoryOf(bind.source);
        if (directory) return rootOf(directory);
    }
    for (const bind of binds) {
        if (!bind || typeof bind.source !== 'string' || !bind.source || bind.target !== bind.source) continue;
        const directory = agentDirectoryOf(bind.source);
        if (directory && fs.existsSync(path.join(directory, 'manifest.json'))) return rootOf(directory);
    }
    for (const route of Object.values(routes || {})) {
        if (!route || route.repo !== record.repoName || route.agent !== agentName
            || String(route.alias || '') !== String(record.alias || '')) continue;
        if (typeof route.hostPath === 'string' && route.hostPath.trim()) return rootOf(path.resolve(route.hostPath.trim()));
    }
    return null;
}

/**
 * Check a registry record's pin against the folder an agent resolves to now.
 * Throws AGENT_SOURCE_CHANGED on a mismatch; returns the comparison otherwise.
 * A record without a pin (enabled before pins existed) is held to the folder
 * its own binds or route recorded; only a record with no such evidence at all
 * is admitted unchecked.
 */
export function assertAgentSourcePin(record, {
    repoName,
    agentName,
    agentPath,
    originOf = repositoryOrigin,
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    routes = undefined,
} = {}) {
    let pin = record && typeof record === 'object' ? record.sourceIdentity : undefined;
    let status = 'match';
    if (pin === undefined || pin === null) {
        const legacyRoot = record && typeof record === 'object'
            ? legacySourceRoot(record, { routes: routes === undefined ? readRoutes(workspaceRoot) : routes })
            : null;
        if (!legacyRoot) return { status: 'unpinned', reasons: [], current: null };
        pin = { repoName: String(record.repoName || repoName || ''), origin: '', realpath: canonicalPath(legacyRoot) };
        status = 'provisional';
    }
    const current = agentSourceIdentity({ repoName, agentPath, originOf: status === 'provisional' ? () => '' : originOf });
    const comparison = compareAgentSourcePin(pin, current);
    if (comparison.status === 'mismatch') {
        throw agentSourceChangedError({
            repoName: repoName || record?.repoName,
            agentName: agentName || record?.agentName,
            alias: record?.alias || '',
            pin,
            current,
            workspaceRoot,
        });
    }
    return { ...comparison, status: status === 'provisional' ? 'provisional' : comparison.status, current };
}

/**
 * The pin a launch writes into the rebuilt registry record: the launched
 * record's own pin, unchanged. A record enabled before pins existed has none
 * and is pinned here to the folder this launch admitted (the preflight has
 * already compared any existing pin), once, with one log line. A missing pin
 * is the only case that is not refused.
 */
export function launchSourceIdentity(records, { repoName, agentName, agentPath, log = console.log,
    originOf = repositoryOrigin, workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    for (const record of records) {
        const pin = record && typeof record === 'object' ? record.sourceIdentity : undefined;
        if (pin !== undefined && pin !== null) return structuredClone(pin);
    }
    const pin = agentSourceIdentity({ repoName, agentPath, originOf });
    try {
        log(`[source-pin] ${repoName}/${agentName}: recorded source ${displaySourcePath(pin.realpath, workspaceRoot)}`
            + `${originText(pin.origin)}; it was enabled before Ploinky recorded agent sources, and later launches `
            + 'refuse any other folder.');
    } catch (_) {}
    return pin;
}

/**
 * Enabled agents that a launch would refuse because of their source, as
 * [{ containerName, repoName, agentName, message }]: a pin that no longer
 * matches, or a repository two workspace folders claim. Read-only.
 */
export function collectAgentSourceProblems(agents, { resolveRepositoryPath, originOf = repositoryOrigin,
    workspaceRoot = PLOINKY_WORKSPACE_ROOT } = {}) {
    const problems = [];
    for (const [containerName, record] of Object.entries(agents || {})) {
        if (!record || typeof record !== 'object' || record.type !== 'agent' || containerName.startsWith('_')) continue;
        const repoName = String(record.repoName || '');
        const agentName = String(record.agentName || '');
        if (!repoName || !agentName) continue;
        try {
            const agentPath = path.join(resolveRepositoryPath(repoName), agentName);
            assertAgentSourcePin(record, { repoName, agentName, agentPath, originOf, workspaceRoot });
        } catch (error) {
            if (error?.code !== AGENT_SOURCE_CHANGED && error?.code !== 'PLOINKY_REPOSITORY_AMBIGUOUS') continue;
            problems.push({ containerName, repoName, agentName, code: error.code, message: error.message });
        }
    }
    return problems;
}

/** The workspace registry (agents.json), read directly; missing is empty, corrupt throws. */
export function readRegisteredAgents({ workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT || PLOINKY_WORKSPACE_ROOT } = {}) {
    const file = path.join(path.resolve(workspaceRoot), '.ploinky', 'agents.json');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) {
        if (error?.code === 'ENOENT') return {};
        throw error;
    }
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/**
 * The folder the enabled agents of one repository are pinned to:
 * { path: string|null, agents: [...] }. Pins that disagree with each other
 * throw, so an update never picks one of them silently.
 */
export function pinnedRepositoryPath(repoName, agents) {
    const pinned = new Map();
    for (const [containerName, record] of Object.entries(agents || {})) {
        if (!record || record.type !== 'agent' || record.repoName !== repoName) continue;
        const pin = record.sourceIdentity;
        if (!validPin(pin)) continue;
        if (!pinned.has(pin.realpath)) pinned.set(pin.realpath, []);
        pinned.get(pin.realpath).push(record.alias || record.agentName || containerName);
    }
    if (pinned.size > 1) {
        const error = new Error(`Repository '${repoName}' has enabled agents pinned to different folders `
            + `(${[...pinned.keys()].map(entry => displaySourcePath(entry)).join(', ')}). Enable each of its agents again `
            + `from the folder you want ('ploinky enable agent ${repoName}/<agent>'); until then they do not start and the repository is not updated.`);
        // The repository is unresolved, like one two workspace folders claim:
        // per-repository loops skip it by this code, launches of it refuse.
        error.code = 'PLOINKY_REPOSITORY_AMBIGUOUS';
        error.repositoryName = repoName;
        error.candidates = [...pinned.keys()];
        throw error;
    }
    const [[folder, names] = [null, []]] = [...pinned.entries()];
    return { path: folder, agents: names };
}

/**
 * Per repository name, the folder its enabled agents are pinned to:
 * Map name -> { path } or { error } when their pins disagree.
 */
export function repositoryPins(agents) {
    const names = new Set();
    for (const record of Object.values(agents || {})) {
        if (record?.type === 'agent' && typeof record.repoName === 'string' && validPin(record.sourceIdentity)) names.add(record.repoName);
    }
    const pins = new Map();
    for (const name of names) {
        try { pins.set(name, { path: pinnedRepositoryPath(name, agents).path }); }
        catch (error) { pins.set(name, { error }); }
    }
    return pins;
}

/** A recorded link-install pin: { name, origin, realpath } with an absolute realpath. */
export function validLinkPin(entry) {
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
        && typeof entry.name === 'string' && entry.name
        && typeof entry.origin === 'string' && entry.origin
        && typeof entry.realpath === 'string' && path.isAbsolute(entry.realpath) && !entry.realpath.includes('\0'));
}

/** How the resolver arrived at a folder, for the first-enable report. */
export function describeSourceChoice(identity, { reposDir = REPOS_DIR } = {}) {
    const realpath = String(identity?.realpath || '');
    const managed = canonicalPath(reposDir);
    const relative = path.relative(managed, realpath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return 'the installed copy under .ploinky/repos';
    }
    if (path.basename(realpath) === identity?.repoName) {
        return 'the workspace folder named after the repository';
    }
    return 'a workspace folder found by an origin scan (its Git origin matches the registered repository)';
}

/**
 * The line enable prints when it records a pin: always on a first enable, and
 * when an explicit re-enable moves the pin. Returns '' when nothing changed.
 */
export function sourcePinReport({ repoName, agentName, pin, previousPin, workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    reposDir = REPOS_DIR } = {}) {
    if (!validPin(pin)) return '';
    const where = `${displaySourcePath(pin.realpath, workspaceRoot)}${originText(pin.origin)}`;
    const how = describeSourceChoice(pin, { reposDir });
    if (previousPin === undefined || previousPin === null) {
        return `[enable] ${repoName}/${agentName}: source ${where}, chosen as ${how}. `
            + 'Later starts refuse to run it from any other folder. Before enabling an agent from a folder that '
            + 'automated tools could write, review its contents.';
    }
    if (compareAgentSourcePin(previousPin, pin).status === 'match') return '';
    const before = validPin(previousPin)
        ? `${displaySourcePath(previousPin.realpath, workspaceRoot)}${originText(previousPin.origin)}`
        : 'an unreadable earlier record';
    return `[enable] ${repoName}/${agentName}: source moved from ${before} to ${where}, chosen as ${how}.`;
}

export default {
    AGENT_SOURCE_CHANGED,
    agentRepositoryRoot,
    agentSourceChangedError,
    agentSourceIdentity,
    assertAgentSourcePin,
    compareAgentSourcePin,
    describeSourceChoice,
    displaySourcePath,
    reEnableCommand,
    sourcePinReport,
};
