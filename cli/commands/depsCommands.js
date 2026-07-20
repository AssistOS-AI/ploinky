import fs from 'fs';
import path from 'path';
import {
    prepareGlobalCache,
    prepareAgentCache,
    readStamp,
    isAgentCacheValid,
    isGlobalCacheValid,
    hashMergedPackage,
    resolveGlobalCacheManifest,
} from '../utils/dependencies/dependencyCache.js';
import { detectRuntimeKeyForAgent, isNoNodeRuntimeKey } from '../utils/dependencies/dependencyRuntimeKey.js';
import {
    DEPS_DIR,
    GLOBAL_DEPS_CACHE_DIR,
    AGENTS_DEPS_CACHE_DIR,
} from '../utils/config.js';
import { loadAgents } from '../utils/workspace.js';
import { findAgent } from '../utils/utils.js';
import {
    readGlobalDepsPackage,
    mergePackageJson,
} from '../utils/dependencies/dependencyInstaller.js';
import { getRepoAgentCodePath } from '../utils/workspaceStructure.js';
import { getRuntimeForAgent } from '../sandbox/docker/common.js';
import { readManifestStartCommand } from '../sandbox/docker/agentCommands.js';

const USAGE = [
    'Usage:',
    '  ploinky deps prepare [<repo>/<agent>]',
    '  ploinky deps status',
    '  ploinky deps clean <repo>/<agent>|--global|--all',
].join('\n');

function enumerateEnabledAgents() {
    const map = loadAgents();
    const out = [];
    for (const [key, rec] of Object.entries(map || {})) {
        if (!rec || rec.type !== 'agent') continue;
        if (!rec.agentName || !rec.repoName) continue;
        if (key === '_config') continue;
        out.push({ repoName: rec.repoName, agentName: rec.agentName });
    }
    return out;
}

function parseRepoAgent(arg) {
    const parts = String(arg || '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Expected <repo>/<agent>, got: ${arg}`);
    }
    return { repoName: parts[0], agentName: parts[1] };
}

function resolveAgentManifest(repoName, agentName) {
    const candidates = [`${repoName}/${agentName}`, agentName];
    for (const ref of candidates) {
        try {
            const resolved = findAgent(ref);
            if (resolved && resolved.manifestPath && fs.existsSync(resolved.manifestPath)) {
                return JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
            }
        } catch (_) {}
    }
    return null;
}

function runtimeKeyForAgent(repoName, agentName) {
    const manifest = resolveAgentManifest(repoName, agentName);
    if (!manifest) {
        throw new Error(`Could not resolve manifest for ${repoName}/${agentName}.`);
    }
    return detectRuntimeKeyForAgent(manifest, repoName, agentName);
}

function resolveAgentPackagePath(repoName, agentName) {
    const codePath = getRepoAgentCodePath(repoName, agentName);
    const pkgPath = path.join(codePath, 'package.json');
    return fs.existsSync(pkgPath) ? pkgPath : null;
}

function agentNeedsDependencyPreparation(repoName, agentName, manifest = null) {
    const resolvedManifest = manifest || resolveAgentManifest(repoName, agentName);
    if (!resolvedManifest) return true;
    const agentPackagePath = resolveAgentPackagePath(repoName, agentName);
    const startCmd = readManifestStartCommand(resolvedManifest);
    return !startCmd || Boolean(agentPackagePath);
}

function prepareOne({ repoName, agentName, runtimeKey, log, runtime = 'bwrap', image = '' }) {
    const agentPackagePath = resolveAgentPackagePath(repoName, agentName);
    return prepareAgentCache({
        repoName,
        agentName,
        runtimeKey,
        agentPackagePath,
        log,
        runtime,
        image,
    });
}

