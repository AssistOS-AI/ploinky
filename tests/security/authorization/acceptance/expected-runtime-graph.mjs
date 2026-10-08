#!/usr/bin/env node
/**
 * Derive the expected runtime identity set from pinned manifests.
 *
 * Manifests are read with `git show <sha>:<agent>/manifest.json`; no working
 * tree, live state or workspace profile file is read. The reviewed profile comes
 * from policy.json and is passed explicitly to the canonical
 * manifestEnableEntries(), so its getActiveProfile() fallback never runs. An
 * empty profile, an unresolvable or ambiguous reference, an alias, or an empty
 * set is an error.
 *
 *   node expected-runtime-graph.mjs --pins <pins.json> --check
 *   node expected-runtime-graph.mjs --repo AchillesIDE=/abs/path@<sha> ... --check|--write
 *   node expected-runtime-graph.mjs --workspace-heads <workspace> --check   (provisional: clean HEADs)
 *   --policy <file> substitutes a policy (used by the empty-profile negative control).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manifestEnableEntries, parseEnableDirective } from '../../../../cli/utils/runtime/bootstrapManifest.js';
import { resolveManifestAuthMode } from '../../../../cli/utils/manifestAuth.js';
import { isSsoProviderManifest } from '../../../../cli/utils/agentRegistry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const POLICY_FILE = path.join(here, 'policy.json');
export const EXPECTED_RUNTIMES_FILE = path.join(here, 'expected-runtimes.json');
const SHA = /^[0-9a-f]{40}$/;

export class GraphError extends Error {
    constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

const identity = (repo, agent) => `${repo}/${agent}`;
const byIdentity = (a, b) => identity(a.repo, a.agent).localeCompare(identity(b.repo, b.agent));

/** A source backed by `git show` at exact commits. */
export function gitSource(repositories) {
    const repos = new Map();
    for (const { name, root, commit } of repositories) {
        if (!SHA.test(String(commit))) throw new GraphError('GRAPH_PIN_INVALID', `repository ${name} requires a full commit SHA`);
        if (!path.isAbsolute(String(root))) throw new GraphError('GRAPH_PIN_INVALID', `repository ${name} requires an absolute path`);
        repos.set(name, { root, commit });
    }
    const git = (name, args) => {
        const repo = repos.get(name);
        if (!repo) throw new GraphError('GRAPH_REPOSITORY_UNPINNED', `repository ${name} has no pin`);
        return execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
    };
    return {
        repositories: () => [...repos.keys()],
        commit: (name) => repos.get(name)?.commit,
        listAgents(name) {
            const { commit } = repos.get(name) || {};
            const entries = git(name, ['ls-tree', '--full-tree', commit]).split('\n').filter(Boolean);
            const dirs = entries.filter(line => line.split(/\s+/)[1] === 'tree').map(line => line.split('\t')[1]);
            return dirs.filter(dir => dir !== 'tests' && !dir.startsWith('.')).filter(dir => {
                try { git(name, ['cat-file', '-e', `${commit}:${dir}/manifest.json`]); return true; } catch { return false; }
            }).sort();
        },
        readManifest(name, agent) {
            const { commit } = repos.get(name) || {};
            let text;
            try { text = git(name, ['show', `${commit}:${agent}/manifest.json`]); } catch { return null; }
            return JSON.parse(text);
        },
    };
}

/**
 * Pure derivation over a source with listAgents(repo) and readManifest(repo, agent).
 * Mirrors applyManifestDirectivesInternal (bootstrapManifest.js:338-445) without
 * any workspace mutation: per-directive profile override, same-repo
 * qualification, SSO-provider admission and recursive expansion.
 */
