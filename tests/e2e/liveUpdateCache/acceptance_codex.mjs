import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AcceptanceError, need, LIMITS, parseStrictJson } from './manifest_codex.mjs';
import { REQUIRED_PHASES, PHASE_CAPS_MS, TOTAL_CAP_MS, admitRemainingSchedule, assertPhaseReceipts } from './contracts_codex.mjs';
import { createFunctionalPhases } from './phases_functional_codex.mjs';
import { createReleasePhases, functionalRecord } from './release_codex.mjs';
import { canonicalJson } from './engine_codex.mjs';
import { readBoundedRegularFile } from './worker_codex.mjs';

// The fixed acceptance sequence. There is no stage selection or skip: U0-U9 run in order, each inside its own cap and
// inside the whole schedule, and the aggregate passes only when all twelve current receipts and all three gate results
// exist. The first refusal stops the run; owned resources are then reported, never cleaned up by guesswork.
const FUNCTIONAL = Object.freeze(['U0', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U7b']);
const RELEASE = Object.freeze(['U7c', 'U8', 'U9']);
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
    let resume = null;
    if (exists(io, manifest.evidence.functional)) resume = verifyFunctionalFile(parseStrictJson(readBoundedRegularFile(manifest.evidence.functional, LIMITS.readBytes, io), LIMITS.readBytes), manifest);
    const first = resume ? 'U7c' : 'U0';
    admitRemainingSchedule({ firstPhase: first, remainingMs: manifest.grant.endsAtMs - clock.wall() });
    if (resume) { receipts.push(...resume.receipts); offsetMs = resume.receipts.at(-1).finishedMs; }
    const state = { functional: resume ? { ...resume.record } : null }; let currentCheck = () => {};
    const ports = await createPorts({ manifest, inputs, check: () => currentCheck() });
    const ctx = { manifest, inputs, ports, state, check: () => currentCheck(), wallNow: clock.wall, latchClean: () => !latch.snapshot().uncertain, stop: code => latch.stop(code) };
    const phases = { ...createFunctionalPhases(ctx), ...createReleasePhases(ctx) };
    const finalizers = { async U7b(receipt) {
        const record = functionalRecord({ manifest, observed: state.finalObserved, finishedAt: new Date(clock.wall()).toISOString(), frozen: true, cleanupComplete: true });
        const all = [...receipts, receipt]; const file = { schemaVersion: 1, kind: 'functional-epoch', runId, receipts: all, record, sha256: sha({ receipts: all, record }) };
        writeExclusive(io, manifest.evidence.functional, JSON.stringify(file)); state.functional = { ...record };
    } };

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
    let failure = null, awaiting = false;
    try {
        if (!resume) for (const name of FUNCTIONAL) await run(name);
        if (!exists(io, manifest.evidence.release)) awaiting = true;
        else for (const name of RELEASE) await run(name);
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
    if (awaiting) return Object.freeze({ ...base, acceptance: 'UNQUALIFIED', status: 'AWAITING_RELEASE_FIXTURE', exitCode: 3, reason: 'release-fixture-absent', resourceDisposition: 'FUNCTIONAL_EPOCH_SETTLED' });
    assertPhaseReceipts({ runId, receipts });
    const receipt = { ...base, acceptance: 'PASS', status: 'PASSED', exitCode: 0, gates: state.gates.map(gate => ({ name: gate.name, runId: gate.runId, discovered: gate.discovered, passed: gate.passed, skipped: gate.skipped, retries: gate.retries, ignoredErrors: gate.ignoredErrors,
            before: { generation: gate.before.generation, runtimes: gate.before.runtimes }, after: { generation: gate.after.generation, runtimes: gate.after.runtimes } })),
        candidate: { commit: manifest.candidate.commit, imageId: manifest.box.imageId }, resourceDisposition: 'OWNED_RESOURCES_CLOSED' };
    // A late finalization can never publish PASS: the budget is re-checked against the whole schedule before writing.
    if (timeline() > TOTAL_CAP_MS) return Object.freeze({ ...base, acceptance: 'FAIL', status: 'FAILED', exitCode: 1, reason: 'acceptance-budget-expired', failedPhase: 'U9', resourceDisposition: 'OWNED_RESOURCES_CLOSED' });
    writeExclusive(io, manifest.evidence.receipt, JSON.stringify(receipt)); return Object.freeze(receipt);
}
