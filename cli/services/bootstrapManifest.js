import fs from 'fs';
import path from 'path';
import * as repos from './repos.js';
import { enableAgent } from './agents.js';
import { findAgent } from './utils.js';
import { isSsoProviderManifest } from './agentRegistry.js';

export function parseEnableDirective(entry) {
    if (entry === null || entry === undefined) return null;
    if (typeof entry === 'object' && !Array.isArray(entry)) {
        const rawSpec = entry.agent ?? entry.ref ?? entry.spec ?? entry.name;
        const parsed = parseEnableDirective(rawSpec);
        if (!parsed) return null;
        const alias = entry.alias ?? entry.as ?? parsed.alias;
        const profile = typeof entry.profile === 'string' && entry.profile.trim()
            ? entry.profile.trim().toLowerCase()
            : undefined;
        const noWait = entry.noWait === true || entry['no-wait'] === true || parsed.noWait;
        const result = {
            spec: parsed.spec,
            alias,
            noWait,
        };
        if (profile) result.profile = profile;
        return result;
    }
    const raw = typeof entry === 'string' ? entry : String(entry || '').trim();
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let tokens = trimmed.split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;

    // `no-wait` is an edge-local modifier and can appear anywhere in the
    // directive. Strip every occurrence before parsing alias/spec so the
    // remaining tokens form a clean agent reference.
    let noWait = false;
    tokens = tokens.filter((token) => {
        if (token.toLowerCase() === 'no-wait') {
            noWait = true;
            return false;
        }
        return true;
    });

    const aliasIndex = tokens.findIndex(token => token.toLowerCase() === 'as');
    let alias;
    if (aliasIndex !== -1) {
        if (aliasIndex + 1 >= tokens.length) {
            throw new Error(`manifest enable entry '${entry}' is missing alias name after "as"`);
        }
        alias = tokens[aliasIndex + 1];
        tokens.splice(aliasIndex);
    }

    const spec = tokens.join(' ').trim();
    if (!spec) {
        throw new Error(`manifest enable entry '${entry}' is missing agent reference`);
    }
    return { spec, alias, noWait };
}

function parsePloinkyDirectives(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue.flatMap((item) => parsePloinkyDirectives(item)).filter(Boolean);
    }
    if (typeof rawValue !== 'string') {
        return [];
    }
    return rawValue
        .split(/[,\n;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

function resolveManifestAuthMode(manifest) {
    const ploinkyDirectives = parsePloinkyDirectives(manifest?.ploinky);
    if (ploinkyDirectives.includes('pwd enable')) {
        return 'local';
    }
    if (ploinkyDirectives.includes('sso enable')) {
        return 'sso';
    }
    return 'none';
}

function manifestForDirective(parsedDirective) {
    const spec = String(parsedDirective?.spec || '').trim();
    if (!spec) return null;
    const agentRef = spec.split(/\s+/).filter(Boolean)[0] || '';
    if (!agentRef) return null;
    try {
        const resolved = findAgent(agentRef);
        if (!resolved || !resolved.manifestPath) return null;
        return JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function shouldEnableDirectiveForManifest(parsedDirective, manifest) {
    const spec = String(parsedDirective?.spec || '').trim();
    if (!spec) return false;
    const depManifest = manifestForDirective(parsedDirective);
    if (depManifest && isSsoProviderManifest(depManifest)) {
        return resolveManifestAuthMode(manifest) === 'sso';
    }
    return true;
}

export async function applyManifestDirectives(agentNameOrPath) {
    let manifest;
    let baseDir;
    if (agentNameOrPath.endsWith('.json')) {
        manifest = JSON.parse(fs.readFileSync(agentNameOrPath, 'utf8'));
        baseDir = path.dirname(agentNameOrPath);
    } else {
        const { manifestPath } = findAgent(agentNameOrPath);
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        baseDir = path.dirname(manifestPath);
    }

    const r = manifest.repos;
    if (r && typeof r === 'object') {
        for (const [name, url] of Object.entries(r)) {
            try {
                repos.addRepo(name, url);
            } catch (_) {}
            try {
                repos.enableRepo(name);
            } catch (e) {}
        }
    }

    const en = manifest.enable;
    if (Array.isArray(en)) {
        for (const rawEntry of en) {
            try {
                const parsed = parseEnableDirective(rawEntry);
                if (!parsed) continue;
                if (!shouldEnableDirectiveForManifest(parsed, manifest)) {
                    continue;
                }
                enableAgent(parsed.spec, undefined, undefined, parsed.alias, undefined, {
                    profile: parsed.profile,
                });
            } catch (err) {
                const message = err && err.message ? err.message : String(err);
                console.error(`[manifest enable] Failed to enable agent '${rawEntry}': ${message}`);
            }
        }
    }
}
