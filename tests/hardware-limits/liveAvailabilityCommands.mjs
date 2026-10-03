// LIVE-C3 and LIVE-C3V (spec 15.4 :1324, :774, :1227): hardware availability over the dependency graph and the Router's own controls.
// The fixtures, the manifest changes, the evaluators of what the product answers and the bounded HTTP probe. Test-only.
//
// The refused agent is made refused the way the spec says: a VALID stored RAM override (managed network), then ONLY its manifest is changed
// to host networking plus nestedPodman. The stored historical policy now fails D4 (reasonCode host_network_nested_podman).

import http from 'node:http';

export const C3_AGENTS = Object.freeze(['a', 'b', 'c', 'x']);       // a (root) -> b, c, x ; c unrelated ; x becomes an enabled extra
export const C3V_AGENTS = Object.freeze(['s']);                      // the static agent of the dedicated workspace IS the refused fixture
export const STORED_OVERRIDE = Object.freeze({ memoryPercent: 10 }); // a valid RAM override of the managed-network agent
export const D4_REASON_CODE = 'host_network_nested_podman';
export const UNENFORCEABLE_CODE = 'PLOINKY_HARDWARE_LIMITS_UNENFORCEABLE';
// The dedicated C3-v workspace has its own Box and a port pair distinct from every other block (18080/17882 belong to the first).
export const ROUTER_CONTROLS_PORTS = Object.freeze({ tcp: 18090, udp: 17892 });
export const RESERVED_PORTS = Object.freeze([18080, 17882]);
// The bounded wait for the graph to settle after a restart (a refusal is published asynchronously for an optional child).
export const availabilityPolling = { deadlineMs: 10 * 60 * 1000, intervalMs: 5000 };

// Variant (iii) of LIVE-C3, an independently explicit status waiter, has no live producer in this product revision: the consumer side is
// `explicitStatusWaitNodeIds` (cli/commands/workspaceUtil.js:508), which nothing assigns, and the only tracker is built without explicit waits
// (workspaceUtil.js:2872 `createGraphAvailabilityTracker(lockedStart.graph, lockedStart.admissions)`). It stays declared, never silently passed.
export const VARIANT_III_EVIDENCE = 'No manifest or scheduler path creates an explicit status wait: explicitStatusWaitNodeIds is read at cli/commands/workspaceUtil.js:508 and assigned nowhere, '
    + 'and the graph availability tracker is created without explicitWaits at cli/commands/workspaceUtil.js:2872. The offline case O.explicit-status-wait-blocked covers the pure projection.';

export const MANIFEST_ENABLE = Object.freeze({
    i: repository => [`${repository}/b`, `${repository}/c`, `${repository}/x`],
    ii: repository => [`${repository}/b no-wait`, `${repository}/c`, `${repository}/x`],
    iv: repository => [`${repository}/b no-wait`, `${repository}/c`],
});

// The manifest of the same fixture agent with host networking and nestedPodman, and nothing else changed.
export function d4Manifest(manifest) {
    return { ...manifest, network: { ...(manifest.network || {}), mode: 'host' }, containerSecurity: { ...(manifest.containerSecurity || {}), nestedPodman: true } };
}
export function withEnable(manifest, entries) { return { ...manifest, enable: [...entries] }; }
export const manifestText = manifest => `${JSON.stringify(manifest, null, 2)}\n`;

const problem = message => Object.assign(new Error(message), { availability: true });
const text = (value, max = 240) => String(value ?? '').slice(0, max);

// The administrator reply, parsed: { status, body }.
export function parseAdminReply(stdout) {
    let reply = null;
    try { reply = JSON.parse(stdout); } catch { reply = null; }
    if (!reply || typeof reply.status !== 'number') return null;
    let body = null;
    try { body = JSON.parse(reply.text); } catch { body = null; }
    return { status: reply.status, body, text: text(reply.text, 2048) };
}

