#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { attestAgentLibDeployment } from './utils/agentLibDeploymentAttestation.js';

export function runAgentLibAttestationCli({ env = process.env, output = process.stdout } = {}) {
    const proof = attestAgentLibDeployment({ env });
    output.write(`${JSON.stringify(proof)}\n`);
    return proof;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    try {
        runAgentLibAttestationCli();
    } catch (error) {
        process.stderr.write(`agentlib deployment attestation failed: ${error?.message || error}\n`);
        process.exitCode = 1;
    }
}
