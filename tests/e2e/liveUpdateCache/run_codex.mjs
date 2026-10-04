import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcceptanceError, LIMITS, need, parseAcceptanceArguments, parseManifestBytes, validateManifest, readBoundedDescriptor } from './manifest_codex.mjs';
import { REQUIRED_PHASES } from './contracts_codex.mjs';

export const IMPLEMENTED_PHASES = Object.freeze([]);
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

export function runAcceptance(manifest) {
    validateManifest(manifest);
    // There is no external phase override or receipt injection in the acceptance interface.
    return Object.freeze({ schemaVersion: 1, runId: manifest.runId, scope: 'source-checkpoint', acceptance: 'UNQUALIFIED',
        status: 'UNRUN', exitCode: 1, reason: 'U0-live-adapter-unimplemented', executionInterface: 'outer-cli-api',
        phases: REQUIRED_PHASES.map(phase => Object.freeze({ phase, status: 'UNRUN', qualified: false })),
        resourceDisposition: 'NO_RUNTIME_LAUNCHED' });
}

export function acceptanceMain(argv, { read = readManifestFile, write = value => process.stdout.write(JSON.stringify(value) + '\n'),
    nodeVersion = process.version, nowMs = Date.now() } = {}) {
    try {
        const { manifestPath } = parseAcceptanceArguments(argv);
        need(/^v(?:2[2-9]|[3-9]\d|\d{3,})\./.test(nodeVersion), 'node-22-required');
        const manifest = parseManifestBytes(read(manifestPath), { nowMs });
        const receipt = runAcceptance(manifest); write(receipt); return receipt.exitCode;
    } catch (error) {
        const reason = error instanceof AcceptanceError ? error.code : 'manifest-read-failed';
        write({ scope: 'source-checkpoint', status: 'REFUSED', acceptance: 'UNQUALIFIED', reason, resourceDisposition: 'NO_RUNTIME_LAUNCHED' });
        return 64;
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = acceptanceMain(process.argv.slice(2));
