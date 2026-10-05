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
const RESOLVER = 'cli/server/hardwareAvailabilityResolver.mjs';
const RESOLVER_TEST = 'tests/unit/hardwareAvailabilityResolver.test.mjs';
const LEASES_TEST = 'tests/unit/hardwareAvailabilityLeases.test.mjs';
const OBSERVERS_TEST = 'tests/unit/hardwareAvailabilityObservers.test.mjs';
const OBSERVER = 'cli/server/noWaitAgentStartupState.js';
const PROBE = 'tests/unit/hardwareAvailabilityEvidenceProbe.mjs';
const PROBE_TEST = 'tests/unit/hardwareAvailabilityEvidenceProbe.test.mjs';
const REVISION = '        revision: computeEffectiveRevision(denials),\n';
const kill = (file, pattern) => ({ file, pattern });
// A denial that is not derived from validated active evidence: the old hardware-coded fail-closed object.
const HARDWARE_CODED = "Object.freeze({ state: 'refused', code: 'PLOINKY_HARDWARE_LIMITS_UNENFORCEABLE', reasonCode: 'unprepared', key: '', instanceId: '', enableGeneration: '', reason: 'The hardware availability record is invalid.', fix: 'On the host run ploinky limits status.', rootKey: '' })";
const SLOT_RECORDED = "        slots.set(routeKey, Object.freeze({ runId: slot.runId, evidenceClass: evidence.evidenceClass }));\n";
const denyClasses = (...classes) => ({ from: SLOT_RECORDED,
    to: `${SLOT_RECORDED}        if (${classes.map((name) => `evidence.evidenceClass === '${name}'`).join(' || ')}) denials.set(routeKey, ${HARDWARE_CODED});\n` });