function depsPrepare(args) {
    const log = (msg) => console.log(msg);
    const target = args[0];

    if (target) {
        const { repoName, agentName } = parseRepoAgent(target);
        const manifest = resolveAgentManifest(repoName, agentName);
        if (!agentNeedsDependencyPreparation(repoName, agentName, manifest)) {
            log(`[deps] ${repoName}/${agentName} does not require prepared Node dependencies.`);
            return;
        }
        const runtimeKey = runtimeKeyForAgent(repoName, agentName);
        if (isNoNodeRuntimeKey(runtimeKey)) {
            if (resolveAgentPackagePath(repoName, agentName)) {
                throw new Error(`[deps] ${repoName}/${agentName}: container image has no Node binary but package.json dependencies are present.`);
            }
            log(`[deps] ${repoName}/${agentName} does not require prepared Node dependencies (image has no Node binary).`);
            return;
        }
        log(`[deps] preparing ${repoName}/${agentName} (${runtimeKey})`);
        const result = prepareOne({
            repoName,
            agentName,
            runtimeKey,
            log,
            runtime: manifest ? getRuntimeForAgent(manifest) : 'bwrap',
            image: manifest?.container || manifest?.image || '',
        });
        log(result.reused ? '[deps] reused existing cache' : '[deps] prepared fresh cache');
        return;
    }

    const agents = enumerateEnabledAgents();
    if (!agents.length) {
        log('[deps] no enabled agents found. Enable an agent first, or specify <repo>/<agent>.');
        return;
    }
    const runtimeKeys = new Map();
    for (const { repoName, agentName } of agents) {
        try {
            const manifest = resolveAgentManifest(repoName, agentName);
            if (!agentNeedsDependencyPreparation(repoName, agentName, manifest)) {
                continue;
            }
            const runtimeKey = runtimeKeyForAgent(repoName, agentName);
            if (isNoNodeRuntimeKey(runtimeKey)) {
                if (resolveAgentPackagePath(repoName, agentName)) {
                    console.warn(`[deps] skipping ${repoName}/${agentName}: image has no Node binary but package.json dependencies are present`);
                }
                continue;
            }
            if (!runtimeKeys.has(runtimeKey)) {
                runtimeKeys.set(runtimeKey, {
                    runtime: manifest ? getRuntimeForAgent(manifest) : 'bwrap',
                    image: manifest?.container || manifest?.image || '',
                });
            }
        } catch (err) {
            console.warn(`[deps] skipping runtime-key detection for ${repoName}/${agentName}: ${err.message}`);
        }
    }
    for (const runtimeKey of Array.from(runtimeKeys.keys()).sort()) {
        const meta = runtimeKeys.get(runtimeKey) || {};
        log(`[deps] preparing global cache (${runtimeKey})`);
        prepareGlobalCache(runtimeKey, { log, runtime: meta.runtime, image: meta.image });
    }
    for (const { repoName, agentName } of agents) {
        try {
            const manifest = resolveAgentManifest(repoName, agentName);
            if (!agentNeedsDependencyPreparation(repoName, agentName, manifest)) {
                log(`[deps] skipping ${repoName}/${agentName}: no Node dependency cache required`);
                continue;
            }
            const runtimeKey = runtimeKeyForAgent(repoName, agentName);
            if (isNoNodeRuntimeKey(runtimeKey)) {
                if (resolveAgentPackagePath(repoName, agentName)) {
                    console.warn(`[deps] skipping ${repoName}/${agentName}: image has no Node binary but package.json dependencies are present`);
                } else {
                    log(`[deps] skipping ${repoName}/${agentName}: no Node dependency cache required`);
                }
                continue;
            }
            log(`[deps] preparing ${repoName}/${agentName} (${runtimeKey})`);
            prepareOne({
                repoName,
                agentName,
                runtimeKey,
                log,
                runtime: manifest ? getRuntimeForAgent(manifest) : 'bwrap',
                image: manifest?.container || manifest?.image || '',
            });
        } catch (err) {
            console.warn(`[deps] skipping ${repoName}/${agentName}: ${err.message}`);
        }
    }
}

function describeGlobal(runtimeKey) {
    const cachePath = path.join(GLOBAL_DEPS_CACHE_DIR, runtimeKey);
    const stamp = readStamp(cachePath);
    if (!stamp) return `  global ${runtimeKey}  [no stamp]`;
    let status = '??';
    try {
        // Match prepareGlobalCache: the stamp stores hashMergedPackage(resolved
        // global package), NOT a raw file hash. resolveGlobalCacheManifest() is
        // the same helper prepareGlobalCache uses, so the hashes stay in sync.
        const check = isGlobalCacheValid(cachePath, {
            runtimeKey,
            globalPackageHash: resolveGlobalCacheManifest().hash,
        });
        status = check.valid ? 'valid' : 'stale (' + check.reason + ')';
    } catch (err) {
        status = 'error: ' + err.message;
    }
    return `  global ${runtimeKey}  prepared=${stamp.preparedAt}  ${status}`;
}