export function deriveExpectedRuntimes({ policy, source }) {
    const profile = typeof policy?.profile === 'string' ? policy.profile.trim() : '';
    if (!profile) throw new GraphError('GRAPH_PROFILE_EMPTY', 'policy.profile must name the reviewed profile; the getActiveProfile() fallback is not allowed');
    const repoNames = (policy.inventoryRepositories || []).map(r => r.name);
    if (!repoNames.length || new Set(repoNames).size !== repoNames.length) throw new GraphError('GRAPH_POLICY_INVALID', 'inventoryRepositories must be a non-empty unique list');
    const excluded = new Set((policy.excludedAgents || []).map(e => e.agent));
    const agentsByRepo = new Map(repoNames.map(name => [name, source.listAgents(name)]));
    const exists = (repo, agent) => agentsByRepo.get(repo)?.includes(agent) === true;

    const resolveRef = (token, parentRepo) => {
        if (token.includes('/') || token.includes(':')) {
            const [repo, agent] = token.split(/[:/]/);
            if (!agentsByRepo.has(repo)) throw new GraphError('GRAPH_REPOSITORY_OUTSIDE_POLICY', `${token} references repository ${repo}`);
            if (!exists(repo, agent)) throw new GraphError('GRAPH_AGENT_UNRESOLVED', `${token} has no manifest at the pinned commit`);
            return { repo, agent };
        }
        // qualifyEnableSpecForRepo: a bare token resolves to the parent repository when it exists there.
        if (parentRepo && exists(parentRepo, token)) return { repo: parentRepo, agent: token };
        const matches = repoNames.filter(repo => exists(repo, token));
        if (matches.length !== 1) throw new GraphError(matches.length ? 'GRAPH_AGENT_AMBIGUOUS' : 'GRAPH_AGENT_UNRESOLVED', `bare reference ${token} matched ${matches.length} repositories`);
        return { repo: matches[0], agent: token };
    };

    const enabled = new Map();
    const declaredRepos = new Set();
    const visited = new Set();
    const [rootRepo, rootAgent] = String(policy.rootAgent || '').split('/');
    if (!rootRepo || !rootAgent || !exists(rootRepo, rootAgent)) throw new GraphError('GRAPH_ROOT_UNRESOLVED', `root ${policy.rootAgent}`);

    const visit = (repo, agent, activeProfile) => {
        const key = `${identity(repo, agent)}::${activeProfile}`;
        if (visited.has(key)) return;
        visited.add(key);
        const manifest = source.readManifest(repo, agent);
        if (!manifest) throw new GraphError('GRAPH_AGENT_UNRESOLVED', `${identity(repo, agent)} manifest unreadable`);
        for (const name of Object.keys(manifest.repos || {})) declaredRepos.add(name);
        for (const raw of manifestEnableEntries(manifest, activeProfile)) {
            const parsed = parseEnableDirective(raw);
            if (!parsed) continue;
            if (parsed.alias) throw new GraphError('GRAPH_ALIAS_UNSUPPORTED', `${identity(repo, agent)} enables an alias; aliased runtimes need a reviewed identity rule`);
            const token = String(parsed.spec).trim().split(/\s+/)[0];
            const child = resolveRef(token, repo);
            const childManifest = source.readManifest(child.repo, child.agent);
            // shouldEnableDirectiveForManifest (bootstrapManifest.js:172-180).
            if (isSsoProviderManifest(childManifest) && resolveManifestAuthMode(manifest) !== 'sso') continue;
            if (excluded.has(child.agent)) throw new GraphError('GRAPH_EXCLUDED_AGENT_ENABLED', `${identity(child.repo, child.agent)} is excluded by policy`);
            enabled.set(identity(child.repo, child.agent), { repo: child.repo, agent: child.agent });
            visit(child.repo, child.agent, parsed.profile || activeProfile);
        }
    };
    enabled.set(identity(rootRepo, rootAgent), { repo: rootRepo, agent: rootAgent });
    visit(rootRepo, rootAgent, profile);

    for (const name of declaredRepos) if (!agentsByRepo.has(name)) throw new GraphError('GRAPH_REPOSITORY_OUTSIDE_POLICY', `manifest repos declares ${name}`);
    const all = repoNames.flatMap(repo => agentsByRepo.get(repo).map(agent => ({ repo, agent }))).filter(a => !excluded.has(a.agent));
    const allKeys = new Set(all.map(a => identity(a.repo, a.agent)));
    if (allKeys.size !== all.length) throw new GraphError('GRAPH_DUPLICATE_IDENTITY', 'duplicate repository/agent identity');
    const enabledList = [...enabled.values()].sort(byIdentity);
    if (!enabledList.length) throw new GraphError('GRAPH_EMPTY', 'no enabled runtime');
    const disabledList = all.filter(a => !enabled.has(identity(a.repo, a.agent))).sort(byIdentity);
    return {
        schema: 'authz-expected-runtimes/1',
        rootAgent: policy.rootAgent,
        profile,
        inventoryRepositories: repoNames,
        counts: { total: all.length, enabled: enabledList.length, disabled: disabledList.length },
        enabled: enabledList,
        disabled: disabledList,
    };
}

