// Mutants of the M-NW-01 availability store and worker terminal-write slices: each applies
// exact patches to ONE module as it loads, in a child process, and must make the leaf that
// guards it FAIL by its own assertion. A control run of the same leaf, unmutated, must pass
// first, so that a failing child is never a setup problem (an import error, a patch that did
// not apply, a timeout). The patching machinery is the existing one (c5Mutation.mjs); nothing
// on disk changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { ROOT, applyPatches, describeMutation } from '../hardware-limits/c5Mutation.mjs';

const href = (relative) => pathToFileURL(path.join(ROOT, relative)).href;
const CONTRACT = href('tests/helpers/agentlibTestContract.mjs');
const GUARD = href('tests/helpers/engineSpawnGuard.mjs');
const REGISTER = href('tests/hardware-limits/c5MutationRegister.mjs');

const STORE = 'cli/sandbox/hardwareAvailabilityStore.mjs';
const STORE_TEST = 'tests/unit/hardwareAvailabilityStore.test.mjs';
const SLOTS_TEST = 'tests/unit/noWaitAvailabilitySlots.test.mjs';
const WORKER = 'cli/commands/noWaitWorker.js';
const PROTOCOL = 'cli/commands/noWaitProtocol.js';
const WORKER_TEST = 'tests/unit/noWaitLateOutcomeActivation.test.mjs';
const kill = (file, pattern) => ({ file, pattern });
const MISSING_POLICY = "directory = { state: 'invalid', problem: 'policy.json is missing from an existing store directory' };";
const WITNESS_CALL = '        writeWitness({ paths, fsApi, run, state, storeId, initializedBy, now });\n';

