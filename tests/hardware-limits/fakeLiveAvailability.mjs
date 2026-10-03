// An offline model of the product's hardware availability, layered over the fake engine world (fakeLiveEngine.mjs), for the LIVE-C3 and LIVE-C3V
// tests. It reads the REAL fixture manifests in the (temporary) workspace and derives what the product would answer, so an executor that edits the
// wrong file, or in the wrong way, changes the model. It stands for: the Router's administrator route (state, set_agent_limits), the candidate's
// `restart`, `limits status` and `limits clear`, the Router's HTTP answers and the nested engine's listing. Nothing here starts a container.
//
// What it models, from the code read at this revision:
//   - an agent is refused when a stored override exists for it and its manifest is host network plus nestedPodman (D4);
//   - an agent is blocked when a BLOCKING child is refused or blocked; an optional `no-wait` child never blocks its parent;
//   - an agent in the registry but outside the root's closure is an enabled extra, refused on its own;
//   - a refused or blocked route keeps its logical entry with `hardwareAvailability` and loses every runtime target.
// Faults (all default off): setterAccepts (the setter commits instead of refusing), restartStatus, settleAfterPolls, omitBlocked, blockedByWrong,
// routeKeepsTarget, loginStatus, staticAnswer, adminStatus, dropRoute, nestedKeepsRunning, controllersChange, optionalBlocks, extraDropped,
// omitRefusal, adminListEmpty, setterNotCommitted, refusalBumpsToken, clearKeepsOverride, limitsStatusExit, limitsClearExit, notReadyAtStart (a name), notReady ({ name, from }: not ready from that restart on).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_REQUEST } from './liveGpuCommands.mjs';
import { FIXTURE_REPOSITORY, fixtureContainerName } from './liveFixture.mjs';
import { D4_REASON_CODE, NESTED_STATE_FORMAT, UNENFORCEABLE_CODE } from './liveAvailabilityCommands.mjs';

const ok = (stdout, extra = {}) => ({ status: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false, cancelled: false, errorCode: null, settlementForced: false, ...extra });
const hex = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const D4_FIX = 'Use managed networking, remove nestedPodman capability, or remove the requested limit at its source.';
const D4_REASON = 'This release cannot enforce this hardware limit for host networking with nestedPodman.';

