/**
 * External pin manifest (pins.json) loading and candidate verification.
 *
 * pins.json lives outside the source commit, is reviewed, then frozen (mode
 * 0444) and identified by its sha256. Every check here runs before any
 * observed state is recorded and before any podman or HTTP request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { policyDigest } from './digest.mjs';

const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

export class PinError extends Error {
    constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
const fail = (code, message) => { throw new PinError(code, message); };

export function validatePins(pins) {
    if (!pins || typeof pins !== 'object' || Array.isArray(pins)) fail('PINS_SCHEMA', 'pins must be an object');
    if (pins.schema !== 'authz-acceptance-pins/1') fail('PINS_SCHEMA', 'unknown schema');
    const ref = (value, label) => {
        if (!value || !SHA.test(String(value.commit))) fail('PINS_SCHEMA', `${label}.commit must be a 40-hex SHA`);
        if (!BRANCH.test(String(value.branch || ''))) fail('PINS_SCHEMA', `${label}.branch is required`);
        if (value.upstream !== `origin/${value.branch}`) fail('PINS_SCHEMA', `${label}.upstream must be origin/<branch>`);
    };
    ref(pins.ploinky, 'ploinky');
    if (!path.isAbsolute(String(pins.ploinkyCheckout || ''))) fail('PINS_SCHEMA', 'ploinkyCheckout must be absolute');
    if (!path.isAbsolute(String(pins.workspace || ''))) fail('PINS_SCHEMA', 'workspace must be absolute');
    if (!Array.isArray(pins.repositories) || !pins.repositories.length) fail('PINS_SCHEMA', 'repositories must be non-empty');
    const names = new Set();
    for (const repo of pins.repositories) {
        if (!NAME.test(String(repo?.name || '')) || names.has(repo.name)) fail('PINS_SCHEMA', 'repository names must be unique');
        names.add(repo.name);
        if (typeof repo.path !== 'string' || path.isAbsolute(repo.path) || repo.path.split('/').includes('..')) fail('PINS_SCHEMA', `${repo.name}.path must be workspace-relative`);
        ref(repo, repo.name);
    }
    if (!HEX64.test(String(pins.policyDigest || ''))) fail('PINS_SCHEMA', 'policyDigest must be 64-hex');
    const box = pins.box || {};
    if (!HEX64.test(String(box.id || ''))) fail('PINS_SCHEMA', 'box.id must be 64-hex');
    if (!/^ploinky-box-[A-Za-z0-9._-]+$/.test(String(box.name || ''))) fail('PINS_SCHEMA', 'box.name');
    if (!Number.isFinite(Date.parse(String(box.startedAt || '')))) fail('PINS_SCHEMA', 'box.startedAt');
    if (!/^sha256:[0-9a-f]{64}$/.test(String(box.imageId || ''))) fail('PINS_SCHEMA', 'box.imageId must be sha256:<hex>');
    if (!/^sha256:[0-9a-f]{64}$/.test(String(box.imageDigest || ''))) fail('PINS_SCHEMA', 'box.imageDigest must be sha256:<hex>');
    const lib = pins.agentlib || {};
    if (!['image', 'local'].includes(lib.mode)) fail('PINS_SCHEMA', 'agentlib.mode must be image or local');
    if (lib.mode === 'local' && (!lib.sourceRelativePath || path.isAbsolute(lib.sourceRelativePath) || lib.sourceRelativePath.split('/').includes('..'))) fail('PINS_SCHEMA', 'local agentlib requires a workspace-relative sourceRelativePath');
    return pins;
}

/** Hash first, then mode, then schema. Nothing else is read before the hash matches. */
export function loadPins(file, expectedSha256, { readFile = fs.readFileSync, stat = fs.statSync } = {}) {
    if (!file || !path.isAbsolute(file)) fail('PINS_MISSING', 'an absolute pins file is required');
    if (!HEX64.test(String(expectedSha256 || ''))) fail('PINS_MISSING', 'the reviewed pins sha256 is required');
    const bytes = readFile(file);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expectedSha256) fail('PINS_HASH_MISMATCH', 'pins file bytes differ from the reviewed sha256');
    if (stat(file).mode & 0o222) fail('PINS_NOT_FROZEN', 'pins file must be read-only (0444)');
    let pins;
    try { pins = JSON.parse(bytes.toString('utf8')); } catch { fail('PINS_SCHEMA', 'pins file is not JSON'); }
    return { pins: validatePins(pins), sha256: actual };
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Exact SHA, branch, upstream, upstream containment and a clean tree. */
export function verifyCheckout(root, pin, label, { run = git } = {}) {
    let head;
    try { head = run(root, ['rev-parse', 'HEAD']); } catch { fail('SOURCE_PIN_MISMATCH', `${label}: not a readable checkout`); }
    if (head !== pin.commit) fail('SOURCE_PIN_MISMATCH', `${label}: HEAD differs from the pinned commit`);
    if (run(root, ['branch', '--show-current']) !== pin.branch) fail('SOURCE_BRANCH_MISMATCH', `${label}: branch differs`);
    let upstream;
    try { upstream = run(root, ['rev-parse', '--abbrev-ref', '@{upstream}']); } catch { fail('SOURCE_UPSTREAM_MISMATCH', `${label}: no upstream`); }
    if (upstream !== pin.upstream) fail('SOURCE_UPSTREAM_MISMATCH', `${label}: upstream differs`);
    try { run(root, ['merge-base', '--is-ancestor', 'HEAD', '@{upstream}']); } catch { fail('SOURCE_NOT_PUSHED', `${label}: pinned commit is not contained in its upstream`); }
    if (run(root, ['status', '--porcelain']) !== '') fail('SOURCE_DIRTY', `${label}: tree is not clean`);
}

/**
 * Verify the candidate before any observation: the running checkout is the
 * pinned Ploinky checkout, every deployed repository is at its pin, and the
 * policy digest recomputed from the pinned checkout matches.
 */
export function verifyCandidate(pins, sourceRoot, { run = git, digest = policyDigest } = {}) {
    const real = fs.realpathSync(sourceRoot);
    if (real !== pins.ploinkyCheckout) fail('SOURCE_ROOT_MISMATCH', 'the suite must run from the pinned Ploinky checkout');
    verifyCheckout(real, pins.ploinky, 'ploinky', { run });
    for (const repo of pins.repositories) verifyCheckout(path.join(pins.workspace, repo.path), repo, repo.name, { run });
    const recomputed = digest(path.join(real, 'tests/security/authorization/acceptance'));
    if (recomputed !== pins.policyDigest) fail('POLICY_DIGEST_MISMATCH', 'acceptance policy files differ from the pinned digest');
    return recomputed;
}
