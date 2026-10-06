import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcceptanceError, LIMITS, need, parseAcceptanceArguments, parseManifestBytes, validateManifest, readBoundedDescriptor } from './manifest_codex.mjs';
import { REQUIRED_PHASES } from './contracts_codex.mjs';
import { loadInputs } from './inputs_codex.mjs';
import { executeAcceptance, publicReason, PENDING_REQUIREMENTS } from './acceptance_codex.mjs';
import { createRunEnvironment, createRealPorts } from './real_adapters_codex.mjs';

// All twelve required stages have a real adapter wired into this entrypoint. Wiring is not qualification: no stage
// passes except through its own live observation, and a stage that cannot be proven refuses the run.
export const IMPLEMENTED_PHASES = Object.freeze([...REQUIRED_PHASES]);
export function readManifestFile(filename, io = fs) {
    const fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = io.fstatSync(fd);
        need(before.isFile() && before.nlink === 1 && before.size <= LIMITS.manifestBytes && (before.mode & 0o022) === 0, 'manifest-file-shape');
        const bytes = readBoundedDescriptor(fd, LIMITS.manifestBytes, io), after = io.fstatSync(fd);
        need(before.dev === after.dev && before.ino === after.ino && before.uid === after.uid && before.mode === after.mode
            && before.nlink === after.nlink && before.size === after.size && bytes.length === before.size, 'manifest-file-changed');
        return bytes;
    } finally { io.closeSync(fd); }
}

// There is no external phase override or receipt injection: the receipt is derived from this run's own observations.
export async function runAcceptance(manifest, { manifestPath, io = fs, hostFacts = { platform: process.platform, uid: process.getuid?.() }, environment = createRunEnvironment(),
    createPorts = createRealPorts({ manifestPath, ...environment, io }), execute = executeAcceptance, write } = {}) {
    validateManifest(manifest);
    // The host is qualified before the inputs file, the evidence root or any adapter is touched.
    need(hostFacts.platform === 'linux' && hostFacts.uid === manifest.host.uid, 'runtime-host-unqualified');
    const inputs = loadInputs(manifest, io);
    try {
        return await execute({ manifest, inputs, createPorts, io, clock: environment.clock, hostFacts, latch: environment.latch, custody: environment.custody, write });
    } catch (error) {
        // An error after any command was launched is a failed run that needs hand-off, never a refusal before the runtime.
        if (environment.custody.snapshot().length === 0 && !environment.latch.snapshot().uncertain) throw error;
        return Object.freeze({ scope: 'live-update-cache-acceptance', runId: manifest.runId, acceptance: 'FAIL', status: 'FAILED', exitCode: 1, reason: publicReason(error), resourceDisposition: 'HANDOFF_REQUIRED',
            retained: environment.custody.snapshot().filter(row => !row.settled) });
    }
}

export async function acceptanceMain(argv, { read = readManifestFile, write = value => process.stdout.write(JSON.stringify(value) + '\n'), nodeVersion = process.version, nowMs = Date.now(), io = fs,
    run = runAcceptance, hostFacts } = {}) {
    try {
        const { manifestPath } = parseAcceptanceArguments(argv);
        need(/^v(?:2[2-9]|[3-9]\d|\d{3,})\./.test(nodeVersion), 'node-22-required');
        // The window is checked per stage by the run itself (the full suffix from U0, only the remaining suffix on resume); here the grant
        // need only be open now.
        const manifest = parseManifestBytes(read(manifestPath));
        need(manifest.grant.startsAtMs <= nowMs && nowMs < manifest.grant.endsAtMs, 'resource-window');
        const receipt = await run(manifest, { manifestPath, io, write: event => write({ progress: event }), ...(hostFacts ? { hostFacts } : {}) });
        write(receipt);
        // Exit 0 means only that the UC stage U0-U9 completed: it needs the explicit stage verdict, exit 0, the overall verdict still OPEN and the
        // AC-L4 G-BASE requirement still pending. Every other shape, including any receipt that claims a plain PASS, is a nonzero exit.
        const stageComplete = receipt?.acceptance === 'UC_STAGE_PASS' && receipt.exitCode === 0 && receipt.ucOverallAcceptance === 'OPEN'
            && Array.isArray(receipt.pendingRequirements) && receipt.pendingRequirements.length === PENDING_REQUIREMENTS.length && receipt.pendingRequirements.every((item, index) => item === PENDING_REQUIREMENTS[index]);
        if (stageComplete) write({ summary: 'UC stage complete; overall UC acceptance OPEN (pending AC-L4 G-BASE)' });
        return stageComplete ? 0 : (Number.isInteger(receipt?.exitCode) && receipt.exitCode > 0 ? receipt.exitCode : 1);
    } catch (error) {
        const reason = error instanceof AcceptanceError ? error.code : 'manifest-read-failed';
        write({ scope: 'live-update-cache-acceptance', status: 'REFUSED', acceptance: 'UNQUALIFIED', reason, resourceDisposition: 'NO_RUNTIME_LAUNCHED' });
        return 64;
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await acceptanceMain(process.argv.slice(2));