// The normal setter, refused: a typed unenforceable-limit outcome with its reason and fix, nothing committed (spec :1324 "a normal attempt to set
// it again also refuses ... Normal setter returns typed unenforceable-limit reason/fix").
export function assertSetterRefused(reply) {
    if (!reply) throw problem('The setter produced no administrator reply');
    const body = reply.body;
    if (reply.status !== 422 || !body || body.ok !== false) throw problem(`The setter was not refused (HTTP ${reply.status}${body?.committed === true ? ', committed' : ''}); a limit that cannot be enforced was accepted`);
    if (body.committed === true) throw problem('The refused setter reports a committed policy');
    if (body.error !== UNENFORCEABLE_CODE) throw problem(`The setter's refusal is not the typed unenforceable-limit outcome (${text(body.error, 80)})`);
    const outcome = body.hardwareOutcome;
    if (!outcome || outcome.reasonCode !== D4_REASON_CODE || outcome.state !== 'refused') throw problem(`The setter's refusal does not name the D4 reason (${text(outcome?.reasonCode, 80)})`);
    if (typeof body.message !== 'string' || !body.message.trim() || typeof body.fix !== 'string' || !body.fix.trim()) throw problem('The setter\'s refusal carries no reason and fix');
    return Object.freeze({ error: body.error, reasonCode: outcome.reasonCode, reason: text(body.message, 400), fix: text(body.fix, 400) });
}

// One agent's exact container in the administrator state, by registry key.
export function containerOf(state, ref, key) {
    const agent = (state?.agents || []).find(entry => entry.ref === ref);
    return (agent?.containers || []).find(entry => entry.key === key) || null;
}

const refusedFacts = container => ({ availability: container?.availability ?? null, state: container?.problem?.state ?? null, reasonCode: container?.problem?.reasonCode ?? null,
    code: container?.problem?.code ?? null, fix: text(container?.problem?.fix, 200), blockedBy: container?.problem?.blockedBy?.key ?? null, rootCause: container?.problem?.rootCause?.key ?? null });

// An agent whose stored policy now fails D4: refused, with the D4 reason and a fix, and no blocker of its own.
export function assertRefused(container, label) {
    const facts = refusedFacts(container);
    if (!container) throw problem(`${label} has no container in the administrator state`);
    if (facts.availability !== 'refused' || facts.state !== 'refused') throw problem(`${label} is not refused (availability ${facts.availability}, outcome ${facts.state})`);
    if (facts.reasonCode !== D4_REASON_CODE || facts.code !== UNENFORCEABLE_CODE || !facts.fix) throw problem(`${label}'s refusal is not the typed D4 outcome with a fix (${facts.reasonCode}, ${facts.code})`);
    return facts;
}
// The consumer of a refused agent: blocked, caused by exactly that agent.
export function assertBlockedBy(container, causeKey, label) {
    const facts = refusedFacts(container);
    if (!container) throw problem(`${label} has no container in the administrator state`);
    if (facts.availability !== 'blocked' || facts.state !== 'blocked') throw problem(`${label} is not blocked (availability ${facts.availability}, outcome ${facts.state})`);
    if (facts.blockedBy !== causeKey || facts.rootCause !== causeKey) throw problem(`${label} is blocked by ${facts.blockedBy}, root cause ${facts.rootCause}, not by ${causeKey}`);
    return facts;
}
// An agent that is not refused or blocked and is ready.
export function assertReady(container, label) {
    const facts = refusedFacts(container);
    if (!container) throw problem(`${label} has no container in the administrator state`);
    if (facts.availability !== 'ready' || container.problem) throw problem(`${label} is not ready (availability ${facts.availability}${facts.state ? `, ${facts.state}` : ''})`);
    return facts;
}

// The logical route is kept and every concrete runtime target is gone (spec :1328 Edge generation); an active agent's route has no unavailable state.
export function routeFor(routing, key) {
    return Object.values(routing?.routes || {}).find(route => route?.container === key) || null;
}
export function assertRoutes(routing, { inactive = [], active = [] }) {
    const facts = {};
    for (const [label, key] of inactive) {
        const route = routeFor(routing, key);
        if (!route) throw problem(`${label} has no route in the routing source to be marked unavailable`);
        const projection = route.hardwareAvailability;
        if (!projection || projection.key !== key || !['refused', 'blocked'].includes(projection.state)) throw problem(`${label}'s route carries no matching unavailable state`);
        if (route.hostPort !== undefined || route.serviceTargets !== undefined) throw problem(`${label}'s route still has a runtime target`);
        facts[label] = { state: projection.state, reasonCode: projection.problem?.reasonCode ?? null };
    }
    for (const [label, key] of active) {
        const route = routeFor(routing, key);
        if (route && route.hardwareAvailability !== undefined) throw problem(`${label}'s route is marked unavailable`);
        facts[label] = { present: Boolean(route) };
    }
    return facts;
}

