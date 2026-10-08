#!/usr/bin/env node
/**
 * Scoped A6 acceptance comparator (plan rev3/rev4, r2_decisions_codex.md Q1).
 *
 * The raw suite result is preserved: exit 2 / NO_FAILURES_WITH_GAPS is never a
 * full-suite PASS. This module returns a separate ACCEPT or REJECT decision
 * and every reason for a REJECT. It ACCEPTs only when the exact run satisfies
 * the reviewed policy, mandatory checks, typed gap rules, runtime set, pins and
 * offline evidence.
 *
 *   node verify-acceptance.mjs --report <report.json> --exit-code-file <raw-exit-code.json>
 *        --offline-dir <dir> --pins <pins.json> --pins-sha256 <hex>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runVerdict } from '../core.mjs';
import { routerProbes } from '../router-probes.mjs';
import { routerInventory } from '../router-inventory.mjs';
import { agentInventory } from '../agent-inventory.mjs';
import { agentDiscoveryMethods } from '../agent-probes.mjs';
import { ACCEPTANCE_DIR, policyDigest } from './digest.mjs';
import { loadPins } from './pins.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const key = (repo, agent) => `${repo}/${agent}`;

export const GAP_CATEGORIES = Object.freeze(['intentional-disabled-agent', 'optional-disabled-agent', 'external-inference-provider-git', 'optional-backend-image-owned', 'static-unsupported-protocol', 'protocol-combination-outside-changed-paths']);
export const ACCEPTABLE_GAP_KINDS = Object.freeze(['agent-disabled', 'rpc-method-unsupported', 'declared-limitation', 'negative-only-protocol', 'boundary-rejected', 'selfregistered-visible-tools']);
/** Gap identities that always fail, whatever the gap file contains. */
export const FORBIDDEN_GAP_IDS = Object.freeze([
    /\*/, /\.pagination$/, /\.unsupported$/, /\.sse$/, /:fanout$/, /^agent\.username-admin/, /^agent\.tool\./,
    /^agent\.(soul|robot)\./, /^resource\.(dpu\.idor|files-and-tasks|tasks\.idor|git\.local-fixture|webmeet\.authorization)$/,
    /^router:(workspace-file-selector-bypass|workspace-upload-selector-deny|terminal-|mcp-session-horizontal-delete)/, /^u[367]:/,
]);
const FIELDS = ['id', 'category', 'presence', 'source', 'reason', 'affectedObligations', 'outsideChangedBehavior', 'evidence', 'reviewedBy'];
const CITATION = /[A-Za-z0-9_./-]+\.(mjs|js|json|sh|md):\d+/;