export function createFakeAvailability({ base, workspace, root, faults = {} }) {
    const repositoryDirectory = path.join(workspace, '.ploinky', 'repos', FIXTURE_REPOSITORY);
    const routingFile = path.join(workspace, '.ploinky', 'routing.json');
    const model = { token: 1, overrides: new Map(), restarts: 0, calls: [], programs: [], controllers: ['cpu', 'memory', 'pids'], snapshots: [], registry: null, status: new Map(), pendingPolls: 0, httpCalls: [] };
    const manifestOf = name => JSON.parse(fs.readFileSync(path.join(repositoryDirectory, name, 'manifest.json'), 'utf8'));
    const names = () => fs.readdirSync(repositoryDirectory).filter(name => fs.existsSync(path.join(repositoryDirectory, name, 'manifest.json'))).sort();
    const keyOf = name => fixtureContainerName(workspace, name);
    const refOf = name => `${FIXTURE_REPOSITORY}/${name}`;
    const isD4 = name => { const manifest = manifestOf(name); return manifest.network?.mode === 'host' && manifest.containerSecurity?.nestedPodman === true; };
    const rootName = () => root;
    const enableOf = name => (manifestOf(name).enable || []).map(entry => {
        const tokens = String(entry).trim().split(/\s+/).filter(token => token.toLowerCase() !== 'no-wait');
        return { name: tokens[0].split('/').at(-1), noWait: /(^|\s)no-wait(\s|$)/i.test(entry) };
    });

    // The graph from the root, the registry (everything that was ever started) and what each agent's state is.
    function evaluate() {
        if (!model.registry) model.registry = new Set(names());
        const closure = new Set();
        const visit = name => { if (closure.has(name) || !fs.existsSync(path.join(repositoryDirectory, name))) return; closure.add(name); for (const child of enableOf(name)) visit(child.name); };
        visit(rootName());
        if (faults.extraDropped) for (const name of [...model.registry]) if (!closure.has(name)) model.registry.delete(name);
        const refused = new Set([...model.registry].filter(name => !faults.omitRefusal && model.overrides.has(refOf(name)) && fs.existsSync(path.join(repositoryDirectory, name)) && isD4(name)));
        const blockedBy = new Map();
        const settle = name => {
            for (const child of enableOf(name)) {
                if (child.noWait && !faults.optionalBlocks) continue;
                settle(child.name);
                if (refused.has(child.name)) blockedBy.set(name, blockedBy.get(name) || child.name);
                else if (blockedBy.has(child.name)) blockedBy.set(name, blockedBy.get(name) || child.name);
            }
        };
        const order = [];
        const walk = (name, seen = new Set()) => { if (seen.has(name)) return; seen.add(name); for (const child of enableOf(name)) walk(child.name, seen); order.push(name); };
        walk(rootName());
        for (const name of order) settle(name);
        const status = new Map();
        for (const name of model.registry) {
            const root = blockedBy.get(name);
            if (refused.has(name)) status.set(name, { availability: 'refused', problem: refusalProblem(name) });
            else if (root && !faults.omitBlocked) status.set(name, { availability: 'blocked', problem: blockedProblem(name, faults.blockedByWrong ? name : rootOf(root, blockedBy)) });
            else status.set(name, { availability: 'ready', problem: null });
        }
        return { status, closure };
    }
    const rootOf = (name, blockedBy) => { let current = name; while (blockedBy.has(current)) current = blockedBy.get(current); return current; };
    const refusalProblem = name => ({
        state: 'refused', code: UNENFORCEABLE_CODE, reasonCode: D4_REASON_CODE, key: keyOf(name), ref: refOf(name), reason: D4_REASON, fix: D4_FIX,
        requested: [{ field: 'memory', value: '10%', source: 'settings' }],
    });
    const blockedProblem = (name, rootName_) => ({
        state: 'blocked', code: 'PLOINKY_HARDWARE_LIMITS_DEPENDENCY_BLOCKED', reasonCode: 'dependency_blocked', key: keyOf(name), ref: refOf(name),
        reason: `Blocked by ${refOf(rootName_)}`, fix: D4_FIX, blockedBy: { key: keyOf(rootName_) }, rootCause: { key: keyOf(rootName_), ref: refOf(rootName_), field: 'memory', reason: D4_REASON, fix: D4_FIX },
    });

    function publishRouting() {
        const routes = {};
        let port = 41000;
        for (const [name, entry] of model.status) {
            if (faults.dropRoute === name) continue;
            const key = keyOf(name);
            if (entry.availability === 'ready' || faults.routeKeepsTarget === name) routes[name] = { container: key, hostPort: port += 1, ...(entry.availability === 'ready' ? {} : { hardwareAvailability: projection(name, entry) }) };
            else routes[name] = { container: key, hardwareAvailability: projection(name, entry) };
        }
        fs.mkdirSync(path.dirname(routingFile), { recursive: true });
        fs.writeFileSync(routingFile, JSON.stringify({ routes }, null, 2));
    }
    const projection = (name, entry) => ({ schema: 1, inputFingerprint: hex(`fp-${name}`), key: keyOf(name), instanceId: hex(`i-${name}`).slice(0, 16), enableGeneration: hex(`g-${model.restarts}`).slice(0, 16), state: entry.availability, problem: entry.problem, observedAt: '2026-10-03T00:00:00.000Z' });
    function ensure() { if (!model.registry) { model.registry = new Set(names()); model.status = evaluate().status; publishRouting(); } }

    function adminState() {
        ensure();
        // `settleAfterPolls`: after a restart the first reads still show the previous graph (the product publishes a refusal asynchronously).
        const shown = model.pendingPolls > 0 ? model.previous : model.status;
        const notReady = name => (faults.notReadyAtStart === name && model.restarts === 0) || (faults.notReady?.name === name && model.restarts >= faults.notReady.from);
        const agents = [...model.registry].sort().map(name => ({
            ref: refOf(name), configured: model.overrides.get(refOf(name)) || {},
            containers: [{ key: keyOf(name), availability: notReady(name) ? 'starting' : (shown.get(name)?.availability ?? 'ready'), problem: notReady(name) ? null : (shown.get(name)?.problem ?? null), limitsState: 'applied' }],
        }));
        const controllers = faults.controllersChange && model.restarts >= 2 ? ['cpu', 'memory'] : model.controllers;
        return { ok: true, token: `t-${model.token}`, gate: { state: 'on', prepared: true, backendReady: true, controllers }, agents };
    }
    function admin(method, bodyText) {
        model.programs.push({ program: 'admin', method, body: bodyText });
        if (faults.adminStatus) return { status: faults.adminStatus, text: JSON.stringify({ ok: false, error: 'store_unreadable' }) };
        if (method === 'GET') {
            if (faults.adminListEmpty && model.httpCalls.length >= 2) return { status: 200, text: JSON.stringify({ ...adminState(), agents: [] }) };
            if (model.pendingPolls > 0) { const state = adminState(); model.pendingPolls -= 1; return { status: 200, text: JSON.stringify(state) }; }
            return { status: 200, text: JSON.stringify(adminState()) };
        }
        const body = JSON.parse(bodyText);
        if (body.action !== 'set_agent_limits') return { status: 400, text: JSON.stringify({ ok: false, error: 'unknown_action' }) };
        if (body.expectedToken !== `t-${model.token}`) return { status: 409, text: JSON.stringify({ ok: false, error: 'revision_conflict' }) };
        const name = String(body.agentRef).split('/').at(-1);
        ensure();
        if (!model.registry.has(name)) return { status: 404, text: JSON.stringify({ ok: false, error: 'unknown_agent' }) };
        if (isD4(name) && !faults.setterAccepts) {
            if (faults.refusalBumpsToken) model.token += 1;
            return { status: 422, text: JSON.stringify({ ok: false, error: UNENFORCEABLE_CODE, message: D4_REASON, fix: D4_FIX, hardwareOutcome: refusalProblem(name) }) };
        }
        model.overrides.set(body.agentRef, body.limits);
        model.token += 1;
        return { status: 200, text: JSON.stringify({ ...adminState(), committed: faults.setterNotCommitted ? false : true, token: `t-${model.token}` }) };
    }

    function restart() {
        ensure();
        model.previous = model.status;
        model.status = evaluate().status;
        model.restarts += 1;
        model.snapshots.push(Object.fromEntries(names().map(name => [name, manifestOf(name)])));
        model.pendingPolls = faults.settleAfterPolls || 0;
        publishRouting();
    }
    function nestedPs() {
        ensure();
        const rows = [...model.registry].sort().map(name => {
            const running = (model.status.get(name)?.availability === 'ready') || faults.nestedKeepsRunning === name;
            return `${hex(`id-${name}`)}\t/${keyOf(name)}\t${running ? 'running' : 'exited'}\n`;
        });
        return rows.join('');
    }

    async function provider(binary, args, options = {}) {
        model.calls.push({ binary, args, cwd: options.cwd });
        // The Router administrator route, through the Box's exec.
        if (args.includes(ADMIN_REQUEST)) {
            const at = args.indexOf(ADMIN_REQUEST);
            return ok(JSON.stringify(admin(args[at + 1], args[at + 2])));
        }
        if (args.includes('--cgroup-manager=cgroupfs') && args.includes('ps') && args.includes(NESTED_STATE_FORMAT)) return ok(nestedPs());
        // The candidate's own CLI beyond start and destroy: restart, limits status, limits clear.
        if (binary === base.node && args[0] !== undefined && /ploinky-box\.mjs$/.test(args[0]) && ['restart', 'limits'].includes(args[1])) {
            if (args[1] === 'restart') {
                if (faults.restartStatus) return ok('', { status: faults.restartStatus, stderr: 'restart failed\n' });
                restart();
                return ok('The workspace graph restarted with hardware-limit refusals: see the degraded summary.\n');
            }
            if (args[2] === 'status') return faults.limitsStatusExit ? ok('', { status: faults.limitsStatusExit }) : ok('Hardware limits: on\n');
            if (args[2] === 'clear') {
                if (faults.limitsClearExit) return ok('', { status: faults.limitsClearExit });
                const ref = args[args.indexOf('--agent') + 1];
                if (!faults.clearKeepsOverride && model.overrides.delete(ref)) model.token += 1;
                return ok('cleared\n');
            }
        }
        return base.provider(binary, args, options);
    }

    // The Router's HTTP answers as the host sees them (the executor's `http` seam).
    async function http({ port, path: requestPath, headers = {} }) {
        ensure();
        model.httpCalls.push({ port, path: requestPath, headers });
        if (requestPath === '/auth/login') return { status: faults.loginStatus ?? 200, contentType: 'text/html', body: '<html>login</html>', truncated: false };
        if (requestPath === '/') {
            const entry = model.status.get(rootName());
            if (faults.staticAnswer === 'startup-page') return { status: 200, contentType: 'text/html', body: '<html>Starting...</html>', truncated: false };
            if (faults.staticAnswer === 'unreachable') return { status: null, error: 'ECONNREFUSED' };
            if (entry?.availability === 'refused' || entry?.availability === 'blocked') {
                return { status: 503, contentType: 'application/json; charset=utf-8', truncated: false, body: JSON.stringify({ error: 'AGENT_HARDWARE_UNAVAILABLE', state: entry.availability, code: entry.availability === 'refused' ? 'hardware_refused' : 'hardware_blocked', reason: D4_REASON, fix: D4_FIX }) };
            }
            return { status: 200, contentType: 'text/html', body: '<html>static</html>', truncated: false };
        }
        return { status: 404, contentType: 'application/json', body: '{}', truncated: false };
    }
    return { provider, http, model, evaluate };
}
