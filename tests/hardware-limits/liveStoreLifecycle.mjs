// LIVE-C5, the ACTUAL lifecycle section (after the store, lock and diagnostic-barrier steps 1 to 7): a verified gate-on restart, the writer-first
// order against the real gate-off restart (a committed policy makes the product refuse with its typed error before any lifecycle mutation), then the
// transition-first order (the real administrator writers at the production old-Box stop boundary of the real gate-off replacement, run by the
// driver, liveStoreTransition.mjs), the independent proof of the replacement generation and the custody receipts cleanup follows.
//
// Nothing here installs or removes the downgrade barrier, answers for the product, or substitutes a helper: the barrier under test is the one the
// PRODUCT's own forward transition installs. A timeout, a cancellation, a truncated transcript, a setup problem or a forced settlement is never a
// typed refusal, never a successful cleanup and never a mutant kill.
import crypto from 'node:crypto';
import path from 'node:path';

import { BOX_HARDWARE_MARKER_PATH, BOX_HARDWARE_STORE_PATH, BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { createHardwareGateStore } from '../../ploinky-box/hardwareLimitsGate.mjs';
import { BOX_CONTRACT_INSPECT, ID, INSPECT, assertWorkspace, canonicalDigest, checkedJson, jsonDigest, observeEngineFacts } from './liveCommon.mjs';
import {
    C5_DRIVER_NAME, createC5Intent, driverSettled, productEngineDigest, productTransitionIds, readDriverReceipt, reconcileC5Custody, sameImage,
} from './liveBoxTransitionCustody.mjs';
import { DRIVER_FILE, driverArgv, driverParams } from './liveStoreTransition.mjs';
import {
    OVERRIDES, TRANSITION_BOUNDS, assertCommitted, assertExitZero, assertNoLockNoBarrier, assertSameStore, revisionOf, tokenKey,
} from './liveStoreCommands.mjs';

export const WRITER_FIRST_CODE = 'PLOINKY_BOX_HARDWARE_LIMITS_STORED';
const LOGIN = { path: '/auth/login', headers: { accept: 'text/html' } };

// The driver's one stdout line, or null when it printed none.
export function parseDriverSummary(result) {
    const line = String(result?.stdout ?? '').split('\n').filter(value => value.startsWith('{')).at(-1);
    if (!line) return null;
    try { const value = JSON.parse(line); return value && typeof value === 'object' && value.schema === 1 ? value : null; } catch { return null; }
}

// Whether a bounded command ended on its own terms. Anything else is a transport outcome, never a product answer.
export function transportProblem(result) {
    if (!result) return 'produced no result';
    if (result.cancelled) return 'was cancelled';
    if (result.timedOut) return 'timed out';
    if (result.truncated) return 'was truncated';
    if (result.settlementForced) return 'needed a forced settlement';
    if (result.errorCode) return `failed to run (${result.errorCode})`;
    if (result.signal) return `was killed by ${result.signal}`;
    return null;
}

// The writer-first order: the product refuses with its typed error before any lifecycle mutation reached the engine.
export function assertWriterFirstRefusal(result, summary) {
    const transport = transportProblem(result);
    if (transport) return `The writer-first restart ${transport}; that is not a typed refusal`;
    if (!summary) return 'The writer-first driver printed no summary';
    const { outcome } = summary;
    if (outcome?.errorCode !== WRITER_FIRST_CODE) return `The writer-first restart was not refused with ${WRITER_FIRST_CODE} (error ${outcome?.errorCode ?? 'none'}, exit ${result.status}): a nonzero exit alone is not the typed refusal`;
    if (outcome.typedRefusal !== true || outcome.state !== 'success') return 'The writer-first driver did not record the typed refusal as its outcome';
    if (summary.mutations?.length || summary.runCalls !== 0 || outcome.mutations !== 0) return `A lifecycle operation reached the engine runner in the writer-first order (${(summary.mutations || []).map(entry => entry.kind).join(', ') || `${summary.runCalls} runner calls`})`;
    if (result.status !== 0) return `The writer-first driver exited ${result.status} although it recorded the refusal`;
    return null;
}

export function createLifecycle({ profile, run, command, engine, inspectBox, persist, artifactPath, http, sleep, polling, routerPolling = polling, fail, adminState, setLimits, hostClear, view, agentRef }) {
    const identity = () => assertWorkspace(profile);
    const gateEnabled = () => createHardwareGateStore({ homeDirectory: profile.host.home }).read(identity())?.enabled ?? null;
    const startDeadline = () => (Number.isInteger(run.deadlines?.startMs) ? run.deadlines.startMs : 1200000);
    const preInventory = () => (run.preInventory?.containers || []).map(value => value.id);

    async function listIds(kind) {
        const result = await engine(kind, ['container', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}']);
        const ids = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : [];
        if (ids.length > 256 || ids.some(id => !ID.test(id))) throw fail('The container inventory is not supported', { count: ids.length });
        return ids;
    }
    // The full inspect document of one exact ID, as the product's own normalizer reads it.
    async function inspectFull(id) {
        const result = await engine('c5-inspect-generation', ['container', 'inspect', id], { maxBytes: 262144 });
        let value;
        try { [value] = JSON.parse(result.stdout); } catch { throw fail('The generation inspect document is not JSON'); }
        return value;
    }
    async function inspectExact(id) {
        const value = checkedJson(await engine('c5-inspect-exact', ['container', 'inspect', '--format', INSPECT, id]));
        if (value.id !== id) throw fail('The engine answered for another container than the exact ID asked');
        return value;
    }
    // ONE fresh engine document: the harness digest is checked against the pinned one and the product's own digest is computed from the same document.
    async function engineFacts() {
        const facts = await observeEngineFacts((kind, argv) => engine(kind, argv));
        if (facts.digest !== profile.engine.identityDigest) throw fail('The engine service identity changed');
        return { digest: facts.digest, product: productEngineDigest(facts.info) };
    }
    const summaryOf = result => parseDriverSummary(result);

    // What a lifecycle operation must leave exactly as it found it.
    async function capture(label) {
        const box = await inspectBox();
        const host = await view(identity(), 'host', label); const inBox = await view(identity(), 'box', label);
        try { assertSameStore(host, inBox, label); } catch (error) { throw fail(error.message, { host, box: inBox }); }
        const router = await adminState();
        return {
            box: { id: box.id, created: box.created, image: box.image, running: box.running, pid: box.pid, startedAt: box.startedAt, contractDigest: jsonDigest({ labels: box.labels, mounts: box.mounts }) },
            policy: { token: host.token, count: host.count, entries: host.agents, storeId: host.storeId }, routerToken: router.token, gate: gateEnabled(), transitions: productTransitionIds(profile),
            lock: host.lock, barrier: host.barrier,
        };
    }
    const sameState = (before, after) => jsonDigest(before) === jsonDigest(after);

    async function waitForRouter(label) {
        const started = Date.now(); let last = null;
        for (;;) {
            try { return await adminState(); } catch (error) { last = error; }
            if (Date.now() - started >= routerPolling.deadlineMs) throw fail(`${label}: the Router's administrator route never answered`, { last: String(last?.message || last).slice(0, 200) });
            await sleep(routerPolling.intervalMs);
        }
    }

    // ---- verified gate-on restart ----
    async function restartOn() {
        const result = await command('c5-restart-on', profile.node.path, [profile.candidate.path, 'restart'], { gate: 'on', deadlineMs: startDeadline(), tolerate: true, capture: 'c5-restart-on' });
        const transport = transportProblem(result);
        if (transport) throw fail(`The whole restart with the gate on ${transport}`, { exit: result.status });
        assertExitZero(result, 'The whole restart with the gate on');
        let box;
        try { box = await inspectBox(); }
        catch (error) { throw fail(`The gate-on restart did not keep the original immutable outer Box: ${error.message}`, { original: profile.box.id }); }
        if (box.running !== true) throw fail('The original Box is not running after the gate-on restart');
        const router = await waitForRouter('After the gate-on restart');
        const host = await view(identity(), 'host', 'after the gate-on restart'); const inBox = await view(identity(), 'box', 'after the gate-on restart');
        try { assertSameStore(host, inBox, 'after the gate-on restart'); assertNoLockNoBarrier(host, 'after the gate-on restart'); } catch (error) { throw fail(error.message, { host, box: inBox }); }
        if (host.count !== 0) throw fail(`The store holds ${host.count} entries after the gate-on restart; the lifecycle section needs it empty`, { entries: host.agents });
        if (tokenKey(router.token) !== tokenKey(host.token)) throw fail('The Router and the host read different stamps after the gate-on restart', { router: router.token, host: host.token });
        if (gateEnabled() !== true) throw fail('The saved gate is not on after the gate-on restart');
        return { exit: 0, box: { id: box.id, created: box.created, running: true }, token: host.token, count: host.count, lock: null, barrier: null, router: true, gate: true };
    }

    // ---- writer first ----
    async function writerFirst() {
        const baseline = await adminState();
        const committed = assertCommitted(await setLimits('c5-writer-first-set', OVERRIDES.low, baseline.token), 'The writer-first write through the administrator API');
        const before = await capture('before the refused gate-off restart');
        if (before.policy.count !== 1 || tokenKey(before.policy.token) !== tokenKey(committed)) throw fail('The committed policy is not what the host reads before the gate-off restart', { before: before.policy, committed });
        const params = driverParams({ mode: 'writer-first', profile, run, agentRef });
        const result = await command('c5-writer-first', profile.node.path, driverArgv(profile, params), { gate: 'off', deadlineMs: TRANSITION_BOUNDS.lifecycleMs, tolerate: true, capture: 'c5-writer-first' });
        const summary = summaryOf(result);
        const problem = assertWriterFirstRefusal(result, summary);
        if (problem) throw fail(problem, { summary: summary ? { outcome: summary.outcome, mutations: summary.mutations, runCalls: summary.runCalls, primaryFailure: summary.primaryFailure } : null });
        const after = await capture('after the refused gate-off restart');
        if (!sameState(before, after)) throw fail('The refused writer-first restart changed the Box, the policy, the stamp, the gate or the transitions', { before, after });
        return { committed, refusal: { code: summary.outcome.errorCode, mutations: 0, runCalls: summary.runCalls, message: summary.outcome.message }, unchanged: { box: before.box, token: before.policy.token, entries: before.policy.entries, gate: before.gate, transitions: before.transitions } };
    }

    // ---- the host clear that ends the writer-first order; its stamp is T ----
    async function clearAfterRefusal() {
        const before = await view(identity(), 'host', 'before the clear that ends the writer-first order');
        assertExitZero(await hostClear('c5-host-clear-after-refusal'), 'The host clear after the writer-first refusal');
        const after = await view(identity(), 'host', 'after the clear that ends the writer-first order');
        if (revisionOf(after.token) !== revisionOf(before.token) + 1 || after.count !== 0) throw fail('The host clear did not advance the stamp exactly once and empty the policy', { before: before.token, after: after.token, count: after.count });
        const box = await inspectBox();
        if (box.running !== true) throw fail('The gate-on Box is not running after the host clear');
        assertNoLockNoBarrier(after, 'after the clear that ends the writer-first order');
        return { token: after.token, previous: before.token, boxRunning: true };
    }

    // ---- transition first ----
    async function transitionFirst(token) {
        const prior = productTransitionIds(profile);
        const invocationId = crypto.randomBytes(16).toString('hex');
        const receiptName = `${C5_DRIVER_NAME}-${invocationId}`;
        const receiptPath = artifactPath(receiptName);
        const argvDigest = jsonDigest([profile.node.path, path.join(profile.source.root, DRIVER_FILE), 'transition', invocationId]);
        const intent = createC5Intent({ run, profile, driverReceiptName: receiptName, argvDigest, priorTransitionIds: prior, invocationId });
        // Write-ahead: the invocation is durable in the manifest (file and directory fsynced) before the driver, or anything it starts, can run.
        run.operations.push(intent); persist();
        const params = driverParams({ mode: 'transition', profile, run, intent, receiptPath, expectedToken: { epoch: token.epoch, revision: token.revision }, agentRef });
        const result = await command(C5_DRIVER_NAME, profile.node.path, driverArgv(profile, params), { gate: 'off', deadlineMs: TRANSITION_BOUNDS.lifecycleMs, tolerate: true, capture: 'c5-transition-driver', tolerateCancel: true });
        // The owned transport's own proof of how the driver ended, kept on the invocation: cleanup never trusts a saved PID.
        intent.state = 'observed';
        intent.driverResult = { status: result.status, signal: result.signal, timedOut: Boolean(result.timedOut), truncated: Boolean(result.truncated), cancelled: Boolean(result.cancelled),
            errorCode: result.errorCode ?? null, settlementForced: Boolean(result.settlementForced) };
        persist();
        const summary = summaryOf(result);
        let receipt;
        try { receipt = readDriverReceipt(receiptPath, intent, profile); }
        catch (error) { throw fail(`The driver receipt is not valid: ${String(error.message).slice(0, 200)}`, { exit: result.status }); }
        if (!receipt) throw fail('The lifecycle driver left no receipt', { exit: result.status });
        const transport = transportProblem(result);
        if (transport) throw fail(`The gate-off lifecycle driver ${transport}; that is neither a refusal nor a pass`, { exit: result.status, receiptPhase: receipt.phase, primaryFailure: receipt.primaryFailure });
        // The primary assertion failure stays the answer even when the product wrapped it in its own rollback error.
        if (receipt.primaryFailure) throw fail(receipt.primaryFailure.message, { primaryFailure: receipt.primaryFailure, outcome: receipt.outcome, operationId: receipt.productOperationId, events: receipt.events.slice(-24) });
        if (receipt.phase !== 'settled' || receipt.outcome?.state !== 'success' || result.status !== 0 || !summary || summary.outcome?.state !== 'success') {
            throw fail(`The actual gate-off restart did not commit the desired-off generation (${receipt.outcome?.errorCode || `exit ${result.status}`}: ${receipt.outcome?.message || 'no outcome'})`, { outcome: receipt.outcome, attempts: receipt.attempts });
        }
        if (summary.operationId !== receipt.productOperationId || receipt.productOperationId === null || prior.includes(receipt.productOperationId)) throw fail('The driver summary and its receipt name different product operations');
        if (!ID.test(receipt.finalContainerId ?? '')) throw fail('The committed product journal names no final container');
        const facts = await engineFacts();
        if (facts.product !== receipt.productEngineIdentity) throw fail('The product engine identity of the journal is not that of the fresh engine observation');
        const ids = await listIds('c5-final-ids');
        const custody = await reconcileC5Custody({ run, profile, driver: receipt, driverSettled: driverSettled(run), engineIdentity: facts.product, ids, unrelatedIds: preInventory(), inspect: inspectFull, persist });
        const current = custody.current;
        if (!current || current.id !== receipt.finalContainerId || current.stage !== 'candidate' || custody.ids.length !== 2) throw fail('The committed final generation is not the one linked candidate generation of the bound product operation', { current, chain: custody.ids });
        const final = await finalGeneration({ current, ids, token });
        return { invocationId, productOperationId: receipt.productOperationId, replies: summary.boundary?.replies ?? null, boundary: { reached: summary.boundary?.reached === true, events: summary.events.filter(event => /^(writer|retention|bound|boundary)/.test(event.kind)).map(({ kind, sequence, status, error, held, stage }) => ({ kind, sequence, status, error, held, stage })) },
            attempts: receipt.attempts, finalContainerId: receipt.finalContainerId, token, final, generations: run.ownedBoxes.filter(box => box.id !== profile.box.id), engine: { harness: facts.digest, product: facts.product } };
    }

    // ---- the replacement, inspected on its own ----
    async function finalGeneration({ current, ids, token }) {
        if (ids.includes(profile.box.id)) throw fail('The old immutable Box ID is still present after the committed transition', { old: profile.box.id });
        const box = await inspectExact(current.id);
        const contract = checkedJson(await engine('c5-generation-contract', ['container', 'inspect', '--format', BOX_CONTRACT_INSPECT, current.id]));
        const labels = box.labels || {};
        const mounts = Array.isArray(box.mounts) ? box.mounts : [];
        const destinations = mounts.map(mount => mount.Destination);
        const checks = {
            exactId: box.id === current.id && contract.id === current.id,
            created: box.created === current.created,
            image: sameImage(box.image, profile.box.image) && sameImage(current.image, profile.box.image),
            owned: labels[BOX_LABELS.pathHash] === profile.box.pathHash && labels[BOX_LABELS.role] === 'box',
            contract: canonicalDigest({ labels, mounts }) === current.contractDigest,
            running: box.running === true,
            gateRecordOff: gateEnabled() === false,
            noHardwareLabel: !Object.hasOwn(labels, BOX_LABELS.hardwareLimits),
            noHardwareBinds: !destinations.includes(BOX_HARDWARE_STORE_PATH) && !destinations.includes(BOX_HARDWARE_MARKER_PATH),
            workspaceMounted: mounts.some(mount => mount.Source === profile.workspace.path && mount.Destination === profile.workspace.path && mount.RW === true),
            sourceMounted: mounts.some(mount => mount.Destination === '/opt/ploinky' && mount.Source === profile.source.root && mount.RW === false),
            publications: JSON.stringify(Object.keys(contract.publications || {}).sort()) === JSON.stringify(['7882/udp', '8080/tcp'])
                && (contract.publications['8080/tcp'] || []).length === 1 && contract.publications['8080/tcp'][0].HostIp === '127.0.0.1' && String(contract.publications['8080/tcp'][0].HostPort) === String(run.ports.tcp)
                && (contract.publications['7882/udp'] || []).length === 1 && String(contract.publications['7882/udp'][0].HostPort) === String(run.ports.udp),
            unprivileged: contract.privileged === false,
        };
        const wrong = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
        if (wrong.length) throw fail(`The replacement Box ${String(current.id).slice(0, 12)} is not the gate-off generation the transition committed (${wrong.join(', ')})`, { checks, labels: Object.keys(labels).sort(), destinations });
        // The Router of the replacement answers as a browser's address would reach it.
        const login = await http({ port: run.ports.tcp, path: LOGIN.path, headers: LOGIN.headers });
        if (login?.status !== 200) throw fail('The replacement Box\'s Router does not answer /auth/login with HTTP 200', { status: login?.status ?? null, error: login?.error ?? null });
        const host = await view(identity(), 'host', 'after the committed transition');
        if (host.count !== 0 || host.barrier || host.lock) throw fail('The store is not empty and free after the committed transition', { count: host.count, barrier: host.barrier, lock: host.lock });
        if (tokenKey(host.token) !== tokenKey(token)) throw fail('The host store is not at the stamp T after the committed transition', { stamp: token, now: host.token });
        return { id: current.id, created: current.created, checks, router: login.status, gate: false, store: { token: host.token, count: host.count, barrier: null }, publications: contract.publications };
    }

    return { restartOn, writerFirst, clearAfterRefusal, transitionFirst, internals: { capture, listIds, inspectExact, engineFacts, finalGeneration, inspectFull } };
}
