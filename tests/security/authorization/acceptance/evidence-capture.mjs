#!/usr/bin/env node
/**
 * Read-only deployment evidence capture, pins first.
 *
 *   node evidence-capture.mjs --pins <pins.json> --pins-sha256 <hex> --out <new dir>
 *
 * Order (plan rev4 "Capture order"): pins file hash, read-only mode, schema,
 * exact Ploinky checkout (SHA, branch, upstream, containment, clean), every
 * pinned repository, then the recomputed policy digest. Only after all of
 * these pass does it inspect the Box, compare it with the pins and the fixed
 * confinement policy, and write dependency-preflight.json and box-identity.json
 * in the shape ownershipGuard reads. Any mismatch exits 1 and writes nothing.
 * The captured snapshot is drift evidence only; it never defines what is
 * acceptable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPins, verifyCandidate, PinError } from './pins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(here, '../../../..');

export class CaptureError extends Error {
    constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

export function agentContainer(agentsJson, repo, agent) {
    const matches = Object.entries(agentsJson || {}).filter(([name, record]) => name !== '_config' && record?.type === 'agent'
        && record.repoName === repo && record.agentName === agent && !record.alias);
    if (matches.length !== 1) throw new CaptureError('CAPTURE_CONTAINER_AMBIGUOUS', `expected one ${repo}/${agent} record, found ${matches.length}`);
    return matches[0][0];
}
export const userPersistoContainer = agentsJson => agentContainer(agentsJson, 'AchillesIDE', 'userPersistoAgent');

/**
 * The capture pipeline with injectable side effects, so the pins-first order
 * is testable offline: nothing after a failed step runs.
 */
export async function capture({ pinsFile, pinsSha256, out, sourceRoot = SOURCE_ROOT, inspectBox, readAgents, policy, verifyBox, log = () => {} }) {
    const steps = [];
    const { pins, sha256 } = loadPins(pinsFile, pinsSha256);
    steps.push('pins');
    const digest = verifyCandidate(pins, sourceRoot);
    steps.push('sources', 'policy-digest');
    log(`pins ${sha256} verified; policy digest ${digest}`);
    if (!out || !path.isAbsolute(out)) throw new CaptureError('CAPTURE_OUT', 'an absolute output directory is required');
    const box = await inspectBox(pins.box.id);
    steps.push('box-inspect');
    const captured = { id: box.Id, name: String(box.Name).replace(/^\//, ''), startedAt: box.State?.StartedAt, imageId: `sha256:${String(box.Image).replace(/^sha256:/, '')}` };
    verifyBox({ box, captured, pins, policy });
    steps.push('box-verified');
    const agents = await readAgents(pins.workspace);
    const container = userPersistoContainer(agents);
    const dpuContainer = agentContainer(agents, 'AchillesIDE', 'dpuAgent');
    fs.mkdirSync(out, { mode: 0o700 });
    const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const repositories = pins.repositories.map(({ name, path: p, commit, branch, upstream }) => ({ name, path: p, commit, branch, upstream }));
    write('dependency-preflight.json', { workspace: pins.workspace, pinsSha256: sha256, policyDigest: digest, ploinky: pins.ploinky, image: { imageId: pins.box.imageId, imageDigest: pins.box.imageDigest }, repositories });
    write('box-identity.json', { ...captured, image: captured.imageId, ports: box.NetworkSettings?.Ports, observedMounts: (box.Mounts || []).map(m => ({ destination: m.Destination, source: m.Source, type: m.Type, rw: m.RW === true })), userPersistoContainer: container, dpuContainer, imageDigest: box.ImageDigest, pinsSha256: sha256, capturedAt: new Date().toISOString() });
    steps.push('written');
    return { steps, pinsSha256: sha256, policyDigest: digest };
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!/^--[a-z0-9-]+$/.test(argv[i]) || argv[i + 1] === undefined) throw new CaptureError('CAPTURE_USAGE', `unexpected argument ${argv[i]}`);
        args[argv[i].slice(2)] = argv[i + 1];
    }
    return args;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const { verifyBoxAgainstPins } = await import('../core.mjs');
        const policy = JSON.parse(fs.readFileSync(path.join(here, 'policy.json'), 'utf8'));
        const result = await capture({
            pinsFile: args.pins, pinsSha256: args['pins-sha256'], out: args.out, policy,
            inspectBox: async id => JSON.parse(execFileSync('podman', ['inspect', id], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }))[0],
            readAgents: async workspace => JSON.parse(fs.readFileSync(path.join(workspace, '.ploinky', 'agents.json'), 'utf8')),
            verifyBox: verifyBoxAgainstPins,
            log: message => console.log(message),
        });
        console.log(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
        const code = error instanceof PinError || error instanceof CaptureError ? error.code : (error?.code || 'CAPTURE_FAILED');
        console.error(`CAPTURE_REFUSED ${code}: ${String(error?.message || error).slice(0, 300)}`);
        process.exitCode = 1;
    }
}