function cleanHead(root) {
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (dirty) throw new GraphError('GRAPH_SOURCE_DIRTY', `${root} is not clean`);
    return head;
}

export function repositoriesFromPins(pins, policy) {
    assert.ok(pins && typeof pins.workspace === 'string' && Array.isArray(pins.repositories), 'pins require workspace and repositories');
    return policy.inventoryRepositories.map(({ name, path: rel }) => {
        const pin = pins.repositories.find(r => r.name === name);
        if (!pin) throw new GraphError('GRAPH_REPOSITORY_UNPINNED', `pins have no ${name}`);
        return { name, root: path.join(pins.workspace, pin.path || rel), commit: pin.commit };
    });
}

function parseArgs(argv) {
    const args = { repo: [] };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (key === '--check' || key === '--write') { args.mode = key.slice(2); continue; }
        if (!['--pins', '--repo', '--workspace-heads', '--policy', '--out'].includes(key) || argv[i + 1] === undefined) throw new GraphError('GRAPH_USAGE', `unexpected argument ${key}`);
        if (key === '--repo') args.repo.push(argv[++i]); else args[key.slice(2).replace('-h', 'H')] = argv[++i];
    }
    if (!args.mode) throw new GraphError('GRAPH_USAGE', 'use --check or --write');
    return args;
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const policy = JSON.parse(fs.readFileSync(args.policy || POLICY_FILE, 'utf8'));
    let repositories;
    if (args.pins) repositories = repositoriesFromPins(JSON.parse(fs.readFileSync(args.pins, 'utf8')), policy);
    else if (args.repo.length) repositories = args.repo.map(spec => {
        const match = /^([^=]+)=(\/[^@]+)@([0-9a-f]{40})$/.exec(spec);
        if (!match) throw new GraphError('GRAPH_USAGE', `--repo expects name=/abs/path@<40-hex sha>, got ${spec}`);
        return { name: match[1], root: match[2], commit: match[3] };
    });
    else if (args.workspaceHeads) repositories = policy.inventoryRepositories.map(({ name, path: rel }) => {
        const root = path.join(args.workspaceHeads, rel);
        return { name, root, commit: cleanHead(root) };
    });
    else throw new GraphError('GRAPH_USAGE', 'supply --pins, --repo or --workspace-heads');
    const derived = deriveExpectedRuntimes({ policy, source: gitSource(repositories) });
    console.log(`pinned commits: ${repositories.map(r => `${r.name}@${r.commit}`).join(' ')}`);
    console.log(`profile=${derived.profile} total=${derived.counts.total} enabled=${derived.counts.enabled} disabled=${derived.counts.disabled}`);
    const out = args.out || EXPECTED_RUNTIMES_FILE;
    if (args.mode === 'write') {
        fs.writeFileSync(out, JSON.stringify(derived, null, 2) + '\n');
        console.log(`wrote ${out}`);
        return 0;
    }
    const committed = JSON.parse(fs.readFileSync(out, 'utf8'));
    try { assert.deepEqual(derived, committed); }
    catch { console.error('EXPECTED_RUNTIMES_DRIFT: derived identity set differs from the committed expected-runtimes.json'); return 1; }
    console.log('expected-runtimes.json equals the derived identity set');
    return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.exitCode = await main(); }
    catch (error) { console.error(error?.message || String(error)); process.exitCode = 1; }
}
