// Source mutation for the LIVE-C5 mutant tests: an exact, recorded patch applied to ONE module of the candidate as it is loaded, in a child process
// that loads the product (or the harness) through it. Nothing on disk changes. A patch must match exactly once; a patch that does not apply is a
// setup failure and never earns a kill. Test-only.
//
//   node --import tests/hardware-limits/c5MutationRegister.mjs ...    with C5_MUTATION='{"name":..,"file":..,"patches":[{"from":..,"to":..}]}'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const TRANSITION = 'ploinky-box/hardwareLimitsTransition.mjs';

export function countOf(text, needle) {
    let count = 0;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1;
    return count;
}

// The patched text. Every patch must match exactly once.
export function applyPatches(text, patches) {
    let result = text;
    for (const patch of patches) {
        const matches = countOf(result, patch.from);
        if (matches !== 1) throw new Error(`mutation patch matches ${matches} times, not once: ${JSON.stringify(patch.from.slice(0, 80))}`);
        result = result.replace(patch.from, () => patch.to);
    }
    return result;
}

export function describeMutation(spec, root = ROOT) {
    const source = fs.readFileSync(path.join(root, spec.file), 'utf8');
    const patched = applyPatches(source, spec.patches);
    return { name: spec.name, file: spec.file, sourceDigest: `sha256:${sha(source)}`, patchedDigest: `sha256:${sha(patched)}`,
        patches: spec.patches.map(patch => ({ from: patch.from, to: patch.to })), patchDigest: `sha256:${sha(JSON.stringify(spec.patches))}` };
}

// ---- the production forward transition (hardwareLimitsTransition.mjs forwardToDecision / createVerifiedCandidate) ----
const INSTALL = "    const receipt = await intent(ctx, journal, { kind: 'install-barrier' }, 'barrier', async () => beginDowngradeBarrier({";
const INSTALLED = "    persist(ctx, journal, { policyToken: receipt.token, phase: 'barrier-installed', nextAction: null });\n";
const PRECREATE = "    const createEffect = stage === 'reapply' ? 'reapply-create' : 'candidate-create';\n";
const REMOVE_OWN = 'removeDowngradeBarrier({ paths: ctx.policyPaths, identity: ctx.identity, operationId: journal.operationId });';

export const PRODUCT_MUTANTS = Object.freeze({
    // The forward transition never installs its barrier: the REAL assertGateOffStoreEmpty answers in its place, so the receipt still carries a real
    // store-derived token and the transition reaches the old-ID stop boundary.
    'missing-installation': { name: 'missing-installation', file: TRANSITION, patches: [
        { from: '    beginDowngradeBarrier,\n    hardwareStateRoot,', to: '    assertGateOffStoreEmpty,\n    beginDowngradeBarrier,\n    hardwareStateRoot,' },
        { from: INSTALL, to: INSTALL.replace('beginDowngradeBarrier({', 'assertGateOffStoreEmpty({') },
    ] },
    // The barrier is installed and removed immediately, before the first effect that stops the old graph.
    'early-removal': { name: 'early-removal', file: TRANSITION, patches: [{ from: INSTALLED, to: `${INSTALLED}    ${REMOVE_OWN}\n` }] },
    // The barrier is lost at the forward precreation boundary, after the old Box is gone and before the replacement is created.
    'loss-before-replacement': { name: 'loss-before-replacement', file: TRANSITION, patches: [{ from: PRECREATE, to: `    if (stage === 'candidate') ${REMOVE_OWN}\n${PRECREATE}` }] },
});

// ---- the harness: each mutant removes one guard of the LIVE-C5 lifecycle, custody or cleanup code. `kill` names the offline test that must fail ----
const LIFECYCLE = 'tests/hardware-limits/liveStoreLifecycle.mjs';
const CUSTODY = 'tests/hardware-limits/liveBoxTransitionCustody.mjs';
const CLEANUP = 'tests/hardware-limits/liveCleanup.mjs';
export const HARNESS_MUTANTS = Object.freeze({
    // A writer-first restart refused with some OTHER error (or none) is accepted as the typed refusal.
    'wrong-typed-refusal-accepted': { name: 'wrong-typed-refusal-accepted', file: LIFECYCLE, patches: [{ from: 'if (outcome?.errorCode !== WRITER_FIRST_CODE) return', to: 'if (false) return' }],
        kill: { file: 'tests/unit/hardwareLimitsLiveStoreLifecycle.test.mjs', pattern: 'evaluators-accept-only-the-typed-refusal' } },
    // The writer-first order is not required to leave the Box, the policy, the stamp, the gate and the transitions exactly as captured.
    'unchanged-state-check-dropped': { name: 'unchanged-state-check-dropped', file: LIFECYCLE, patches: [{ from: 'if (!sameState(before, after))', to: 'if (false)' }],
        kill: { file: 'tests/unit/hardwareLimitsLiveStoreLifecycle.test.mjs', pattern: 'writer-first-refusal-that-moved-the-stamp' } },
    // The gate-on restart is never run: the case believes in a restart that did not happen.
    'actual-restart-skipped': { name: 'actual-restart-skipped', file: LIFECYCLE, patches: [{
        from: "const result = await command('c5-restart-on', profile.node.path, [profile.candidate.path, 'restart'], { gate: 'on', deadlineMs: startDeadline(), tolerate: true, capture: 'c5-restart-on' });",
        to: "const result = { status: 0, signal: null, timedOut: false, truncated: false, cancelled: false, errorCode: null, settlementForced: false, stdout: '', stderr: '' };" }],
        kill: { file: 'tests/unit/hardwareLimitsLiveStoreLifecycle.test.mjs', pattern: 'restart-on-writer-first-and-transition-first-pass' } },
    // A create attempt without its CID receipt adopts whatever live container is not the original: adoption by name, never by the product's record.
    'name-only-replacement-adoption': { name: 'name-only-replacement-adoption', file: CUSTODY, patches: [{ from: '        if (!cid) continue;',
        to: '        if (!cid) { const byName = ids.find(candidate => candidate !== original.id); if (byName) chain.push(byName); continue; }' }],
        kill: { file: 'tests/unit/hardwareLimitsLiveTransitionCustody.test.mjs', pattern: 'admits-a-replacement-only-through-the-bound' } },
    // A missing or conflicting CID is ignored and a live container the chain does not explain is not noticed.
    'missing-or-conflicting-cid-ignored': { name: 'missing-or-conflicting-cid-ignored', file: CUSTODY, patches: [
        { from: 'const unexplained = known => ids.filter(id => !known.includes(id) && !unrelatedIds.includes(id));', to: 'const unexplained = () => [];' },
        { from: "if ((attempt.observedId !== null && attempt.observedId !== cid.id) || chain.includes(cid.id)) throw problem('conflicting attempt CID');", to: "if (false) throw problem('conflicting attempt CID');" }],
        kill: { file: 'tests/unit/hardwareLimitsLiveTransitionCustody.test.mjs', pattern: 'admits-a-replacement-only-through-the-bound' } },
    // Cleanup proves only the original ID absent.
    'cleanup-checks-only-the-original-id': { name: 'cleanup-checks-only-the-original-id', file: CLEANUP, patches: [{
        from: 'const ownedIds = () => (chain ? [...chain] : c5ChainIds(run, profile).filter(Boolean));', to: 'const ownedIds = () => [profile.box.id];' }],
        kill: { file: 'tests/unit/hardwareLimitsLiveTransitionCustody.test.mjs', pattern: 'proves-every-id-of-the-chain-absent' } },
});