export const AVAILABILITY_MUTANTS = Object.freeze({
    'm1a-the-temp-fsync-is-dropped-from-durable-failed-writes': { name: 'm1a-the-temp-fsync-is-dropped-from-durable-failed-writes', file: WORKER,
        kill: kill(WORKER_TEST, 'NW1\\.D2-failed-status-writes-are-fsynced'),
        patches: [{ from: '                fsApi.fsyncSync(descriptor);\n            } finally {\n                fsApi.closeSync(descriptor);', to: '            } finally {\n                fsApi.closeSync(descriptor);' }] },
    'm1b-the-directory-fsync-is-dropped-from-durable-failed-writes': { name: 'm1b-the-directory-fsync-is-dropped-from-durable-failed-writes', file: WORKER,
        kill: kill(WORKER_TEST, 'NW1\\.D2-failed-status-writes-are-fsynced'),
        patches: [{ from: '            fsyncStatusDirectory(path.dirname(resolvedTarget), fsApi);\n', to: '' }] },
    'm2-the-run-scoped-file-is-written-before-the-canonical-file': { name: 'm2-the-run-scoped-file-is-written-before-the-canonical-file', file: WORKER,
        kill: kill(WORKER_TEST, 'NW1\\.D2-sigkill-between-the-canonical'),
        patches: [
            { from: 'writeStatusFile(canonicalStatusFile, document, { runningDir, durable: true, fsApi });', to: 'writeStatusFile(coordinationStatusFile, document, { runningDir, durable: true, fsApi });' },
            { from: 'written = writeStatusFile(coordinationStatusFile, document, { runningDir, durable: true, fsApi });', to: 'written = writeStatusFile(canonicalStatusFile, document, { runningDir, durable: true, fsApi });' },
        ] },
    'm18-a-finished-at-that-is-not-the-iso-of-its-milliseconds-is-accepted': { name: 'm18-a-finished-at-that-is-not-the-iso-of-its-milliseconds-is-accepted', file: PROTOCOL,
        kill: kill(WORKER_TEST, 'NW1\\.D2-terminal-timestamps-are-validated'),
        patches: [{ from: "if (typeof iso !== 'string' || expected === null || iso !== expected) {", to: 'if (false) {' }] },
    'ms15-a-canonical-failure-suppresses-the-run-scoped-write': { name: 'ms15-a-canonical-failure-suppresses-the-run-scoped-write', file: WORKER,
        kill: kill(WORKER_TEST, 'NW1\\.S-a-failed-canonical-write'),
        patches: [{ from: '    } catch (error) {\n        console.error(sanitizeDiagnosticText(\n            `[no-wait] ${containerName}: the canonical failed status could not be written durably; `',
            to: '    } catch (error) {\n        throw error;\n        console.error(sanitizeDiagnosticText(\n            `[no-wait] ${containerName}: the canonical failed status could not be written durably; `' }] },
    'm13-an-incomplete-store-is-read-as-absent': { name: 'm13-an-incomplete-store-is-read-as-absent', file: STORE,
        kill: kill(STORE_TEST, 'NW1\\.D1-missing-emptied-or-corrupt-store'),
        patches: [{ from: MISSING_POLICY, to: "directory = { state: 'absent' };" }] },
    'm14-the-reader-returns-empty-on-an-unreadable-store': { name: 'm14-the-reader-returns-empty-on-an-unreadable-store', file: STORE,
        kill: kill(STORE_TEST, 'NW1\\.D1-missing-emptied-or-corrupt-store'),
        patches: [{ from: "if (directory.state === 'invalid') throw unreadable(paths.availabilityStoreDir, directory.problem);",
            to: "if (directory.state === 'invalid') return deepFreeze({ state: 'absent', revision: HARDWARE_AVAILABILITY_ABSENT_REVISION, entries: {}, slots: {} });" }] },
    'm15-install-over-an-emptied-directory': { name: 'm15-install-over-an-emptied-directory', file: STORE,
        kill: kill(STORE_TEST, 'NW1\\.D1-missing-emptied-or-corrupt-store'),
        patches: [
            { from: MISSING_POLICY, to: "directory = { state: 'absent' };" },
            { from: 'for (const target of [paths.availabilityWitnessFile, paths.availabilityStoreDir]) {', to: 'for (const target of [paths.availabilityWitnessFile]) {' },
        ] },
    'm16-the-sweep-ignores-the-owner-pid': { name: 'm16-the-sweep-ignores-the-owner-pid', file: STORE,
        kill: kill(STORE_TEST, 'NW1\\.D1-dead-owner-temps'),
        patches: [{ from: 'if (!match || !ownerDead(Number(match[1]), killImpl)) continue;', to: 'if (!match) continue;' }] },
    'm17-a-post-rename-fsync-failure-rolls-back': { name: 'm17-a-post-rename-fsync-failure-rolls-back', file: STORE,
        kill: kill(STORE_TEST, 'NW1\\.D1-a-post-rename-fsync-failure'),
        patches: [{
            from: "        } catch (error) {\n            throw availabilityError(\n                `hardware availability policy '${paths.availabilityPolicyFile}' was committed",
            to: "        } catch (error) {\n            fsApi.unlinkSync(paths.availabilityPolicyFile);\n            throw availabilityError(\n                `hardware availability policy '${paths.availabilityPolicyFile}' was committed",
        }] },
    'm23-the-revision-includes-a-write-time': { name: 'm23-the-revision-includes-a-write-time', file: STORE,
        kill: kill(STORE_TEST, 'NW1\\.D1-identical-replay-writes-nothing'),
        patches: [
            { from: 'stableStringify({ schema, storeId, entries, slots })', to: 'stableStringify({ schema, storeId, entries, slots, at: String(process.hrtime.bigint()) })' },
            { from: "shape(computeHardwareAvailabilityRevision(document) === document.revision, 'policy revision does not match its content');", to: "shape(true, '');" },
        ] },
    'm28-a-witness-without-its-directory-is-read-as-absent': { name: 'm28-a-witness-without-its-directory-is-read-as-absent', file: STORE,
        kill: kill(STORE_TEST, 'NW1\\.D1-missing-emptied-or-corrupt-store'),
        patches: [{ from: "        if (witness.state === 'absent') {\n            return deepFreeze({", to: '        if (true) {\n            return deepFreeze({' }] },
    'm33-the-witness-is-written-before-the-directory-rename': { name: 'm33-the-witness-is-written-before-the-directory-rename', file: STORE,
        kill: kill(STORE_TEST, 'NW1\\.D1-sigkill-at-each-install-point'),
        patches: [
            { from: `${WITNESS_CALL}    } finally {`, to: '    } finally {' },
            { from: "        run('beforeDirectoryRename', { staging });", to: `${WITNESS_CALL}        run('beforeDirectoryRename', { staging });` },
        ] },
    'm34-a-missing-witness-beside-a-valid-store-is-unreadable': { name: 'm34-a-missing-witness-beside-a-valid-store-is-unreadable', file: STORE,
        kill: kill(STORE_TEST, 'NW1\\.D1-a-missing-witness-beside-a-valid-store'),
        patches: [{ from: '    const { document } = directory;\n', to: "    const { document } = directory;\n    if (witness.state === 'absent') throw unreadable(paths.availabilityStoreDir, 'the witness is missing');\n" }] },
    'ms36-the-validator-accepts-a-shared-run-id-and-a-missing-startup-grace': { name: 'ms36-the-validator-accepts-a-shared-run-id-and-a-missing-startup-grace', file: STORE,
        kill: kill(SLOTS_TEST, 'NW1\\.S-frozen-v1-slot-schema'),
        patches: [
            { from: "shape(!entry || entry.source.runId !== slot.runId, 'an entry and a slot of one route share a run id');", to: "shape(true, '');" },
            { from: "    publishedInteger(slot.startupGraceMs, `slot '${routeKey}' startup grace`, { maximum: MAX_HARDWARE_AVAILABILITY_STARTUP_GRACE_MS });\n", to: '' },
        ] },
});

