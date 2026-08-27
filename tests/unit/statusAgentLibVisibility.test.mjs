import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AGENTLIB_ATTESTED_ENTRYPOINTS } from '../../agentlib/contract.mjs';

// status.js reaches the Router security graph, whose JWT adapters deliberately
// require an AgentLib source at module load. Give this isolated test process a
// minimal source before importing the renderer under test.
const moduleFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-status-agentlib-module-'));
fs.mkdirSync(path.join(moduleFixture, 'jwt'), { recursive: true });
fs.writeFileSync(path.join(moduleFixture, 'package.json'), '{"name":"ploinky-agent-lib","type":"module"}\n');
fs.writeFileSync(path.join(moduleFixture, 'jwt', 'jwtSign.mjs'), [
    'export const signHmacJwt = () => {};',
    'export const bodyHashForRequest = () => {};',
    'export const canonicalJson = () => {};',
].join('\n'));
fs.writeFileSync(path.join(moduleFixture, 'jwt', 'jwtVerify.mjs'), [
    'export const verifyJws = () => {};',
    'export const verifyInvocationToken = () => {};',
    'export const createMemoryReplayCache = () => {};',
    'export const canonicalJson = () => {};',
    'export const bodyHashForRequest = () => {};',
    'export const MAX_TTL_SECONDS = 1;',
    'export const DEFAULT_CLOCK_SKEW_SECONDS = 0;',
].join('\n'));
const previousAgentLibDir = process.env.PLOINKY_AGENTLIB_DIR;
process.env.PLOINKY_AGENTLIB_DIR = moduleFixture;
const { formatAgentLibRuntimeProof } = await import('../../cli/utils/status.js');
if (previousAgentLibDir === undefined) delete process.env.PLOINKY_AGENTLIB_DIR;
else process.env.PLOINKY_AGENTLIB_DIR = previousAgentLibDir;
fs.rmSync(moduleFixture, { recursive: true, force: true });

const sha = (character) => character.repeat(64);

function admittedRuntime() {
    const fingerprint = sha('a');
    const sourceIdHash = sha('b');
    const runtimePath = '/opt/ploinky-agentlib';
    return {
        state: { running: true },
        agentLib: {
            fingerprint,
            sourceIdHash,
            runtimePath,
        },
        agentLibAttestation: {
            schemaVersion: 1,
            deploymentFingerprint: fingerprint,
            sourceIdHash,
            sourceRootRealpath: runtimePath,
            packageJsonHash: sha('c'),
            entrypoints: Object.fromEntries(
                AGENTLIB_ATTESTED_ENTRYPOINTS.map((entry, index) => [entry, sha(String(index + 1))]),
            ),
        },
    };
}

test('ordinary status hides a healthy AgentLib admission proof', () => {
    assert.deepEqual(formatAgentLibRuntimeProof(admittedRuntime()), []);
});

test('verbose status exposes the complete healthy AgentLib admission proof', () => {
    const output = formatAgentLibRuntimeProof(admittedRuntime(), { verbose: true }).join('\n');
    assert.match(output, /AgentLib selection: aaaaaaaaaaaa  source id: bbbbbbbbbbbb/);
    assert.match(output, /AgentLib resolved root: \/opt\/ploinky-agentlib/);
    assert.match(output, /AgentLib proof: admitted/);
    for (const entry of AGENTLIB_ATTESTED_ENTRYPOINTS) assert.match(output, new RegExp(entry));
});

test('ordinary status keeps missing and malformed AgentLib proof visible without hashes', () => {
    const missing = admittedRuntime();
    delete missing.agentLibAttestation;
    assert.match(formatAgentLibRuntimeProof(missing).join('\n'), /missing — restart required/);

    const malformed = admittedRuntime();
    malformed.agentLibAttestation.entrypoints[AGENTLIB_ATTESTED_ENTRYPOINTS[0]] = '';
    const output = formatAgentLibRuntimeProof(malformed).join('\n');
    assert.match(output, /mismatch — restart required/);
    assert.doesNotMatch(output, /LLMAgents\/index\.mjs/);
});

test('ordinary status does not warn about proof for a stopped runtime', () => {
    const stopped = admittedRuntime();
    stopped.state.running = false;
    delete stopped.agentLibAttestation;
    assert.deepEqual(formatAgentLibRuntimeProof(stopped), []);
});
