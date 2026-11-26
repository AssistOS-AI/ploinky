#!/usr/bin/env node
// Behaviour-neutrality of added manifest profiles (AC11):
//
//   node tests/tools/profileEquivalence.mjs --base <rev> [--allow agent/profile,...] <repoRoot>
//
// Adding `dev`, `qa` and `prod` profiles to a manifest must not change what any
// of the four environment names launches. For every agent directory of the
// repository root that already has a manifest at <rev>, the profile each name
// resolves to (the same resolver the runtime uses, non-explicit) must carry the
// same launch configuration and network at <rev> and now. The resolved name
// itself is not compared: `prod` resolving to `default` before and to `prod`
// after is exactly the change being made.
//
// Exit status: 0 = equivalent (differences that are allowlisted are listed but
// do not fail); 1 = a non-allowlisted difference; 2 = usage or git error.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ENVIRONMENT_PROFILES } from '../../cli/utils/runtime/profileFollow.mjs';
import { resolveManifestProfile } from '../../cli/utils/runtime/profileService.js';

// Agent/profile pairs known to differ on purpose.
export const DEFAULT_ALLOWLIST = Object.freeze(['webmeetScribeAgent/prod']);

function usage(message) {
    if (message) console.error(message);
    console.error('Usage: node tests/tools/profileEquivalence.mjs --base <rev> [--allow agent/profile,...] <repoRoot>');
    return 2;
}

function gitShow(root, rev, relativePath) {
    try {
        return execFileSync('git', ['-C', root, 'show', `${rev}:./${relativePath}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 16 * 1024 * 1024,
        });
    } catch (_) {
        return null;
    }
}

function launchView(manifest, name, label) {
    const resolution = resolveManifestProfile(manifest, name, { agentName: label, explicit: false });
    const { network, ...config } = resolution.profileConfig || {};
    return { config, network: resolution.network };
}

export function compareManifests(baseManifest, nextManifest, label) {
    const differences = [];
    for (const name of ENVIRONMENT_PROFILES) {
        let before;
        let after;
        try {
            before = launchView(baseManifest, name, label);
            after = launchView(nextManifest, name, label);
        } catch (error) {
            differences.push({ profile: name, detail: `does not resolve (${String(error?.message || error).slice(0, 120)})` });
            continue;
        }
        if (!isDeepStrictEqual(before.network, after.network)) {
            differences.push({ profile: name, detail: 'network differs' });
        }
        const keys = new Set([...Object.keys(before.config), ...Object.keys(after.config)]);
        for (const key of [...keys].sort()) {
            if (!isDeepStrictEqual(before.config[key], after.config[key])) {
                differences.push({ profile: name, detail: `'${key}' differs` });
            }
        }
    }
    return differences;
}

export function main(argv) {
    let base;
    let allow = [...DEFAULT_ALLOWLIST];
    const roots = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--base') {
            base = argv[i + 1];
            i += 1;
        } else if (arg === '--allow') {
            allow = String(argv[i + 1] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
            i += 1;
        } else if (arg.startsWith('--')) {
            return usage(`unknown option '${arg}'`);
        } else {
            roots.push(arg);
        }
    }
    if (!base) return usage('--base <rev> is required.');
    if (roots.length !== 1) return usage('exactly one repository root is required.');
    const root = path.resolve(roots[0]);
    try {
        execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${base}^{commit}`], { stdio: 'ignore' });
    } catch (_) {
        return usage(`'${base}' is not a revision of ${root}.`);
    }
    let compared = 0;
    let failed = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const relativePath = `${entry.name}/manifest.json`;
        const nextPath = path.join(root, relativePath);
        if (!fs.existsSync(nextPath)) continue;
        const baseText = gitShow(root, base, relativePath);
        if (baseText === null) {
            console.log(`NEW ${entry.name}: no manifest at ${base}; nothing to compare`);
            continue;
        }
        let baseManifest;
        let nextManifest;
        try {
            baseManifest = JSON.parse(baseText);
            nextManifest = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
        } catch (error) {
            console.error(`FAIL ${entry.name}: manifest is not valid JSON (${String(error?.message || error).slice(0, 80)})`);
            failed += 1;
            continue;
        }
        compared += 1;
        for (const difference of compareManifests(baseManifest, nextManifest, `${path.basename(root)}/${entry.name}`)) {
            const key = `${entry.name}/${difference.profile}`;
            if (allow.includes(key)) {
                console.log(`ALLOWED ${key}: ${difference.detail}`);
            } else {
                console.error(`FAIL ${key}: ${difference.detail}`);
                failed += 1;
            }
        }
    }
    if (failed) return 1;
    if (compared === 0) return usage('no manifest could be compared; nothing was proven.');
    console.log(`EQUIVALENT ${compared} manifests against ${base}`);
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    process.exitCode = main(process.argv.slice(2));
}
