import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AcceptanceError, need, LIMITS, parseStrictJson, boxName } from './manifest.mjs';
import { REQUIRED_PHASES, PHASE_CAPS_MS, TOTAL_CAP_MS, CAMPAIGN_RESERVES_MS, admitRemainingSchedule, admitCampaignImageReserve, assertPhaseReceipts, assertSameCandidate } from './contracts.mjs';
import { createFunctionalPhases } from './phases_functional.mjs';
import { createReleasePhases, functionalRecord } from './release.mjs';
import { canonicalJson } from './engine.mjs';
import { readBoundedRegularFile } from './worker.mjs';

// The fixed acceptance sequence, in three invocations on one manifest: (1) U0-U7b, the functional epoch; (2) U7c-U8a, the unactivated
// release generation R1 with the Copilot gate; (3) U7d-U9, the activated generation R2 with OnlyOffice and WebMeet. There is no stage
// selection or skip: each phase runs in order inside its own cap and inside the whole schedule, and the aggregate completes the UC STAGE
// only when all fifteen current receipts and all three gate results exist. It never completes overall UC acceptance: that stays OPEN
// until the AC-L4 G-BASE baseline has passed, outside this runner. The first refusal stops the run; owned resources are then reported,
// never cleaned up by guesswork.
const FUNCTIONAL = Object.freeze(['U0', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U7b']);
const RELEASE1 = Object.freeze(['U7c', 'U8a']);
const RELEASE2 = Object.freeze(['U7d', 'UA', 'U8b', 'U9']);
export const PENDING_REQUIREMENTS = Object.freeze(['AC-L4-G-BASE']);
const sha = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const publicReason = error => error instanceof AcceptanceError && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : (typeof error?.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : 'acceptance-failed');

export function writeExclusive(io, file, text) {
    const fd = io.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { const bytes = Buffer.from(text); let offset = 0; while (offset < bytes.length) { const count = io.writeSync(fd, bytes, offset, bytes.length - offset); need(count > 0, 'evidence-write'); offset += count; } }
    finally { io.closeSync(fd); }
}
const exists = (io, file) => { try { io.lstatSync(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw new AcceptanceError('evidence-unreadable'); } };

// A frozen functional epoch: nine current receipts plus the settled-epoch record, hash-bound. A forged or earlier-run
// file refuses; it can never carry browser-gate credit.
export function verifyFunctionalFile(value, manifest) {
    need(value && typeof value === 'object' && value.schemaVersion === 1 && value.kind === 'functional-epoch' && value.runId === manifest.runId && Array.isArray(value.receipts) && value.receipts.length === FUNCTIONAL.length
        && value.record && value.sha256 === sha({ receipts: value.receipts, record: value.record }), 'functional-receipt-invalid');
    let previous = 0;
    value.receipts.forEach((receipt, index) => {
        need(receipt?.phase === FUNCTIONAL[index] && receipt.runId === manifest.runId && receipt.status === 'PASS' && receipt.closed === true && receipt.uncertain === false && Number.isSafeInteger(receipt.startedMs) && Number.isSafeInteger(receipt.finishedMs)
            && receipt.startedMs >= previous && receipt.finishedMs >= receipt.startedMs && receipt.finishedMs - receipt.startedMs <= PHASE_CAPS_MS[receipt.phase] && /^[a-f0-9]{64}$/.test(receipt.evidenceSha256), 'functional-receipt-invalid');
        previous = receipt.finishedMs;
    });
    need(value.record.complete === true && value.record.writerQuiescent === true && value.record.cleanupComplete === true && value.record.copiesVerified === true && value.record.browserGateCredit === 0
        && value.record.boxId === manifest.box.id && value.record.startedAt === manifest.box.startedAt, 'functional-receipt-invalid');
    return value;
}

// The settled R1 epoch: the two receipts and the record R2 is later bound to (Box, workspace, candidate, the Copilot row). Hash-bound.
export function verifyRelease1File(value, manifest, functional) {
    const invalid = () => new AcceptanceError('release-epoch1-invalid');
    if (!(value && typeof value === 'object' && value.schemaVersion === 1 && value.kind === 'release-epoch-1' && value.runId === manifest.runId && Array.isArray(value.receipts) && value.receipts.length === RELEASE1.length
        && value.record && typeof value.record === 'object' && value.sha256 === sha({ receipts: value.receipts, record: value.record }))) throw invalid();
    let previous = functional.receipts.at(-1).finishedMs;
    value.receipts.forEach((receipt, index) => {
        need(receipt?.phase === RELEASE1[index] && receipt.runId === manifest.runId && receipt.status === 'PASS' && receipt.closed === true && receipt.uncertain === false && Number.isSafeInteger(receipt.startedMs) && Number.isSafeInteger(receipt.finishedMs)
            && receipt.startedMs >= previous && receipt.finishedMs >= receipt.startedMs && receipt.finishedMs - receipt.startedMs <= PHASE_CAPS_MS[receipt.phase] && /^[a-f0-9]{64}$/.test(receipt.evidenceSha256), 'release-epoch1-invalid');
        previous = receipt.finishedMs;
    });
    const r = value.record, gate = r.copilotGate, hex = item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
    need(hex(r.boxId) && boxName(r.boxName) && typeof r.startedAt === 'string' && Number.isFinite(Date.parse(r.startedAt)) && typeof r.workspaceIdentity === 'string' && r.workspaceIdentity !== '' && typeof r.generation === 'string'
        && r.imageId === manifest.box.imageId && typeof r.gpuGrantLabelPresent === 'boolean' && gate && gate.name === 'Copilot' && gate.discovered === 1 && gate.passed === 1 && gate.failed === 0 && gate.skipped === 0 && gate.retries === 0
        && gate.ignoredErrors === 0 && gate.closed === true && typeof gate.finishedAt === 'string' && Number.isFinite(Date.parse(gate.finishedAt)) && gate.before?.boxId === r.boxId && gate.after?.boxId === r.boxId
        && gate.admission?.gate === 'Copilot' && gate.admission.generationRemainingMs === 570000, 'release-epoch1-invalid');
    try { assertSameCandidate(functional.record.candidate, r.candidate); } catch { throw invalid(); }
    need(r.boxId !== functional.record.boxId, 'release-epoch1-invalid');
    return value;
}

export async function executeAcceptance({ manifest, inputs, createPorts, io = fs, clock, hostFacts = { platform: process.platform, uid: process.getuid?.() }, latch, custody, write = () => {} }) {
    // Nothing is read, written or launched before the host is qualified.
    need(hostFacts.platform === 'linux' && hostFacts.uid === manifest.host.uid, 'runtime-host-unqualified');
    const monoStart = clock.mono(); let offsetMs = 0;
    const timeline = () => offsetMs + (clock.mono() - monoStart);
    const receipts = [], runId = manifest.runId;
    // The evidence root is operator-provisioned and private; it is never created or adopted by the run.
    let root; try { root = io.lstatSync(manifest.evidence.root); } catch { throw new AcceptanceError('evidence-root-missing'); }
    need(root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o077) === 0 && root.uid === hostFacts.uid, 'evidence-root-unprivate');
    need(!exists(io, manifest.evidence.receipt), 'receipt-exists');
    let resume = null, resume1 = null;
    const hasFunctional = exists(io, manifest.evidence.functional), hasRelease1 = exists(io, manifest.evidence.release1Record);
    need(hasFunctional || !hasRelease1, 'release-epoch1-invalid');
    // The second fixture is created only after the Copilot gate has finished, so it cannot exist before the R1 record does.
    need(hasRelease1 || !exists(io, manifest.evidence.release2), 'release2-fixture-premature');
    if (hasFunctional) resume = verifyFunctionalFile(parseStrictJson(readBoundedRegularFile(manifest.evidence.functional, LIMITS.readBytes, io), LIMITS.readBytes), manifest);
    if (hasRelease1) resume1 = verifyRelease1File(parseStrictJson(readBoundedRegularFile(manifest.evidence.release1Record, LIMITS.readBytes, io), LIMITS.readBytes), manifest, resume);
    // Once R1 is settled, invocation 2 is done: it is never repeated, and invocation 3 needs the second fixture. Neither launches anything.
    need(!resume1 || exists(io, manifest.evidence.release2), 'release2-fixture-absent');
    const first = resume1 ? 'U7d' : resume ? 'U7c' : 'U0';
    admitRemainingSchedule({ firstPhase: first, remainingMs: manifest.grant.endsAtMs - clock.wall() });
    if (resume) { receipts.push(...resume.receipts); offsetMs = resume.receipts.at(-1).finishedMs; }
    if (resume1) { receipts.push(...resume1.receipts); offsetMs = resume1.receipts.at(-1).finishedMs; }
    const state = { functional: resume ? { ...resume.record } : null, release1Record: resume1 ? resume1.record : null, admissions: [] }; let currentCheck = () => {}, campaignStop = null; const b1 = [];
    const ports = await createPorts({ manifest, inputs, check: () => currentCheck() });
    const ctx = { manifest, inputs, ports, state, check: () => currentCheck(), wallNow: clock.wall, latchClean: () => !latch.snapshot().uncertain, stop: code => latch.stop(code) };
    const phases = { ...createFunctionalPhases(ctx), ...createReleasePhases(ctx) };
    const finalizers = {
        async U7b(receipt) {
            // B1: the campaign image reserve behind the settled functional epoch. A refusal stops the campaign before any release-side launch
            // and freezes nothing, so no later invocation can pick up an epoch the image window can no longer cover.
            const nowMs = clock.wall();
            try { admitCampaignImageReserve({ nowMs, imageCreatedAt: manifest.box.imageCreatedAt, reserveMs: CAMPAIGN_RESERVES_MS.B1 }); }
            catch (error) { if (error?.code === 'campaign-image-window-insufficient') { campaignStop = 'RELEASE_IMAGE_WINDOW_INSUFFICIENT'; return; } throw error; }
            b1.push({ point: 'B1', imageAgeMs: nowMs - Date.parse(manifest.box.imageCreatedAt), reserveMs: CAMPAIGN_RESERVES_MS.B1, accepted: true });
            const record = functionalRecord({ manifest, observed: state.finalObserved, finishedAt: new Date(clock.wall()).toISOString(), frozen: true, cleanupComplete: true });
            const all = [...receipts, receipt]; const file = { schemaVersion: 1, kind: 'functional-epoch', runId, receipts: all, record, sha256: sha({ receipts: all, record }) };
            writeExclusive(io, manifest.evidence.functional, JSON.stringify(file)); state.functional = { ...record };
        },
        // The R1 record is created exclusively once, right after the Copilot gate, with its own two receipts.
        async U8a(receipt) {
            const all = [receipts.find(row => row.phase === 'U7c'), receipt], record = state.release1Record; need(record && all[0], 'release-epoch1-invalid');
            const file = { schemaVersion: 1, kind: 'release-epoch-1', runId, receipts: all, record, sha256: sha({ receipts: all, record }) };
            try { writeExclusive(io, manifest.evidence.release1Record, JSON.stringify(file)); } catch { throw new AcceptanceError('release-epoch1-invalid'); }
        },
    };

    async function run(name) {
        need(!latch.snapshot().uncertain, 'run-uncertain'); latch.assertMayLaunch();
        admitRemainingSchedule({ firstPhase: name, remainingMs: TOTAL_CAP_MS - timeline() });
        const startedMs = timeline(), cap = PHASE_CAPS_MS[name];
        currentCheck = () => need(timeline() - startedMs < cap, 'phase-budget-expired');
        const evidence = await phases[name]();
        const receipt = { phase: name, runId, status: 'PASS', closed: true, uncertain: latch.snapshot().uncertain, startedMs, finishedMs: timeline(), evidenceSha256: sha(evidence), evidence };
        need(receipt.uncertain === false, 'run-uncertain');
        if (finalizers[name]) await finalizers[name](receipt);
        receipt.finishedMs = timeline(); need(receipt.finishedMs - startedMs <= cap, 'phase-budget-expired');
        receipts.push(receipt); write({ phase: name, status: 'PASS' }); return receipt;
    }
    let failure = null, awaiting = null;
    try {
        if (!resume) for (const name of FUNCTIONAL) await run(name);
        if (campaignStop) { /* B1 refused: nothing was frozen and nothing is launched */ }
        else {
            if (!resume1) {
                if (!exists(io, manifest.evidence.release)) awaiting = 'AWAITING_RELEASE_FIXTURE';
                // Invocation 2 always ends here: R2 is never started in the same process, whatever files exist by now.
                else { for (const name of RELEASE1) await run(name); awaiting = 'AWAITING_SECOND_RELEASE_FIXTURE'; }
            }
            if (!awaiting) for (const name of RELEASE2) await run(name);
        }
    } catch (error) {
        failure = { phase: REQUIRED_PHASES.find(name => !receipts.some(row => row.phase === name)) ?? 'U9', reason: publicReason(error), retained: error?.retained ?? null, recovery: null };
        // The failure and every owned identity needed to recover by hand are persisted, exclusively and privately, before any close.
        try {
            const owned = ports.fixture?.state?.();
            failure.recovery = ports.recovery.record('failure', { failedPhase: failure.phase, reason: failure.reason, elapsedMs: timeline(), withinDeadline: timeline() <= TOTAL_CAP_MS, passedPhases: receipts.map(row => row.phase),
                unsettledCommands: custody.snapshot().filter(row => !row.settled), uncertain: latch.snapshot().uncertain, fixture: owned?.prepared || owned?.container ? ports.fixture.recoverySnapshot() : null });
        } catch { failure.recovery = null; }
    }
    finally { try { await ports.close?.(); } catch { failure ??= { phase: 'U9', reason: 'close-unproven', retained: null }; } }
    const projected = REQUIRED_PHASES.map(name => { const row = receipts.find(item => item.phase === name);
        return row ? { phase: name, status: 'PASS', qualified: true, startedMs: row.startedMs, finishedMs: row.finishedMs, evidenceSha256: row.evidenceSha256 } : { phase: name, status: failure?.phase === name ? 'FAIL' : 'UNRUN', qualified: false }; });
    const base = { schemaVersion: 1, runId, scope: 'live-update-cache-acceptance', executionInterface: 'outer-cli-api', phases: projected, budget: { totalCapMs: TOTAL_CAP_MS, elapsedMs: timeline() } };
    if (failure) return Object.freeze({ ...base, acceptance: 'FAIL', status: 'FAILED', exitCode: 1, reason: failure.reason, failedPhase: failure.phase, resourceDisposition: latch.snapshot().uncertain ? 'HANDOFF_REQUIRED' : 'OWNED_RESOURCES_RETAINED_FOR_REVIEW', retained: custody.snapshot().filter(row => !row.settled), recoveryRecord: failure.recovery });
    if (campaignStop) return Object.freeze({ ...base, acceptance: 'UNQUALIFIED', status: campaignStop, exitCode: 3, reason: 'campaign-image-window-insufficient', resourceDisposition: 'FUNCTIONAL_EPOCH_SETTLED_NOT_FROZEN' });
    if (awaiting === 'AWAITING_RELEASE_FIXTURE') return Object.freeze({ ...base, acceptance: 'UNQUALIFIED', status: awaiting, exitCode: 3, reason: 'release-fixture-absent', resourceDisposition: 'FUNCTIONAL_EPOCH_SETTLED', admissions: b1 });
    if (awaiting) return Object.freeze({ ...base, acceptance: 'UNQUALIFIED', status: awaiting, exitCode: 3, reason: 'release2-fixture-absent', resourceDisposition: 'RELEASE1_EPOCH_SETTLED', admissions: [state.release1Record.copilotGate.admission] });
    assertPhaseReceipts({ runId, receipts });
    // The runner completes the UC stage only. Overall UC acceptance and merge eligibility stay OPEN until the AC-L4 G-BASE baseline has passed;
    // these two fields are fixed literals and no code path of the runner writes any other value to them.
    const receipt = { ...base, acceptance: 'UC_STAGE_PASS', ucOverallAcceptance: 'OPEN', pendingRequirements: [...PENDING_REQUIREMENTS], status: 'UC_STAGE_COMPLETE', exitCode: 0,
        gates: state.gates.map(gate => ({ name: gate.name, runId: gate.runId, discovered: gate.discovered, passed: gate.passed, skipped: gate.skipped, retries: gate.retries, ignoredErrors: gate.ignoredErrors,
            before: { generation: gate.before.generation, runtimes: gate.before.runtimes }, after: { generation: gate.after.generation, runtimes: gate.after.runtimes } })),
        releaseGenerations: state.releaseGenerations, activation: state.activation, admissions: state.admissions,
        candidate: { commit: manifest.candidate.commit, imageId: manifest.box.imageId }, resourceDisposition: 'OWNED_RESOURCES_CLOSED' };
    // A late finalization can never publish PASS: the budget is re-checked against the whole schedule before writing.
    if (timeline() > TOTAL_CAP_MS) return Object.freeze({ ...base, acceptance: 'FAIL', status: 'FAILED', exitCode: 1, reason: 'acceptance-budget-expired', failedPhase: 'U9', resourceDisposition: 'OWNED_RESOURCES_CLOSED' });
    writeExclusive(io, manifest.evidence.receipt, JSON.stringify(receipt)); return Object.freeze(receipt);
}