const IDENTITY_RETURN = '    return identity.containerName === slot.key\n        && identity.instanceId === slot.instanceId\n        && identity.enableGeneration === slot.enableGeneration\n        && identity.routeKey === routeKey\n        && identity.runId === slot.runId\n        && identity.runStartedAtMs === slot.runStartedAtMs\n        && identity.waveIndex === slot.waveIndex\n        && identity.statusFile === slot.statusFile;\n';
const LEASES_KILL = 'NW1\\.S-both-lease-families';
const resolverMutant = (name, killLeaf, patches) => ({ name, file: RESOLVER, kill: kill(killLeaf === LEASES_KILL ? LEASES_TEST : RESOLVER_TEST, killLeaf), patches });
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
    'ms1-the-resolver-reads-the-canonical-status-file': resolverMutant('ms1-the-resolver-reads-the-canonical-status-file', 'NW1\\.S-manifest-drift-and-restoration', [
        { from: '    const read = readEvidence(fsApi, file);\n', to: '    readEvidence(fsApi, path.join(path.dirname(file), `${slot.key}.json`));\n    const read = readEvidence(fsApi, file);\n' }]),
    'ms2-the-resolver-lists-the-no-wait-directory': resolverMutant('ms2-the-resolver-lists-the-no-wait-directory', 'NW1\\.S-only-validated-active-evidence-yields', [
        { from: '        named.add(file);\n', to: '        named.add(file);\n        fsApi.readdirSync(path.join(runningDir, NO_WAIT_DIR_NAME));\n' }]),
    'ms3-pid-less-evidence-yields-a-denial': resolverMutant('ms3-pid-less-evidence-yields-a-denial', 'NW1\\.S-pid-less-or-invalid-evidence', [
        { from: "    const hasPid = Object.prototype.hasOwnProperty.call(status, 'pid');\n", to: '    const hasPid = true;\n' },
        { from: '    if (hasPid && !(Number.isSafeInteger(status.pid) && status.pid > 0)) return invalid;\n', to: '' }]),
    'ms4-slot-identity-equality-is-skipped': resolverMutant('ms4-slot-identity-equality-is-skipped', 'NW1\\.S-(only-validated-active-evidence-yields|obsolete-run-and-superseded)', [
        { from: IDENTITY_RETURN, to: '    return Boolean(identity);\n' }]),
    'ms5-the-target-less-rule-is-dropped': resolverMutant('ms5-the-target-less-rule-is-dropped', 'NW1\\.S-(slots-apply-only|entries-apply-only)', [
        { from: '    const hostPort = Number(route.hostPort);\n    if (Number.isSafeInteger(hostPort) && hostPort >= 1 && hostPort <= 65535) return false;\n', to: '' }]),
    'ms6-tuple-currentness-is-dropped': resolverMutant('ms6-tuple-currentness-is-dropped', 'NW1\\.S-(slots-apply-only|entries-apply-only)', [
        { from: '    return Boolean(agent && route)\n        && agent.instanceId === instanceId\n        && agent.enableGeneration === enableGeneration\n        && route.container === key', to: '    return Boolean(agent && route)\n        && route.container === key' }]),
    'ms9-the-evidence-cache-never-invalidates': resolverMutant('ms9-the-evidence-cache-never-invalidates', 'NW1\\.S-per-capture-cost', [
        { from: '    if (cached && cached.key === key && cached.signature === signature) return cached.result;', to: '    if (cached && cached.signature === signature) return cached.result;' }]),
    'ms10-unchanged-evidence-is-re-read-every-capture': resolverMutant('ms10-unchanged-evidence-is-re-read-every-capture', 'NW1\\.S-per-capture-cost', [
        { from: '    if (cached && cached.key === key && cached.signature === signature) return cached.result;', to: '    if (false) return cached.result;' }]),
    'ms18-invalid-slotted-evidence-yields-a-hardware-coded-denial': resolverMutant('ms18-invalid-slotted-evidence-yields-a-hardware-coded-denial', 'NW1\\.S-only-validated-active-evidence-yields', [denyClasses('invalid')]),
    'ms19-the-resolver-copies-message-text-into-the-denial': resolverMutant('ms19-the-resolver-copies-message-text-into-the-denial', 'NW1\\.S-the-resolver-discloses-only', [
        { from: '        compiled: Object.freeze(compileAvailabilityProjection(projection)),', to: "        compiled: Object.freeze({ ...compileAvailabilityProjection(projection), message: String(status.error?.message ?? '') })," }]),
    'ms26-missing-evidence-yields-a-hardware-coded-denial': resolverMutant('ms26-missing-evidence-yields-a-hardware-coded-denial', 'NW1\\.S-(an-unlatched-activation-whose|no-store-denial-arises)', [denyClasses('missing')]),
    'ms27-unowned-evidence-yields-a-hardware-coded-denial': resolverMutant('ms27-unowned-evidence-yields-a-hardware-coded-denial', 'NW1\\.S-pid-less-or-invalid-evidence', [denyClasses('unowned')]),
    'ms28-an-unlatched-activation-keeps-its-denial-after-its-status-disappears': resolverMutant('ms28-an-unlatched-activation-keeps-its-denial-after-its-status-disappears', 'NW1\\.S-an-unlatched-activation-whose', [
        { from: "        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {\n            const result = { evidenceClass: 'missing' };", to: "        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {\n            const result = evidenceCache.get(file)?.result?.evidenceClass === 'active' ? evidenceCache.get(file).result : { evidenceClass: 'missing' };" }]),
    'ms33-a-non-active-own-pid-class-yields-a-denial': resolverMutant('ms33-a-non-active-own-pid-class-yields-a-denial', 'NW1\\.S-no-store-denial-arises', [denyClasses('pending', 'succeeded', 'failed-generic')]),
    'ms38-a-slot-without-a-validated-outcome-yields-a-hardware-coded-denial': resolverMutant('ms38-a-slot-without-a-validated-outcome-yields-a-hardware-coded-denial', 'NW1\\.S-(only-validated-active-evidence-yields|no-store-denial-arises)', [
        { from: '        outcome = noWaitTerminalHardwareOutcome(status, validateHardwareOutcome);\n    } catch (_) {\n        return invalid;\n    }', to: "        outcome = noWaitTerminalHardwareOutcome(status, validateHardwareOutcome);\n    } catch (_) {\n        return { evidenceClass: 'invalid', unvalidated: true };\n    }" },
        { from: SLOT_RECORDED, to: `${SLOT_RECORDED}        if (evidence.unvalidated) denials.set(routeKey, ${HARDWARE_CODED});\n` }]),
    // The effective revision (the lease fence) covers exactly the store-derived denials.
    'ms7-the-effective-revision-omits-activations': resolverMutant('ms7-the-effective-revision-omits-activations', LEASES_KILL, [
        { from: REVISION, to: '        revision: computeEffectiveRevision(new Map([...denials].filter(([routeKey]) => !slots.has(routeKey)))),\n' }]),
    'ms8-the-effective-revision-includes-non-denial-classes': resolverMutant('ms8-the-effective-revision-includes-non-denial-classes', LEASES_KILL, [
        { from: REVISION, to: '        revision: computeEffectiveRevision(new Map([...denials, ...[...slots].map(([routeKey, slot]) => [`${routeKey}#slot`, slot.evidenceClass])])),\n' }]),
    // A visible-but-not-durable terminal status is credited with a durability time.
    'ms44-durability-is-credited-at-the-rename-despite-a-failed-fsync': { name: 'ms44-durability-is-credited-at-the-rename-despite-a-failed-fsync', file: WORKER,
        kill: kill(PROBE_TEST, 'NW1\\.S-durable-activation-is-proved'),
        patches: [{ from: '{ visibleAtMs: error.visibleAtMs, durabilityError: error.fsCode }', to: '{ visibleAtMs: error.visibleAtMs, durableAtMs: error.visibleAtMs }' }] },
    // The probe (a separate process, patched through the same loader) follows a stale selector read instead of the generation the selector names.
    'ms45-the-evidence-probe-evaluates-a-different-generation-than-the-selector-names': { name: 'ms45-the-evidence-probe-evaluates-a-different-generation-than-the-selector-names', file: PROBE,
        kill: kill(PROBE_TEST, 'NW1\\.S-durable-activation-is-proved'),
        patches: [{ from: '            const selector = edge.readEdgeRoutingSelection(edgeOptions).selector;\n', to: '            const selector = (globalThis.__firstSelector ??= edge.readEdgeRoutingSelection(edgeOptions).selector);\n' }] },
    // A slotted run's navigation/probe observer takes its hardware result from the status feed, which lacks the resolver's checks.
    'ms46-the-observer-derives-a-hardware-result-from-a-slotted-runs-status': { name: 'ms46-the-observer-derives-a-hardware-result-from-a-slotted-runs-status', file: OBSERVER,
        kill: kill(OBSERVERS_TEST, 'NW1\\.S-observers-and-transports-agree'),
        patches: [{ from: '        if (slottedRun(plan, marker)) return STARTUP_FAILED_RESULT;\n', to: '' }] },
    'ms50a-the-probe-credits-an-observation-outside-the-window': { name: 'ms50a-the-probe-credits-an-observation-outside-the-window', file: PROBE,
        kill: kill(PROBE_TEST, 'NW1\\.S-durable-activation-is-proved'),
        patches: [{ from: 'observedInWindow: Number.isFinite(firstActiveObservedAtMs) && firstActiveObservedAtMs <= tFinMs + windowMs + pollIntervalMs,', to: 'observedInWindow: Number.isFinite(firstActiveObservedAtMs),' }] },
    'ms50b-the-probe-skips-the-ctime-cross-check': { name: 'ms50b-the-probe-skips-the-ctime-cross-check', file: PROBE,
        kill: kill(PROBE_TEST, 'NW1\\.S-durable-activation-is-proved'),
        patches: [{ from: 'ctimeMatchesVisible: Number.isFinite(ctimeMs) && Number.isFinite(tVisMs) && Math.abs(ctimeMs - tVisMs) <= ctimeToleranceMs,', to: 'ctimeMatchesVisible: true,' }] },
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