/** Load-time gap file rules. Returns a list of violations (empty when valid). */
export function validateExpectedGaps(file, { policy, expectedRuntimes, routerIds = new Set(routerInventory.map(r => r.id)), inventory = agentInventory, probes = routerProbes }) {
    const errors = [];
    const err = (code, id, detail = '') => errors.push(`${code}: ${id}${detail ? ` (${detail})` : ''}`);
    if (file?.schema !== 'authz-expected-gaps/1' || !Array.isArray(file.gaps) || !file.gaps.length) return ['GAP_FILE_SCHEMA'];
    const changed = new Set(Object.values(policy.changedBoundaryRows).flat().map(id => `router/${id}`));
    const disabled = new Set(expectedRuntimes.disabled.map(a => key(a.repo, a.agent)));
    const enabled = new Map(expectedRuntimes.enabled.map(a => [a.agent, a]));
    const inventoryIds = new Set(inventory.map(r => r.id));
    const inventoryAgents = new Set(inventory.map(r => key(r.repo, r.agent)));
    const seen = new Set();
    for (const entry of file.gaps) {
        const id = String(entry?.id || '');
        for (const field of FIELDS) if (entry?.[field] === undefined || entry[field] === '' || (Array.isArray(entry[field]) && !entry[field].length)) err('GAP_FIELD_MISSING', id, field);
        if (seen.has(id)) err('GAP_DUPLICATE_ENTRY', id);
        seen.add(id);
        if (FORBIDDEN_GAP_IDS.some(pattern => pattern.test(id))) err('GAP_FORBIDDEN_ID', id);
        if (!GAP_CATEGORIES.includes(entry.category)) err('GAP_CATEGORY', id, entry.category);
        if (!CITATION.test(String(entry.source))) err('GAP_SOURCE_UNCITED', id);
        const ev = entry.evidence || {};
        if (!ACCEPTABLE_GAP_KINDS.includes(ev.kind)) err('GAP_KIND_NOT_ACCEPTABLE', id, ev.kind);
        if (!['required', 'boundary-or-denial-pass'].includes(entry.presence) || (entry.presence === 'boundary-or-denial-pass' && ev.kind !== 'boundary-rejected')) err('GAP_PRESENCE', id, entry.presence);
        for (const obligation of entry.affectedObligations || []) {
            if (changed.has(obligation)) err('GAP_COVERS_CHANGED_BOUNDARY', id, obligation);
            else if (obligation.startsWith('router/')) { if (!routerIds.has(obligation.slice(7))) err('GAP_OBLIGATION_UNKNOWN', id, obligation); }
            else if (obligation.startsWith('agent-inventory/')) {
                const ref = obligation.slice(16);
                if (!inventoryIds.has(ref) && !inventoryAgents.has(ref)) err('GAP_OBLIGATION_UNKNOWN', id, obligation);
            } else err('GAP_OBLIGATION_UNKNOWN', id, obligation);
        }
        if (ev.kind === 'agent-disabled') {
            if (id !== `agent.${ev.agent}.disabled`) err('GAP_ID_EVIDENCE', id);
            if (!disabled.has(key(ev.repo, ev.agent))) err('GAP_DISABLED_AGENT_REQUIRED', id, 'agent is not in the derived disabled set');
            const rows = inventory.filter(r => r.repo === ev.repo && r.agent === ev.agent);
            if (!rows.length || !rows.every(r => /disabled|on-demand/i.test(String(r.gap || '')))) err('GAP_OBLIGATIONS_NOT_RETAINED', id);
            if (!(entry.affectedObligations || []).includes(`agent-inventory/${ev.repo}/${ev.agent}`)) err('GAP_OBLIGATIONS_NOT_RETAINED', id, 'agent rows');
        } else if (ev.kind === 'rpc-method-unsupported') {
            const agent = String(ev.endpoint || '').replace(/^\//, '').replace(/\/mcp$/, '');
            if (!enabled.has(agent)) err('GAP_DISCOVERY_AGENT', id);
            if (!agentDiscoveryMethods.some(m => m.method === ev.requestedMethod)) err('GAP_DISCOVERY_METHOD', id);
            if (id !== `agent.${agent}.discovery.${String(ev.requestedMethod).replaceAll('/', '.')}`) err('GAP_ID_EVIDENCE', id);
            if (ev.actor !== 'admin' || ev.stage !== ev.requestedMethod || ev.initialized !== true || ev.httpStatus !== 200 || ev.rpcCode !== -32601) err('GAP_DISCOVERY_RULE', id, 'requires initialized admin session, stage == method, HTTP 200, RPC -32601');
        } else if (ev.kind === 'negative-only-protocol') {
            const probe = probes.find(p => p.id === ev.probeId);
            if (!probe || probe.positiveControl || !probe.gap) err('GAP_NEGATIVE_ONLY_PROBE', id);
            if (id !== `router:${ev.probeId}:${ev.actor}:positive-control`) err('GAP_ID_EVIDENCE', id);
        } else if (ev.kind === 'boundary-rejected') {
            const probe = probes.find(p => p.id === ev.probeId);
            const statuses = ev.httpStatuses || [];
            if (!probe?.boundaryRejectionStatuses) err('GAP_BOUNDARY_PROBE', id);
            if (!statuses.length || statuses.some(s => !policy.boundaryRejectionStatuses.includes(s) || !probe?.boundaryRejectionStatuses?.includes(s))) err('GAP_BOUNDARY_STATUS', id);
            if (id !== `router:${ev.probeId}:${ev.actor}`) err('GAP_ID_EVIDENCE', id);
        } else if (ev.kind === 'selfregistered-visible-tools') {
            const names = ev.visibleTools || [];
            if (ev.actor !== 'selfRegistered' || !names.length || JSON.stringify(names) !== JSON.stringify([...new Set(names)].sort())) err('GAP_VISIBLE_TOOLS', id);
            const agent = String(ev.endpoint || '').replace(/^\//, '').replace(/\/mcp$/, '');
            if (id !== `agent.${agent}.discovery.${String(ev.requestedMethod).replaceAll('/', '.')}.selfRegistered.scope`) err('GAP_ID_EVIDENCE', id);
        }
    }
    return errors;
}

/** Parse node --test TAP output into counts and named results. */
export function parseTap(text) {
    const lines = String(text).split('\n');
    const summary = {};
    for (const line of lines) {
        const match = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line.trim());
        if (match) summary[match[1]] = Number(match[2]);
    }
    const results = lines.map(line => /^\s*(not ok|ok) \d+ - (.*?)(\s+#\s+(SKIP|TODO)\b.*)?$/i.exec(line)).filter(Boolean)
        .map(m => ({ ok: m[1] === 'ok', name: m[2].trim(), directive: m[4] ? m[4].toUpperCase() : null }));
    return { summary, results };
}

function matchGapEvidence(entry, gap, report, checks) {
    const want = entry.evidence;
    const ev = gap.evidence || {};
    if (ev.kind !== want.kind) return `kind ${ev.kind} does not satisfy ${want.kind}`;
    const coverage = (report.routerCoverage || []).filter(row => row.probeId === want.probeId && row.actor === want.actor);
    switch (want.kind) {
        case 'agent-disabled':
            if (ev.repo !== want.repo || ev.agent !== want.agent) return 'disabled agent identity differs';
            if ((report.runtimes || []).some(r => r.repo === want.repo && r.agent === want.agent)) return 'disabled agent is running';
            return null;
        case 'rpc-method-unsupported':
            for (const field of ['actor', 'endpoint', 'requestedMethod', 'stage', 'initialized', 'httpStatus', 'rpcCode']) if (ev[field] !== want[field]) return `${field} ${JSON.stringify(ev[field])} differs from reviewed ${JSON.stringify(want[field])}`;
            return null;
        case 'declared-limitation':
            return null;
        case 'negative-only-protocol':
            if (ev.probeId !== want.probeId || ev.actor !== want.actor) return 'probe/actor differs';
            if (coverage.length !== 1 || coverage[0].status !== 'NEGATIVE_ONLY_PASSED') return 'routerCoverage is not exactly one NEGATIVE_ONLY_PASSED row';
            if (JSON.stringify(checks.get(`router:${want.probeId}:${want.actor}`)) !== JSON.stringify(['PASS'])) return 'negative-only denial check did not PASS exactly once';
            return null;
        case 'boundary-rejected':
            if (ev.probeId !== want.probeId || ev.actor !== want.actor) return 'probe/actor differs';
            if (!want.httpStatuses.includes(ev.httpStatus)) return `HTTP ${ev.httpStatus} is not a reviewed boundary status`;
            if (coverage.length !== 1 || coverage[0].status !== 'BOUNDARY_REJECTED_ONLY' || coverage[0].httpStatus !== ev.httpStatus) return 'routerCoverage is not exactly one BOUNDARY_REJECTED_ONLY row with the same status';
            if (checks.has(`router:${want.probeId}:${want.actor}`)) return 'a check was also recorded for the boundary-rejected request';
            return null;
        case 'selfregistered-visible-tools':
            for (const field of ['actor', 'endpoint', 'requestedMethod', 'stage']) if (ev[field] !== want[field]) return `${field} differs`;
            if (ev.stage !== ev.requestedMethod || ev.httpStatus !== 200) return 'stage/status';
            if (JSON.stringify(ev.visibleTools) !== JSON.stringify(want.visibleTools)) return 'visible tool names differ from the reviewed list';
            return null;
        default:
            return 'kind is never acceptable';
    }
}

export function evaluateScopedAcceptance({ report, exitCode, mandatory, expectedGaps, expectedRuntimes, policy, offline = [], pins, pinsSha256, acceptanceDigest }) {
    const reasons = [];
    const reject = (code, detail = '') => reasons.push(`${code}${detail ? `: ${detail}` : ''}`);
    if (!report || typeof report !== 'object') return { decision: 'REJECT', reasons: ['REPORT_MISSING'] };

    // Policy files: gap rules and the mandatory/gap partition.
    for (const error of validateExpectedGaps(expectedGaps, { policy, expectedRuntimes })) reject('GAP_FILE', error);
    const expected = new Map((expectedGaps.gaps || []).map(g => [g.id, g]));
    const mandatoryLive = (mandatory.checks || []).filter(c => c.kind === 'live');
    const mandatoryIds = new Set((mandatory.checks || []).map(c => c.id));
    for (const id of mandatoryIds) if (expected.has(id)) reject('MANDATORY_GAP_OVERLAP', id);
    for (const { agent } of expectedRuntimes.enabled) for (const { method } of agentDiscoveryMethods) {
        const id = `agent.${agent}.discovery.${method.replaceAll('/', '.')}`;
        if (mandatoryIds.has(`${id}.positive`) === expected.has(id)) reject('DISCOVERY_PARTITION', `${id} must be exactly one of mandatory or excluded`);
    }

    // Raw outcome and exit code (captured by the wrapper, checked against the verdict).
    const mapped = report.verdict === 'PASS' ? policy.verdictExitCodes.PASS : report.verdict === 'NO_FAILURES_WITH_GAPS' ? policy.verdictExitCodes.NO_FAILURES_WITH_GAPS : policy.verdictExitCodes.otherwise;
    if (!Number.isInteger(exitCode)) reject('EXIT_CODE_MISSING');
    else if (exitCode !== mapped) reject('EXIT_CODE_VERDICT_MISMATCH', `exit ${exitCode} vs verdict ${report.verdict}`);
    if (report.verdict !== policy.requiredRawVerdict || exitCode !== policy.requiredRawExitCode) reject('RAW_OUTCOME', `${report.verdict}/${exitCode}`);
    const checksList = Array.isArray(report.checks) ? report.checks : [];
    const recount = Object.fromEntries(['PASS', 'FAIL', 'ERROR'].map(s => [s, checksList.filter(c => c.status === s).length]));
    if (JSON.stringify(recount) !== JSON.stringify(report.counts)) reject('COUNTS_INCONSISTENT');
    if (recount.FAIL || recount.ERROR) reject('FAILURES_PRESENT', `FAIL=${recount.FAIL} ERROR=${recount.ERROR}`);
    if (checksList.some(c => !['PASS', 'FAIL', 'ERROR'].includes(c.status))) reject('CHECK_STATUS_UNKNOWN');
    try { if (runVerdict(report) !== report.verdict) reject('VERDICT_INCONSISTENT'); } catch { reject('VERDICT_INCONSISTENT'); }

    // Run health.
    if (report.setupError) reject('SETUP_ERROR');
    if (report.interrupted) reject('INTERRUPTED');
    if (!Array.isArray(report.cleanup) || !report.cleanup.length || report.cleanup.some(c => c.status !== 'PASS')) reject('CLEANUP_NOT_PASS');
    if (report.finalOwnership !== 'PASS') reject('FINAL_OWNERSHIP');
    if (report.workspaceMutationLock !== 'RELEASED') reject('LOCK_NOT_RELEASED');

    // Pins and deployment identity.
    if (!pins || report.pins?.sha256 !== pinsSha256) reject('PINS_BINDING', 'report was not produced with the reviewed pins file');
    if (pins && (report.pins?.policyDigest !== pins.policyDigest || acceptanceDigest !== pins.policyDigest)) reject('POLICY_DIGEST_BINDING');
    if (pins) {
        const d = report.deployment || {};
        if (d.boxId !== pins.box.id || d.startedAt !== pins.box.startedAt || d.image?.imageId !== pins.box.imageId) reject('DEPLOYMENT_BINDING', 'Box identity differs from pins');
        const want = pins.repositories.map(r => key(r.name, r.commit)).sort();
        const got = (d.repositories || []).map(r => key(r.name, r.commit)).sort();
        if (JSON.stringify(want) !== JSON.stringify(got)) reject('DEPLOYMENT_BINDING', 'repository commits differ from pins');
    }

    // Principals.
    const principals = Array.isArray(report.principals) ? report.principals : [];
    const names = principals.map(p => p.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(policy.principals).sort())) reject('PRINCIPALS_SET');
    for (const p of principals) {
        if (JSON.stringify(p.roles) !== JSON.stringify(policy.principals[p.name]) || p.authoritativeRoleVerified !== true) reject('PRINCIPAL_ROLE', p.name);
    }
    if (new Set(principals.map(p => p.idHash)).size !== principals.length) reject('PRINCIPALS_NOT_DISTINCT');

    // Runtime set: exact equality with the reviewed manifest-derived set.
    const expectedKeys = expectedRuntimes.enabled.map(a => key(a.repo, a.agent)).sort();
    const live = Array.isArray(report.runtimes) ? report.runtimes : [];
    const liveKeys = live.map(r => key(r.repo, r.agent));
    if (!live.length) reject('RUNTIME_SET_EMPTY');
    if (new Set(liveKeys).size !== liveKeys.length) reject('RUNTIME_SET_DUPLICATE');
    for (const k of liveKeys) if (!expectedKeys.includes(k)) reject('RUNTIME_SET_EXTRA', k);
    for (const k of expectedKeys) if (!liveKeys.includes(k)) reject('RUNTIME_SET_MISSING', k);
    for (const r of live) if (r.enabled !== true || r.running !== true) reject('RUNTIME_NOT_RUNNING', key(r.repo, r.agent));

    // Mandatory live checks: exactly `count` occurrences, all PASS, with a passing positive control.
    const checks = new Map();
    for (const c of checksList) checks.set(c.id, [...(checks.get(c.id) || []), c.status]);
    const passed = id => { const s = checks.get(id); return Array.isArray(s) && s.length > 0 && s.every(x => x === 'PASS'); };
    for (const entry of mandatoryLive) {
        const statuses = checks.get(entry.id) || [];
        if (!statuses.length) { reject('MANDATORY_MISSING', entry.id); continue; }
        if (statuses.length !== (entry.count || 1)) reject('MANDATORY_DUPLICATE', `${entry.id} x${statuses.length}`);
        if (statuses.some(s => s !== 'PASS')) reject('MANDATORY_NOT_PASS', entry.id);
        if (entry.positiveControlAnyOf && !entry.positiveControlAnyOf.some(passed)) reject('MANDATORY_POSITIVE_CONTROL_FAILED', entry.id);
    }

    // Offline mandatory tests: TAP at the pinned commit, all ok, nothing skipped.
    for (const entry of (mandatory.checks || []).filter(c => c.kind === 'offline')) {
        const evidence = offline.filter(o => o.sidecar?.repo === entry.repo && o.sidecar?.file === entry.file);
        if (evidence.length !== 1) { reject('OFFLINE_MISSING', entry.id); continue; }
        const { sidecar, tap } = evidence[0];
        const pinned = entry.repo === 'ploinky' ? pins?.ploinky?.commit : pins?.repositories?.find(r => r.name === entry.repo)?.commit;
        if (!pinned || sidecar.commit !== pinned) reject('OFFLINE_COMMIT', entry.id);
        if (sidecar.clean !== true) reject('OFFLINE_DIRTY', entry.id);
        if (sidecar.exitCode !== 0) reject('OFFLINE_EXIT', entry.id);
        if (sha256(tap) !== sidecar.tapSha256) reject('OFFLINE_TAP_HASH', entry.id);
        const { summary, results } = parseTap(tap);
        if (!(summary.pass > 0) || summary.fail !== 0 || summary.skipped !== 0 || summary.todo !== 0 || summary.cancelled !== 0 || summary.tests !== summary.pass) reject('OFFLINE_SUMMARY', `${entry.id} ${JSON.stringify(summary)}`);
        if (results.some(r => !r.ok || r.directive)) reject('OFFLINE_NOT_OK', entry.id);
        for (const name of entry.tests || []) if (!results.some(r => r.ok && !r.directive && r.name === name)) reject('OFFLINE_TEST_MISSING', `${entry.id} :: ${name}`);
    }

    // Gaps: exact identities with typed evidence; duplicates, unexpected and missing reject.
    const gaps = Array.isArray(report.gaps) ? report.gaps : [];
    const seen = new Map();
    for (const gap of gaps) seen.set(gap.id, (seen.get(gap.id) || 0) + 1);
    for (const [id, n] of seen) if (n > 1) reject('GAP_DUPLICATE', `${id} x${n}`);
    for (const gap of gaps) {
        const entry = expected.get(gap.id);
        if (!entry) { reject('GAP_UNEXPECTED', gap.id); continue; }
        const mismatch = matchGapEvidence(entry, gap, report, checks);
        if (mismatch) reject('GAP_EVIDENCE_MISMATCH', `${gap.id}: ${mismatch}`);
    }
    for (const entry of expected.values()) {
        if (seen.has(entry.id)) continue;
        if (entry.presence === 'boundary-or-denial-pass') {
            const id = `router:${entry.evidence.probeId}:${entry.evidence.actor}`;
            const row = (report.routerCoverage || []).filter(r => r.probeId === entry.evidence.probeId && r.actor === entry.evidence.actor);
            if (JSON.stringify(checks.get(id)) !== JSON.stringify(['PASS']) || row.length !== 1 || row[0].status !== 'AUTHORIZATION_DENIAL_PASSED') reject('GAP_MISSING', `${entry.id} (neither a reviewed boundary rejection nor a passing explicit denial)`);
        } else reject('GAP_MISSING', entry.id);
    }
    return { decision: reasons.length ? 'REJECT' : 'ACCEPT', reasons };
}

export function readOfflineEvidence(dir) {
    return fs.readdirSync(dir).filter(name => name.endsWith('.sidecar.json')).map(name => {
        const sidecar = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        return { sidecar, tap: fs.readFileSync(path.join(dir, sidecar.tapFile), 'utf8') };
    });
}

export function loadAcceptanceInputs(dir = ACCEPTANCE_DIR) {
    const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    return { policy: read('policy.json'), mandatory: read('mandatory-checks.json'), expectedGaps: read('expected-gaps.json'), expectedRuntimes: read('expected-runtimes.json'), acceptanceDigest: policyDigest(dir) };
}

export function verifyFromFiles({ reportFile, exitCodeFile, offlineDir, pinsFile, pinsSha256 }) {
    const { pins, sha256: pinsHash } = loadPins(pinsFile, pinsSha256);
    const raw = JSON.parse(fs.readFileSync(exitCodeFile, 'utf8'));
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    return evaluateScopedAcceptance({ report, exitCode: raw.exitCode, offline: readOfflineEvidence(offlineDir), pins, pinsSha256: pinsHash, ...loadAcceptanceInputs() });
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!/^--[a-z0-9-]+$/.test(argv[i]) || argv[i + 1] === undefined) throw new Error(`unexpected argument ${argv[i]}`);
        args[argv[i].slice(2)] = argv[i + 1];
    }
    for (const required of ['report', 'exit-code-file', 'offline-dir', 'pins', 'pins-sha256']) if (!args[required]) throw new Error(`--${required} is required`);
    return args;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const result = verifyFromFiles({ reportFile: args.report, exitCodeFile: args['exit-code-file'], offlineDir: args['offline-dir'], pinsFile: args.pins, pinsSha256: args['pins-sha256'] });
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.decision === 'ACCEPT' ? 0 : 1;
    } catch (error) {
        console.error(`REJECT: ${error?.message || error}`);
        process.exitCode = 1;
    }
}
