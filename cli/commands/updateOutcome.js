import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// One result model for every `ploinky update` phase. Totals, final exit status
// and activation eligibility are derived from these records and never from
// log text. Exit status and activation are deliberately separate decisions.

export const OUTCOMES = Object.freeze(['changed', 'unchanged', 'skipped', 'deferred', 'failed', 'uncertain']);
const OUTCOME_SET = new Set(OUTCOMES);
const VERIFIED_OUTCOMES = new Set(['changed', 'unchanged']);
const ERROR_OUTCOMES = new Set(['failed', 'uncertain']);

export const UPDATE_PHASES = Object.freeze([
    'host-ploinky',
    'workspace-ploinky',
    'agentlib',
    'registered-repository',
    'workspace-repository',
    'git-pin',
    'default-skills',
    'skills-manifest',
    'marketplace',
    'activation',
    // Failures outside any phase: request rejection, lock/lease problems and
    // unexpected errors converted into a record so a report always exists.
    'command',
]);
const PHASE_SET = new Set(UPDATE_PHASES);

export const UPDATE_RESULT_SCHEMA = 'ploinky-update-result';
export const UPDATE_RESULT_VERSION = 1;

// Remove credentials from URLs and bound free text before it enters a record.
export function sanitizeReason(value, { limit = 2000 } = {}) {
    const text = String(value ?? '')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function plainEvidence(value) {
    if (value === undefined || value === null) return null;
    return JSON.parse(JSON.stringify(value));
}

/**
 * @param {object} input
 * @param {string} input.phase - one of UPDATE_PHASES
 * @param {string} input.id - stable identity within the phase (repo name, path, owner)
 * @param {string} input.outcome - one of OUTCOMES
 * @param {boolean} [input.attempted] - whether a mutation was attempted
 * @param {boolean|null} [input.required] - graph requirement; null means unknown (treated as required)
 * @param {string} [input.code] - machine-readable reason code
 * @param {string} [input.reason] - sanitized human reason
 */
export function createOperationRecord({
    phase,
    id,
    outcome,
    attempted = outcome !== 'skipped' && outcome !== 'deferred',
    required = null,
    code = '',
    reason = '',
    before = null,
    after = null,
    graphImpact = null,
    details = null,
} = {}) {
    if (!PHASE_SET.has(phase)) throw new TypeError(`Unknown update phase: ${phase}`);
    if (!OUTCOME_SET.has(outcome)) throw new TypeError(`Unknown update outcome: ${outcome}`);
    if (typeof id !== 'string' || !id) throw new TypeError('Update operation records require an identity');
    if (required !== null && typeof required !== 'boolean') throw new TypeError('required must be boolean or null');
    return Object.freeze({
        phase,
        id,
        outcome,
        attempted: Boolean(attempted),
        required,
        code: String(code || ''),
        reason: sanitizeReason(reason),
        before: plainEvidence(before),
        after: plainEvidence(after),
        graphImpact: plainEvidence(graphImpact),
        details: plainEvidence(details),
    });
}

export function summarizeOperations(records = []) {
    const totals = Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]));
    for (const record of records) totals[record.outcome] += 1;
    return { total: records.length, attempted: records.filter(record => record.attempted).length, ...totals };
}

/**
 * Decide the final exit status and activation eligibility separately.
 *
 * - Any failed/uncertain record makes the final status nonzero.
 * - A required input that is not verified (skipped, deferred, failed,
 *   uncertain) blocks activation and also makes the final status nonzero.
 * - Unknown graph membership (`required: null`) is treated as required.
 * - Optional skips/deferrals are named but do not fail the command.
 */
export function decideUpdateStatus(records = []) {
    const errors = records.filter(record => ERROR_OUTCOMES.has(record.outcome));
    const unresolvedRequired = records.filter(record => record.required !== false
        && !VERIFIED_OUTCOMES.has(record.outcome));
    const activationAllowed = unresolvedRequired.length === 0;
    const exitCode = errors.length || unresolvedRequired.length ? 1 : 0;
    let status = 'complete';
    if (exitCode) status = activationAllowed ? 'partial' : 'failed';
    else if (records.some(record => !VERIFIED_OUTCOMES.has(record.outcome))) status = 'complete-with-skips';
    return {
        status,
        exitCode,
        activationAllowed,
        blockedBy: unresolvedRequired.map(record => ({ phase: record.phase, id: record.id, outcome: record.outcome, code: record.code })),
        errors: errors.map(record => ({ phase: record.phase, id: record.id, outcome: record.outcome, code: record.code })),
    };
}

export function buildUpdateResult({ command = [], records = [], context = null, agentLib = null } = {}) {
    const decision = decideUpdateStatus(records);
    return {
        schema: UPDATE_RESULT_SCHEMA,
        version: UPDATE_RESULT_VERSION,
        command: [...command].map(String),
        context: plainEvidence(context),
        records: [...records],
        totals: summarizeOperations(records),
        ...decision,
        agentLib,
    };
}

export function isUpdateResult(value) {
    return Boolean(value && typeof value === 'object'
        && value.schema === UPDATE_RESULT_SCHEMA
        && value.version === UPDATE_RESULT_VERSION
        && Array.isArray(value.records));
}

