import path from 'node:path';
import { createHash } from 'node:crypto';
import { need } from './manifest.mjs';
import { canonicalJson } from './engine.mjs';

// Names and record identities of the registrations this run owns, derived exactly as the product derives them:
// the container (registration) name from the workspace path (docker/common.js getAgentContainerName), the pin id from
// the canonical digest of its binding (gitPins.mjs pinIdFor), and the package source relative to the workspace
// (runtimeDependencies.mjs agentPackageSourceAt). A derivation mismatch is checked against the observed runtime.
const sha256Hex = value => createHash('sha256').update(value).digest('hex');

export const runSuffix = runId => { const match = /-([a-f0-9]{8})_codex$/.exec(runId); need(match, 'fixture-run-id'); return match[1]; };
export const fixtureNames = runId => { const suffix = runSuffix(runId); return Object.freeze({ suffix, packageName: `uc-probe-${suffix}`, repoName: `UcProbe${suffix}`, agentName: 'probe', aliases: Object.freeze([`uc-${suffix}-a`, `uc-${suffix}-b`]),
    container: `uc-git-${suffix}`, relative: `${runId}` }); };

const safe = value => String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
export function ownedRegistration(manifest) {
    const names = fixtureNames(manifest.runId), workspace = manifest.workspace.path;
    const containerName = `ploinky_${safe(names.repoName)}_${safe(names.agentName)}_${safe(path.basename(workspace))}_${sha256Hex(workspace).slice(0, 8)}`;
    const packageSource = `.ploinky/repos/${names.repoName}/${names.agentName}/package.json`;
    const pinId = sha256Hex(canonicalJson({ binding: { scope: 'registration', registration: containerName, packageSource }, section: 'dependencies', name: names.packageName }));
    return Object.freeze({ repoName: names.repoName, containerName, packageSource, pinId });
}
