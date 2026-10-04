import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, need, exact, absolute, parseStrictJson } from './manifest_codex.mjs';
import { validateExpectation } from './execution_codex.mjs';
import { readBoundedRegularFile } from './worker_codex.mjs';

// Operator-supplied, run-bound inputs that the manifest schema does not carry: the pinned image of the owned probe
// agent, the verified release manifest of the Copilot gate, and the exact expected record set of each supported
// update. The file is read once, before any mutation, and a missing or invalid file refuses the whole run.
export const INPUT_OPERATIONS = Object.freeze(['normal-update', 'settling-update']);
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,300}@sha256:[a-f0-9]{64}$/;

export function inputsPath(manifest) { return path.join(manifest.evidence.root, 'inputs_codex.json'); }

export function parseInputs(bytes, manifest) {
    const value = parseStrictJson(bytes, LIMITS.manifestBytes);
    exact(value, ['schemaVersion', 'runId', 'probeAgentImage', 'releaseManifest', 'expectedUpdates'], 'acceptance-inputs');
    need(value.schemaVersion === 1 && value.runId === manifest.runId && typeof value.probeAgentImage === 'string' && IMAGE.test(value.probeAgentImage)
        && absolute(value.releaseManifest) && /\.json$/.test(value.releaseManifest), 'acceptance-inputs');
    const protectedRoots = [manifest.workspace.path, manifest.candidate.root, ...manifest.candidate.repositories.map(repo => repo.path)];
    need(protectedRoots.every(root => !value.releaseManifest.startsWith(`${root}/`) && value.releaseManifest !== root), 'acceptance-inputs');
    exact(value.expectedUpdates, [...INPUT_OPERATIONS], 'acceptance-inputs');
    for (const operation of INPUT_OPERATIONS) validateExpectation(value.expectedUpdates[operation], manifest);
    return Object.freeze({ probeAgentImage: value.probeAgentImage, releaseManifest: value.releaseManifest, expectedUpdates: Object.freeze({ ...value.expectedUpdates }) });
}

export function loadInputs(manifest, io = fs) {
    let bytes; try { bytes = readBoundedRegularFile(inputsPath(manifest), LIMITS.manifestBytes, io); } catch (error) { need(false, 'acceptance-inputs-missing'); }
    return parseInputs(bytes, manifest);
}