// ---------------------------------------------------------------------------
// Control report between the in-Box core and the host.
//
// The report is a file in the shared workspace state, keyed by a host-issued
// nonce, so package/log output on stdout/stderr can never be mistaken for it.
// The nonce correlates; it does not authenticate. The host additionally
// compares the echoed context with its own expectation.

export const UPDATE_REPORT_NONCE_ENV = 'PLOINKY_UPDATE_REPORT_NONCE';
export const UPDATE_REPORT_CONTEXT_ENV = 'PLOINKY_UPDATE_REPORT_CONTEXT';
export const UPDATE_REPORT_SCHEMA = 'ploinky-update-report';
export const UPDATE_REPORT_VERSION = 1;
export const UPDATE_REPORT_MAX_BYTES = 4 * 1024 * 1024;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export function createUpdateReportNonce() {
    return crypto.randomBytes(16).toString('hex');
}

export function updateReportPath(ploinkyDir, nonce) {
    if (!NONCE_PATTERN.test(String(nonce || ''))) throw new Error('Invalid update report nonce');
    return path.join(ploinkyDir, 'running', 'update-reports', `${nonce}.json`);
}

/**
 * Publish exactly one report for `nonce`. A second publication fails because
 * the final name is created with link(2), which never replaces.
 */
export function writeUpdateReport(ploinkyDir, nonce, result, { fsApi = fs } = {}) {
    const finalPath = updateReportPath(ploinkyDir, nonce);
    const directory = path.dirname(finalPath);
    fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const envelope = {
        schema: UPDATE_REPORT_SCHEMA,
        version: UPDATE_REPORT_VERSION,
        nonce,
        result,
    };
    const body = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(body) > UPDATE_REPORT_MAX_BYTES) throw new Error('Update report exceeds its size limit');
    const temporary = path.join(directory, `.${nonce}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const fd = fsApi.openSync(temporary, 'wx', 0o600);
    try {
        fsApi.writeFileSync(fd, body);
        fsApi.fsyncSync(fd);
    } finally {
        fsApi.closeSync(fd);
    }
    try {
        fsApi.linkSync(temporary, finalPath);
    } finally {
        fsApi.rmSync(temporary, { force: true });
    }
    return finalPath;
}

function uncertainReport(code, reason) {
    return { ok: false, code, reason };
}

/**
 * Read and validate the one report for `nonce`. Any missing, oversized,
 * malformed, mismatched or unsupported report is an uncertain outcome.
 */
export function readUpdateReport(ploinkyDir, nonce, { expectedContext = null, fsApi = fs } = {}) {
    let filename;
    try {
        filename = updateReportPath(ploinkyDir, nonce);
    } catch (error) {
        return uncertainReport('report-nonce-invalid', error.message);
    }
    let info;
    try {
        info = fsApi.lstatSync(filename);
    } catch (error) {
        if (error.code === 'ENOENT') return uncertainReport('report-missing', 'The in-Box update did not publish a report');
        return uncertainReport('report-unreadable', error.message);
    }
    if (!info.isFile()) return uncertainReport('report-not-file', 'The update report is not a regular file');
    if (info.size > UPDATE_REPORT_MAX_BYTES) return uncertainReport('report-oversized', 'The update report exceeds its size limit');
    let envelope;
    try {
        const text = fsApi.readFileSync(filename, 'utf8');
        if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) {
            return uncertainReport('report-truncated', 'The update report is truncated or contains more than one envelope');
        }
        envelope = JSON.parse(text);
    } catch (error) {
        return uncertainReport('report-malformed', sanitizeReason(error.message));
    }
    if (!envelope || envelope.schema !== UPDATE_REPORT_SCHEMA || envelope.version !== UPDATE_REPORT_VERSION) {
        return uncertainReport('report-unsupported', 'The update report has an unsupported schema');
    }
    if (envelope.nonce !== nonce) return uncertainReport('report-nonce-mismatch', 'The update report belongs to another transaction');
    const result = envelope.result;
    if (!isUpdateResult(result)) return uncertainReport('report-result-invalid', 'The update report does not contain an update result');
    for (const record of result.records) {
        if (!record || !PHASE_SET.has(record.phase) || !OUTCOME_SET.has(record.outcome) || typeof record.id !== 'string') {
            return uncertainReport('report-record-invalid', 'The update report contains an invalid operation record');
        }
    }
    const recomputed = decideUpdateStatus(result.records);
    if (recomputed.exitCode !== result.exitCode || recomputed.activationAllowed !== result.activationAllowed) {
        return uncertainReport('report-inconsistent', 'The update report status does not match its operation records');
    }
    if (expectedContext && JSON.stringify(result.context) !== JSON.stringify(expectedContext)) {
        return uncertainReport('report-context-mismatch', 'The update report was produced for a different workspace, scope or Box generation');
    }
    return { ok: true, filename, result };
}

export function removeUpdateReport(ploinkyDir, nonce, { fsApi = fs } = {}) {
    try {
        fsApi.rmSync(updateReportPath(ploinkyDir, nonce), { force: true });
    } catch (_) {}
}
