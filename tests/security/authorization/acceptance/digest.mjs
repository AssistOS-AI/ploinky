#!/usr/bin/env node
/**
 * Policy digest: sha256 over the sorted (name, length, bytes) records of the
 * four committed acceptance files. The external pins.json records this value;
 * capture and the live run recompute it from the pinned checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ACCEPTANCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const POLICY_FILES = Object.freeze(['expected-gaps.json', 'expected-runtimes.json', 'mandatory-checks.json', 'policy.json']);

export function policyDigest(dir = ACCEPTANCE_DIR, { readFile = fs.readFileSync } = {}) {
    const hash = createHash('sha256');
    for (const name of [...POLICY_FILES].sort()) {
        const bytes = readFile(path.join(dir, name));
        hash.update(`${name}\0${bytes.length}\0`);
        hash.update(bytes);
    }
    return hash.digest('hex');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dir = process.argv[2] ? path.resolve(process.argv[2]) : ACCEPTANCE_DIR;
    console.log(policyDigest(dir));
}
