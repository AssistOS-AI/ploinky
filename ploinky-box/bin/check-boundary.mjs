#!/usr/bin/env node

import fs from 'node:fs';

import { checkBoundary } from '../boundary/checkBoundary.mjs';

function readAllowlist(value) {
    const source = value.trimStart().startsWith('[')
        ? value
        : fs.readFileSync(value, 'utf8');
    const allowlist = JSON.parse(source);
    if (!Array.isArray(allowlist)) {
        throw new TypeError('Allowlist input must contain a JSON array');
    }
    return allowlist;
}

const inputs = process.argv.slice(2);
if (inputs.length !== 4) {
    console.error(
        'Usage: check-boundary.mjs REPOSITORY_ROOT BASE_SHA ALLOWLIST_JSON_OR_PATH MANIFEST_PATH',
    );
    process.exitCode = 2;
} else {
    try {
        const result = checkBoundary(
            inputs[0],
            inputs[1],
            readAllowlist(inputs[2]),
            inputs[3],
        );
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
