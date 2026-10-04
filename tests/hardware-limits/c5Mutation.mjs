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
