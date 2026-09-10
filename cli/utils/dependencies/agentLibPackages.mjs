import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AGENTLIB_CACHE_LINK_NAME, AGENTLIB_PACKAGE_NAME } from '../../../agentlib/contract.mjs';

export const AGENTLIB_CACHE_NAMES = Object.freeze([AGENTLIB_CACHE_LINK_NAME, AGENTLIB_PACKAGE_NAME]);
export const AGENTLIB_ADAPTER_SCHEMA = 1;

function cacheError(message) {
    return new Error(`Unsafe AgentLib dependency cache: ${message}`);
}

/**
 * Find npm's hoisted, scoped and nested package placements. Local-package links
 * remain supported, but their sources are inspected read-only: a private
 * AgentLib there cannot be repaired by mutating an external checkout.
 */
export function agentLibPackagePaths(cachePath, target, { fsApi = fs } = {}) {
    const modules = path.resolve(cachePath, 'node_modules');
    const aliases = new Set(AGENTLIB_CACHE_NAMES.map((name) => path.join(modules, name)));
    const visited = new Set();

    function realDirectory(directory, optional = false) {
        let stat;
        try { stat = fsApi.lstatSync(directory); }
        catch (error) {
            if (optional && error.code === 'ENOENT') return false;
            throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw cacheError(`${directory} must be a real directory`);
        }
        return true;
    }

    function readManifest(directory) {
        const manifest = path.join(directory, 'package.json');
        try {
            const manifestStat = fsApi.lstatSync(manifest);
            if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
                throw cacheError(`${manifest} must be a real file`);
            }
            return JSON.parse(fsApi.readFileSync(manifest, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return null;
        }
    }

    function externalCopyError(directory) {
        return cacheError(`AgentLib outside the owned cache at ${directory}; install the linked dependency as a package copy so Ploinky can bind it to the selected source`);
    }

    function selectedPath(candidate, entry = false) {
        try {
            const selected = fsApi.realpathSync(target);
            const actual = fsApi.realpathSync(candidate);
            return actual === selected || (entry && actual.startsWith(`${selected}${path.sep}`));
        } catch { return false; }
    }

    function recordAlias(directory, owned) {
        if (owned) {
            aliases.add(directory);
            return;
        }
        const stat = fsApi.lstatSync(directory);
        if (stat.isSymbolicLink() && fsApi.readlinkSync(directory) === target) return;
        if (selectedPath(directory)) return;
        throw externalCopyError(directory);
    }

    function visitPackage(directory, name, owned) {
        if (AGENTLIB_CACHE_NAMES.includes(name)) return recordAlias(directory, owned);
        const stat = fsApi.lstatSync(directory);
        if (stat.isSymbolicLink()) {
            if (fsApi.readlinkSync(directory) === target) return recordAlias(directory, owned);
            const source = fsApi.realpathSync(directory);
            // Repair an npm alias's link itself, never its external source.
            if (owned && AGENTLIB_CACHE_NAMES.includes(readManifest(source)?.name)) {
                recordAlias(directory, true);
                if (source.startsWith(`${modules}${path.sep}`)) recordAlias(source, true);
                return;
            }
            return visitPackage(source, name, false);
        }
        if (!stat.isDirectory()) return;
        const pkg = readManifest(directory);
        // npm aliases can install the same package under a different name.
        if (AGENTLIB_CACHE_NAMES.includes(pkg?.name)) return recordAlias(directory, owned);
        if (!owned) {
            for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
                for (const dependency of AGENTLIB_CACHE_NAMES) {
                    if (!Object.hasOwn(pkg?.[field] || {}, dependency)) continue;
                    try {
                        const require = createRequire(path.join(directory, 'package.json'));
                        if (selectedPath(require.resolve(dependency), true)) continue;
                    } catch { /* missing or differently resolved framework */ }
                    throw externalCopyError(directory);
                }
            }
        }
        visitModules(path.join(directory, 'node_modules'), true, owned);
    }

    function visitModules(directory, optional = false, owned = true) {
        let stat;
        try { stat = fsApi.lstatSync(directory); }
        catch (error) {
            if (optional && error.code === 'ENOENT') return;
            throw error;
        }
        if (stat.isSymbolicLink()) return visitModules(fsApi.realpathSync(directory), false, false);
        realDirectory(directory);
        const key = `${owned}:${fsApi.realpathSync(directory)}`;
        if (visited.has(key)) return;
        visited.add(key);
        for (const name of fsApi.readdirSync(directory).sort()) {
            // npm metadata and command links are not package placements.
            if (name.startsWith('.')) continue;
            const entry = path.join(directory, name);
            if (name.startsWith('@')) {
                const scopeLinked = fsApi.lstatSync(entry).isSymbolicLink();
                const scope = scopeLinked ? fsApi.realpathSync(entry) : entry;
                realDirectory(scope);
                for (const child of fsApi.readdirSync(scope).sort()) {
                    visitPackage(path.join(scope, child), `${name}/${child}`, owned && !scopeLinked);
                }
            } else {
                visitPackage(entry, name, owned);
            }
        }
    }

    realDirectory(modules);
    visitModules(modules);
    return [...aliases].sort();
}
