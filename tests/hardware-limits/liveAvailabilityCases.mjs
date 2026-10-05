// LIVE-C3 (spec 15.4 :1324) and LIVE-C3V (spec :774, :1227, :1332): the live executors, built over the adapter's own journaled commands.
//
// C3: in one owned workspace (a -> b, c, x; c unrelated), a valid stored RAM override is saved for the managed-network agents b and x, then ONLY b's
// manifest becomes host-network + nestedPodman. The normal setter must now refuse it with the typed unenforceable-limit outcome, and a whole restart
// must end exit 0 with b refused, a blocked by b, c ready and the exact b/a routes inactive (variant i). Then a's `enable` makes b an optional no-wait
// child: a ready, b refused, routes inactive (variant ii). Then x is dropped from a's enable and refused itself, so it is an enabled extra (variant iv).
// Variant iii (an independently explicit status waiter) has no live producer in this revision: it is declared infeasible, never passed.
//
// C3V: in a dedicated workspace and Box, the STATIC agent is the refused fixture. The Router keeps its own controls: the static route answers the
// terminal unavailable response, /auth/login answers 200, the administrator API answers 200, and the host `limits status` and `limits clear` exit 0.
// The Box is then destroyed and proven absent by the cleanup action (AC-S7-3).

import fs from 'node:fs';
import path from 'node:path';
import { blocked, digest } from './liveCommon.mjs';
import { ADMIN_REQUEST } from './liveGpuCommands.mjs';
import { FIXTURE_REPOSITORY, fixtureContainerName } from './liveFixture.mjs';
import {
    C3_AGENTS, C3V_AGENTS, MANIFEST_ENABLE, NESTED_STATE_FORMAT, STORED_OVERRIDE, VARIANT_III_EVIDENCE, availabilityPolling,
    assertAdminListsRefused, assertBlockedBy, assertControllersUnchanged, assertExitZero, assertNestedStates, assertReady, assertRefused, assertRoutes, assertRouterControl,
    assertSetterRefused, assertStaticTerminal, containerOf, d4Manifest, httpProbe, manifestText, parseAdminReply, parseNestedStates, withEnable,
} from './liveAvailabilityCommands.mjs';

const sleepMs = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const refOf = name => `${FIXTURE_REPOSITORY}/${name}`;

