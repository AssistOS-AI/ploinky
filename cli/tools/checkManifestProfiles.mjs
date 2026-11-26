#!/usr/bin/env node
// Standalone manifest profile checker for repository roots (no workspace):
//
//   node cli/tools/checkManifestProfiles.mjs [--require default,dev,qa,prod] <repoRoot>...
//
// A repository root holds one directory per agent, each with a manifest.json
// (the layout `ploinky` installs). It applies the same rules as
// `ploinky profile check`.
//
// Exit status: 0 = every manifest passes and at least one was found;
// 1 = any manifest fails; 2 = usage error, an unreadable root or no manifest
// found, which is never a pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkManifestText, parseRequiredProfiles } from '../utils/runtime/profileRules.mjs';

function usage(message) {
    if (message) console.error(message);
    console.error('Usage: node cli/tools/checkManifestProfiles.mjs [--require a,b] <repoRoot>...');
    return 2;
}

// One manifest per agent directory directly below the repository root.
export function listRepositoryManifests(root) {
    const found = [];
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
        throw new Error(`cannot read repository root '${root}' (${error?.code || 'error'})`);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const manifestPath = path.join(root, entry.name, 'manifest.json');
        if (fs.existsSync(manifestPath)) found.push(manifestPath);
    }
    return found;
}

export function checkRepositoryRoots(roots, required) {
    const failures = [];
    const rootErrors = [];
    let manifests = 0;
    for (const root of roots) {
        let paths;
        try {
            paths = listRepositoryManifests(path.resolve(root));
        } catch (error) {
            rootErrors.push(error.message);
            continue;
        }
        for (const manifestPath of paths) {
            manifests += 1;
            const label = `${path.basename(path.resolve(root))}/${path.basename(path.dirname(manifestPath))}`;
            let text;
            try {
                text = fs.readFileSync(manifestPath, 'utf8');
            } catch (error) {
                failures.push(`${label}: manifest unreadable (${error?.code || 'error'})`);
                continue;
            }
            for (const issue of checkManifestText(text, required)) failures.push(`${label}: ${issue}`);
        }
    }
    return { manifests, failures, rootErrors };
}

export function main(argv) {
    let requireValue;
    const roots = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--require') {
            requireValue = argv[i + 1];
            if (requireValue === undefined) return usage('--require needs a comma-separated list of profile names.');
            i += 1;
        } else if (arg.startsWith('--require=')) {
            requireValue = arg.slice('--require='.length);
        } else if (arg.startsWith('--')) {
            return usage(`unknown option '${arg}'`);
        } else {
            roots.push(arg);
        }
    }
    if (!roots.length) return usage('no repository root given.');
    let required;
    try {
        required = parseRequiredProfiles(requireValue);
    } catch (error) {
        return usage(error.message);
    }
    const { manifests, failures, rootErrors } = checkRepositoryRoots(roots, required);
    for (const failure of failures) console.error(`FAIL ${failure}`);
    for (const rootError of rootErrors) console.error(`ERROR ${rootError}`);
    if (failures.length) {
        console.error(`FAILED ${failures.length} issue${failures.length === 1 ? '' : 's'} in ${manifests} manifests (required: ${required.join(', ')})`);
        return 1;
    }
    if (rootErrors.length) return usage('a repository root could not be read; nothing was proven for it.');
    if (manifests === 0) return usage('no manifests were found; nothing was checked.');
    console.log(`OK ${manifests} manifests`);
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    process.exitCode = main(process.argv.slice(2));
}