// The nested engine's listing (one `ID<TAB>name<TAB>state` per container): which exact agents run.
export const NESTED_STATE_FORMAT = '{{.ID}}\t{{.Names}}\t{{.State}}';
export function parseNestedStates(stdout) {
    const rows = [];
    for (const line of String(stdout || '').split('\n')) {
        if (!line.trim()) continue;
        const [id, name, state] = line.split('\t');
        if (!/^[a-f0-9]{64}$/.test(id || '') || !name || !state) throw problem('The nested listing is not parseable');
        rows.push({ id, name: name.replace(/^\//, ''), running: state === 'running' });
    }
    return rows;
}
export function assertNestedStates(rows, { running = [], notRunning = [] }) {
    const by = new Map(rows.map(row => [row.name, row]));
    for (const [label, name] of running) if (!by.get(name)?.running) throw problem(`${label} is not running in the Box's engine`);
    for (const [label, name] of notRunning) if (by.get(name)?.running) throw problem(`${label} runs although it is refused or blocked`);
    return { running: running.map(([label]) => label), notRunning: notRunning.map(([label]) => label) };
}

// The delegated controllers the Box reports are the same after the whole case: nothing here changes a host controller.
export function assertControllersUnchanged(before, after) {
    const a = JSON.stringify([...(before || [])].sort());
    const b = JSON.stringify([...(after || [])].sort());
    if (!Array.isArray(before) || !before.length || a !== b) throw problem(`The delegated controllers changed (${a} -> ${b})`);
    return [...before].sort();
}

// The Router's answers outside the application (C3-v).
export function assertStaticTerminal(reply) {
    if (!reply) throw problem('The static route did not answer');
    let body = null;
    try { body = JSON.parse(reply.body); } catch { body = null; }
    if (reply.status !== 503 || !/^application\/json\b/.test(String(reply.contentType || ''))) throw problem(`The blocked static route did not answer a terminal 503 JSON (HTTP ${reply.status}, ${text(reply.contentType, 60)})`);
    if (!body || body.error !== 'AGENT_HARDWARE_UNAVAILABLE' || !['hardware_refused', 'hardware_blocked'].includes(body.code)
        || typeof body.reason !== 'string' || !body.reason.trim() || typeof body.fix !== 'string' || !body.fix.trim()) throw problem('The static route\'s answer is not the terminal unavailable response with its reason and fix');
    return Object.freeze({ status: reply.status, error: body.error, code: body.code, state: text(body.state, 20) });
}
export function assertRouterControl(name, reply, { status = 200 } = {}) {
    if (!reply) throw problem(`${name} did not answer`);
    if (reply.status !== status) throw problem(`${name} answered HTTP ${reply.status}, not ${status}`);
    return Object.freeze({ status: reply.status });
}
export function assertAdminListsRefused(reply, { ref, key }) {
    assertRouterControl('The administrator API', reply);
    const container = containerOf(reply.body, ref, key);
    if (!reply.body?.ok || !container || container.availability !== 'refused') throw problem('The administrator API does not show the blocked static fixture as refused');
    return Object.freeze({ status: reply.status, availability: container.availability });
}
export function assertExitZero(name, result) {
    if (!result || result.status !== 0 || result.timedOut || result.signal) throw problem(`${name} did not exit 0 (status ${result?.status}, signal ${result?.signal ?? null})`);
    return Object.freeze({ status: 0 });
}

// A bounded HTTP request to the Router's published port from the host, as a browser's address would reach it. Evidence only.
export function httpProbe({ port, path: requestPath, headers = {}, deadlineMs = 15000, maxBytes = 65536 }) {
    return new Promise(resolve => {
        const request = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET', headers: { host: `127.0.0.1:${port}`, accept: 'application/json', ...headers } }, response => {
            const chunks = []; let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size > maxBytes) { request.destroy(); resolve({ status: response.statusCode, contentType: String(response.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8'), truncated: true }); return; } chunks.push(chunk); });
            response.on('end', () => resolve({ status: response.statusCode, contentType: String(response.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8'), truncated: false }));
            response.on('error', error => resolve({ status: null, error: String(error.code || error.message).slice(0, 80) }));
        });
        request.setTimeout(deadlineMs, () => request.destroy(new Error('timeout')));
        request.on('error', error => resolve({ status: null, error: String(error.code || error.message).slice(0, 80) }));
        request.end();
    });
}