export function createAvailabilityCases({ profile, run, command, engine, core, nested, inspectBox, safeArtifact, persist, http = httpProbe, fsApi = fs, sleep = sleepMs, polling = availabilityPolling }) {
    const workspace = profile.workspace.path;
    const repository = path.join(workspace, '.ploinky', 'repos', FIXTURE_REPOSITORY);
    const keyOf = name => fixtureContainerName(workspace, name);
    let captureCounter = 0;
    const fail = (message, evidence = null) => Object.assign(new Error(message), evidence ? { evidence } : {});

    // ---- the administrator channel: the Router's hardware-limits route, from inside the Box with the product's own local-operator session ----
    async function adminCall(kind, method, body = null) {
        const mutating = method === 'POST';
        const result = await command(kind, profile.engine.path, [...core, 'node', '-e', ADMIN_REQUEST, method, body === null ? '' : JSON.stringify(body)],
            { deadlineMs: 60000, journal: mutating, tolerate: true, ...(mutating ? { capture: `availability-${kind}-${++captureCounter}` } : {}) });
        if (result.cancelled) throw new Error('The administrator request was cancelled');
        const reply = result.status === 0 && !result.timedOut ? parseAdminReply(result.stdout) : null;
        if (!reply) throw blocked(`The administrator channel did not answer (exit ${result.status}${result.timedOut ? ', timed out' : ''})`);
        return reply;
    }
    async function adminState() {
        const reply = await adminCall('availability-admin-state', 'GET');
        if (reply.status !== 200 || reply.body?.ok !== true || !reply.body?.token) throw blocked(`The hardware-limits administrator route answered ${reply.status}: ${reply.text.slice(0, 200)}`);
        return reply.body;
    }
    const setLimits = (agent, token) => adminCall('availability-set-limits', 'POST', { action: 'set_agent_limits', expectedToken: token, agentRef: refOf(agent), limits: { ...STORED_OVERRIDE } });

    // ---- the fixture repository: exactly the recorded manifests, changed one file at a time and journaled ----
    const recorded = new Map();
    function recordedManifests() {
        if (recorded.size) return recorded;
        const written = run.operations.find(op => op.kind === 'fixture-write' && op.files);
        if (!written) throw blocked('The provisioning run recorded no fixture manifests to start from');
        for (const [relative, value] of Object.entries(written.files)) recorded.set(path.join(workspace, relative), value);
        return recorded;
    }
    function repositoryDigests() {
        const found = new Map();
        for (const name of fsApi.readdirSync(repository).sort()) {
            const file = path.join(repository, name, 'manifest.json');
            if (fsApi.existsSync(file)) found.set(file, digest(fsApi.readFileSync(file, 'utf8')));
        }
        return found;
    }
    // Every manifest equals what is recorded: the fixture is exactly what provisioning wrote, plus the edits this case made itself.
    function assertRepositoryIsAsRecorded(label) {
        const expected = recordedManifests();
        const actual = repositoryDigests();
        const differing = [...new Set([...expected.keys(), ...actual.keys()])].filter(file => expected.get(file) !== actual.get(file));
        if (differing.length) throw fail(`${label}: the fixture repository differs from what this run recorded in ${differing.map(file => path.relative(repository, file)).join(', ')}`);
    }
    function editManifest(kind, name, transform) {
        const file = path.join(repository, name, 'manifest.json');
        assertRepositoryIsAsRecorded(`before editing ${name}`);
        const before = fsApi.readFileSync(file, 'utf8');
        const after = manifestText(transform(JSON.parse(before)));
        const op = { id: `live-${run.operations.length + 1}`, kind, state: 'intent', resourceIds: [], argvDigest: null, resultArtifact: null, path: file, beforeDigest: digest(before), afterDigest: digest(after) };
        run.operations.push(op); persist();
        const temporary = `${file}.${run.runId.slice(0, 8)}.tmp`;
        fsApi.writeFileSync(temporary, after, { flag: 'wx', mode: 0o644 });
        fsApi.renameSync(temporary, file);
        op.state = 'observed'; persist();
        recordedManifests().set(file, op.afterDigest);
        assertRepositoryIsAsRecorded(`after editing ${name}`);
        return { file: path.relative(workspace, file), before: op.beforeDigest, after: op.afterDigest };
    }

    // ---- observation ----
    function readRouting() {
        try { return JSON.parse(fsApi.readFileSync(path.join(workspace, '.ploinky', 'routing.json'), 'utf8')); } catch (error) { throw fail(`The routing source cannot be read (${String(error.code || error.message).slice(0, 60)})`); }
    }
    async function nestedStates(label) {
        const result = await engine(`availability-nested-${label}`, [...nested, 'container', 'ps', '--all', '--no-trunc', '--format', NESTED_STATE_FORMAT], { journal: false, deadlineMs: 30000 });
        return parseNestedStates(result.stdout);
    }
    // Poll the administrator state until the graph settled into what the variant expects, or the bound passes with the last problem as the evidence.
    async function settle(label, check) {
        const started = Date.now();
        let lastProblem = null; let polls = 0;
        for (;;) {
            polls += 1;
            let state = null;
            try { state = await adminState(); check(state); return { state, polls, ms: Date.now() - started }; } catch (error) {
                lastProblem = error;
            }
            // A route or channel that never answered is a prerequisite, not a verdict on the graph.
            if (Date.now() - started >= polling.deadlineMs && lastProblem?.code === 'LIVE_PREREQUISITE_MISSING') throw Object.assign(lastProblem, { evidence: { label, polls } });
            if (Date.now() - started >= polling.deadlineMs) throw fail(`${label}: ${String(lastProblem?.message || lastProblem).slice(0, 300)} (after ${polls} polls, ${Date.now() - started} ms)`, { label, polls, lastProblem: String(lastProblem?.message || lastProblem).slice(0, 300) });
            await sleep(polling.intervalMs);
        }
    }
    async function restartWhole(label) {
        const result = await command(`availability-restart-${label}`, profile.node.path, [profile.candidate.path, 'restart'], { deadlineMs: run.deadlines.startMs || 1200000, tolerate: true, capture: `availability-restart-${label}` });
        assertExitZero('The whole restart', result);
        return { status: result.status };
    }
    const controllersOf = state => state.gate?.controllers;

    // =========================================================================
    async function liveC3() {
        for (const name of C3_AGENTS) if (!profile.agents.some(agent => agent.role === name)) throw blocked(`LIVE-C3 requires the owned fixture agent ${name}`);
        await inspectBox();
        assertRepositoryIsAsRecorded('at the start');
        const keys = Object.fromEntries(C3_AGENTS.map(name => [name, keyOf(name)]));
        const evidence = { agents: keys, variants: {} };
        const record = (name, value) => { evidence[name] = value; safeArtifact(`availability-${name}`, value); };

        // Baseline: every agent ready, nothing stored, the delegated controllers as the Box reports them.
        const baseline = await settle('baseline', state => { for (const name of C3_AGENTS) assertReady(containerOf(state, refOf(name), keys[name]), `Agent ${name}`); });
        const controllers = assertControllersUnchanged(controllersOf(baseline.state), controllersOf(baseline.state));
        record('baseline', { controllers, token: baseline.state.token, polls: baseline.polls });

        // A valid stored RAM override for the managed-network b and x (spec: "save a valid RAM override for managed-network B").
        let token = baseline.state.token;
        for (const name of ['b', 'x']) {
            const saved = await setLimits(name, token);
            if (saved.status !== 200 || saved.body?.ok !== true || !saved.body?.token || saved.body.committed !== true) throw fail(`A valid RAM override of ${name} was not saved (HTTP ${saved.status})`, { name, status: saved.status, body: saved.text });
            token = saved.body.token;
        }
        record('stored', { token, override: { ...STORED_OVERRIDE }, agents: ['b', 'x'] });

        // Change ONLY b's manifest to host networking + nestedPodman.
        const changedB = editManifest('availability-manifest-d4', 'b', d4Manifest);
        record('manifest-b', changedB);

        // The stored historical policy now fails D4, and a normal attempt to set it again refuses with the typed outcome; nothing is committed.
        const before = await adminState();
        const again = await setLimits('b', before.token);
        let refusal;
        try { refusal = assertSetterRefused(again); } catch (error) { throw fail(error.message, { setter: { status: again.status, body: again.text } }); }
        const after = await adminState();
        if (after.token !== before.token) throw fail('The refused setter changed the store token', { before: before.token, after: after.token });
        record('setter', { ...refusal, tokenUnchanged: true });

        // Variant (i): blocking a -> b, with the unrelated c.
        evidence.variants.i = await variant('i', null, state => {
            assertRefused(containerOf(state, refOf('b'), keys.b), 'Agent b');
            assertBlockedBy(containerOf(state, refOf('a'), keys.a), keys.b, 'Agent a');
            assertReady(containerOf(state, refOf('c'), keys.c), 'Agent c');
            assertReady(containerOf(state, refOf('x'), keys.x), 'Agent x');
        }, { inactive: [['b', keys.b], ['a', keys.a]], active: [['c', keys.c], ['x', keys.x]] },
        { running: [['c', keys.c], ['x', keys.x]], notRunning: [['b', keys.b], ['a', keys.a]] });

        // Variant (ii): b becomes an optional no-wait child of a.
        evidence.variants.ii = await variant('ii', () => editManifest('availability-manifest-enable-ii', 'a', manifest => withEnable(manifest, MANIFEST_ENABLE.ii(FIXTURE_REPOSITORY))), state => {
            assertRefused(containerOf(state, refOf('b'), keys.b), 'Agent b');
            assertReady(containerOf(state, refOf('a'), keys.a), 'Agent a');
            assertReady(containerOf(state, refOf('c'), keys.c), 'Agent c');
            assertReady(containerOf(state, refOf('x'), keys.x), 'Agent x');
        }, { inactive: [['b', keys.b]], active: [['a', keys.a], ['c', keys.c], ['x', keys.x]] },
        { running: [['a', keys.a], ['c', keys.c], ['x', keys.x]], notRunning: [['b', keys.b]] });

        // Variant (iv): x is dropped from a's enable and refused itself: an enabled extra of the registry, outside the graph.
        evidence.variants.iv = await variant('iv', () => {
            const dropped = editManifest('availability-manifest-enable-iv', 'a', manifest => withEnable(manifest, MANIFEST_ENABLE.iv(FIXTURE_REPOSITORY)));
            return { enable: dropped, extra: editManifest('availability-manifest-d4', 'x', d4Manifest) };
        }, state => {
            assertRefused(containerOf(state, refOf('x'), keys.x), 'The extra x');
            assertRefused(containerOf(state, refOf('b'), keys.b), 'Agent b');
            assertReady(containerOf(state, refOf('a'), keys.a), 'Agent a');
            assertReady(containerOf(state, refOf('c'), keys.c), 'Agent c');
        }, { inactive: [['x', keys.x], ['b', keys.b]], active: [['a', keys.a], ['c', keys.c]] },
        { running: [['a', keys.a], ['c', keys.c]], notRunning: [['x', keys.x], ['b', keys.b]] });

        // No delegated host controller changed over the whole case.
        const final = await adminState();
        evidence.controllersAtEnd = assertControllersUnchanged(controllers, controllersOf(final));
        safeArtifact('availability-controllers', { before: controllers, after: controllersOf(final) });

        // Variant (iii) cannot be produced by this product revision: the case is blocked with every other variant proven, never passed.
        evidence.variants.iii = { status: 'infeasible', evidence: VARIANT_III_EVIDENCE };
        safeArtifact('availability-variant-iii', evidence.variants.iii);
        throw Object.assign(blocked('LIVE-C3 variants i, ii and iv and the setter refusal passed; variant iii (an independently explicit status waiter) has no live producer in this product revision, so the case is not passed (N-5)'), { evidence });
    }

    // One variant: an optional manifest edit, a whole restart that must exit 0, the settled graph, the exact routes, the nested engine.
    async function variant(name, edit, check, routes, nestedExpectation) {
        const edited = edit ? edit() : null;
        if (edited) safeArtifact(`availability-edit-${name}`, edited);
        const restarted = await restartWhole(name);
        const settled = await settle(`variant ${name}`, check);
        const routing = readRouting();
        let routeFacts;
        try { routeFacts = assertRoutes(routing, routes); } catch (error) { throw fail(`variant ${name}: ${error.message}`, { restarted }); }
        let engineFacts;
        try { engineFacts = assertNestedStates(await nestedStates(name), nestedExpectation); } catch (error) { throw fail(`variant ${name}: ${error.message}`, { restarted }); }
        const containers = {};
        for (const [label, key] of [...(routes.inactive || []), ...(routes.active || [])]) {
            const found = (settled.state.agents || []).flatMap(agent => agent.containers || []).find(container => container.key === key);
            containers[label] = { availability: found?.availability ?? null, reasonCode: found?.problem?.reasonCode ?? null, blockedBy: found?.problem?.blockedBy?.key ?? null };
        }
        const facts = { restarted, polls: settled.polls, settledMs: settled.ms, containers, routes: routeFacts, engine: engineFacts };
        safeArtifact(`availability-variant-${name}`, facts);
        return facts;
    }

    // =========================================================================
    async function liveC3V() {
        if (!profile.agents.some(agent => agent.role === 's')) throw blocked('LIVE-C3V requires the owned static fixture agent');
        await inspectBox();
        assertRepositoryIsAsRecorded('at the start');
        const key = keyOf('s'); const ref = refOf('s');
        const evidence = { agent: key, ports: { tcp: run.ports.tcp, udp: run.ports.udp } };
        const record = (name, value) => { evidence[name] = value; safeArtifact(`router-controls-${name}`, value); };

        const baseline = await settle('baseline', state => assertReady(containerOf(state, ref, key), 'The static fixture'));
        let token = baseline.state.token;
        const saved = await setLimits('s', token);
        if (saved.status !== 200 || saved.body?.ok !== true || saved.body.committed !== true) throw fail(`A valid RAM override of the static fixture was not saved (HTTP ${saved.status})`, { status: saved.status, body: saved.text });
        token = saved.body.token;
        record('baseline', { polls: baseline.polls, stored: { ...STORED_OVERRIDE } });

        // The static agent itself becomes the blocked fixture: only its manifest changes, then the whole restart.
        record('manifest', editManifest('availability-manifest-d4', 's', d4Manifest));
        record('restart', await restartWhole('router-controls'));
        const settled = await settle('the static fixture is refused', state => assertRefused(containerOf(state, ref, key), 'The static fixture'));
        record('refused', { polls: settled.polls, settledMs: settled.ms });

        // The application route is terminal; the Router's own controls stay available.
        const staticReply = await http({ port: run.ports.tcp, path: '/' });
        let terminal;
        try { terminal = assertStaticTerminal(staticReply); } catch (error) { throw fail(error.message, { static: { status: staticReply?.status ?? null, contentType: staticReply?.contentType ?? null, body: String(staticReply?.body ?? '').slice(0, 300), error: staticReply?.error ?? null } }); }
        record('static-route', terminal);
        const login = await http({ port: run.ports.tcp, path: '/auth/login', headers: { accept: 'text/html' } });
        try { record('auth-login', assertRouterControl('/auth/login', login)); } catch (error) { throw fail(error.message, { login: { status: login?.status ?? null, contentType: login?.contentType ?? null, error: login?.error ?? null } }); }
        const adminReply = await adminCall('availability-admin-get', 'GET');
        try { record('admin-api', assertAdminListsRefused(adminReply, { ref, key })); } catch (error) { throw fail(error.message, { admin: { status: adminReply.status, body: adminReply.text.slice(0, 300) } }); }
        const status = await command('availability-limits-status', profile.node.path, [profile.candidate.path, 'limits', 'status'], { deadlineMs: 120000, tolerate: true, capture: 'availability-limits-status' });
        record('limits-status', assertExitZero('The host `ploinky limits status`', status));
        const clear = await command('availability-limits-clear', profile.node.path, [profile.candidate.path, 'limits', 'clear', '--agent', ref], { deadlineMs: 120000, tolerate: true, capture: 'availability-limits-clear' });
        record('limits-clear', assertExitZero('The host `ploinky limits clear --agent`', clear));
        const cleared = await adminState();
        if ((cleared.agents.find(agent => agent.ref === ref)?.configured?.memoryPercent) !== undefined) throw fail('The host clear left the stored override');
        record('cleared', { token: cleared.token });
        return evidence;
    }

    return { liveC3, liveC3V, internals: { adminCall, editManifest, assertRepositoryIsAsRecorded, keyOf, settle } };
}