function describeAgent(repoName, agentName, runtimeKey) {
    const cachePath = path.join(AGENTS_DEPS_CACHE_DIR, repoName, agentName, runtimeKey);
    const stamp = readStamp(cachePath);
    if (!stamp) return `  ${repoName}/${agentName} ${runtimeKey}  [no stamp]`;
    let status = '??';
    try {
        const agentPkgPath = resolveAgentPackagePath(repoName, agentName);
        const agentPkg = agentPkgPath ? JSON.parse(fs.readFileSync(agentPkgPath, 'utf8')) : null;
        const merged = mergePackageJson(readGlobalDepsPackage(), agentPkg);
        const check = isAgentCacheValid(cachePath, {
            runtimeKey,
            mergedPackageHash: hashMergedPackage(merged),
        });
        status = check.valid ? 'valid' : 'stale (' + check.reason + ')';
    } catch (err) {
        status = 'error: ' + err.message;
    }
    return `  ${repoName}/${agentName} ${runtimeKey}  prepared=${stamp.preparedAt}  ${status}`;
}

function depsStatus() {
    if (!fs.existsSync(DEPS_DIR)) {
        console.log('(no dependency caches; run `ploinky deps prepare` first)');
        return;
    }
    console.log('Global caches:');
    if (fs.existsSync(GLOBAL_DEPS_CACHE_DIR)) {
        const keys = fs.readdirSync(GLOBAL_DEPS_CACHE_DIR).filter((e) => {
            try { return fs.statSync(path.join(GLOBAL_DEPS_CACHE_DIR, e)).isDirectory(); } catch { return false; }
        }).sort();
        if (!keys.length) console.log('  (none)');
        for (const rk of keys) console.log(describeGlobal(rk));
    } else {
        console.log('  (none)');
    }

    console.log('Agent caches:');
    if (!fs.existsSync(AGENTS_DEPS_CACHE_DIR)) {
        console.log('  (none)');
        return;
    }
    const repos = fs.readdirSync(AGENTS_DEPS_CACHE_DIR).sort();
    let agentLineCount = 0;
    for (const repoName of repos) {
        const repoDir = path.join(AGENTS_DEPS_CACHE_DIR, repoName);
        try { if (!fs.statSync(repoDir).isDirectory()) continue; } catch { continue; }
        for (const agentName of fs.readdirSync(repoDir).sort()) {
            const agentDir = path.join(repoDir, agentName);
            try { if (!fs.statSync(agentDir).isDirectory()) continue; } catch { continue; }
            for (const rk of fs.readdirSync(agentDir).sort()) {
                const cachePath = path.join(agentDir, rk);
                try { if (!fs.statSync(cachePath).isDirectory()) continue; } catch { continue; }
                console.log(describeAgent(repoName, agentName, rk));
                agentLineCount += 1;
            }
        }
    }
    if (!agentLineCount) console.log('  (none)');
}

function depsClean(args) {
    const target = args[0];
    if (!target) {
        console.log('Usage: ploinky deps clean <repo>/<agent>|--global|--all');
        return;
    }
    if (target === '--all') {
        if (!fs.existsSync(DEPS_DIR)) {
            console.log('(no deps cache to clean)');
            return;
        }
        console.log(`Removing ${DEPS_DIR}`);
        fs.rmSync(DEPS_DIR, { recursive: true, force: true });
        return;
    }
    if (target === '--global') {
        if (!fs.existsSync(GLOBAL_DEPS_CACHE_DIR)) {
            console.log('(no global cache to clean)');
            return;
        }
        console.log(`Removing ${GLOBAL_DEPS_CACHE_DIR}`);
        fs.rmSync(GLOBAL_DEPS_CACHE_DIR, { recursive: true, force: true });
        return;
    }
    const { repoName, agentName } = parseRepoAgent(target);
    const dir = path.join(AGENTS_DEPS_CACHE_DIR, repoName, agentName);
    if (!fs.existsSync(dir)) {
        console.log(`No cache for ${repoName}/${agentName}`);
        return;
    }
    console.log(`Removing ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
}

export async function handleDepsCommand(options = []) {
    const sub = String(options[0] || '').toLowerCase();
    const rest = options.slice(1);
    switch (sub) {
        case 'prepare':
            depsPrepare(rest);
            return;
        case 'status':
            depsStatus();
            return;
        case 'clean':
            depsClean(rest);
            return;
        case '':
        case 'help':
        case '--help':
            console.log(USAGE);
            return;
        default:
            console.log(`Unknown deps subcommand: ${sub}`);
            console.log(USAGE);
    }
}

export { depsPrepare, depsStatus, depsClean };