function runLeaf(tmp, { file, pattern }, mutation) {
    const env = { ...process.env, TMPDIR: tmp };
    delete env.C5_MUTATION;
    delete env.NODE_TEST_CONTEXT;   // a nested `node --test` reports for itself, not as a child of this run
    if (mutation) env.C5_MUTATION = JSON.stringify(mutation);
    const child = spawnSync(process.execPath, ['--import', CONTRACT, '--import', GUARD, ...(mutation ? ['--import', REGISTER] : []), '--test', '--test-concurrency=1', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
    const output = `${child.stdout}\n${child.stderr}`;
    const count = (name) => Number((new RegExp(`^# ${name} (\\d+)`, 'm').exec(child.stdout) || [])[1]);
    return { status: child.status, signal: child.signal, output, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
}

for (const [name, spec] of Object.entries(AVAILABILITY_MUTANTS)) {
    test(`NW1M.${name}-is-killed-by-the-leaf-that-guards-it-never-by-a-setup-failure`, (t) => {
        const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwa-mut-')));
        t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
        // The patches apply exactly once to the real source and change it.
        const described = describeMutation(spec);
        assert.notEqual(described.sourceDigest, described.patchedDigest);
        // The control: the guarding leaf passes unmutated, nothing skipped.
        const control = runLeaf(tmp, spec.kill, null);
        assert.equal(control.status, 0, control.output.slice(-1500));
        assert.ok(control.pass >= 1 && control.fail === 0 && control.skipped === 0, control.output.slice(-800));
        // The mutant: the same leaf fails by its own assertion.
        const mutated = runLeaf(tmp, spec.kill, spec);
        assert.notEqual(mutated.status, 0, `the ${name} mutant survived`);
        assert.equal(mutated.signal, null);
        assert.ok(mutated.fail >= 1, mutated.output.slice(-1500));
        assert.match(mutated.output, /^not ok \d+ - NW1\./m);
        // The failure is the leaf's own (an assertion, or the product error it is meant to catch inside its code), not a harness failure.
        assert.match(mutated.output, /failureType: 'testCodeFailure'/);
        assert.ok(mutated.output.includes(path.basename(spec.kill.file)), 'the failing location is the guarding leaf file');
        // Not an import failure, a syntax error, an unapplied patch or a timeout.
        assert.doesNotMatch(mutated.output, /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|mutation patch matches|ETIMEDOUT|timed out/);
    });
}

test('NW1M.every-patch-text-matches-the-real-source-exactly-once-and-an-unmatched-patch-is-not-a-kill', () => {
    for (const spec of Object.values(AVAILABILITY_MUTANTS)) {
        const source = fs.readFileSync(path.join(ROOT, spec.file), 'utf8');
        assert.notEqual(applyPatches(source, spec.patches), source, spec.name);
    }
    assert.throws(() => applyPatches(fs.readFileSync(path.join(ROOT, STORE), 'utf8'), [{ from: 'this text is not in the store module', to: '' }]), /matches 0 times/);
});
