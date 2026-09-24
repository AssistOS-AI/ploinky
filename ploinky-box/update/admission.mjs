import crypto from 'node:crypto';

import { PloinkyBoxError } from '../errors.mjs';

// Graph admission publishes host metadata (the active AgentLib descriptor, the
// saved graph skill scope, the saved Router binding) for a candidate graph and
// then settles the outer Box. Rollback authority is kept until settlement:
// every candidate write happens inside the error boundary, a durable journal
// records the prior value (including absence) and the value actually observed
// after each write, and recovery restores a prior value only while the current
// value is still this transaction's candidate. A newer successor value is
// preserved and reported as recovery-required. Nothing after settlement can
// trigger a restoration.

export const ADMISSION_JOURNAL_KIND = 'update-journals';
export const ADMISSION_JOURNAL_SCHEMA = 'ploinky-admission-journal';
export const ADMISSION_JOURNAL_VERSION = 1;

export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const plain = value => (value === undefined || value === null ? null : JSON.parse(JSON.stringify(value)));

function admissionError(message, code = 'PLOINKY_BOX_ADMISSION_FAILED') {
    return new PloinkyBoxError(message, { code });
}

export function admissionJournalName(identity, transactionId) {
    return `${identity.instance}.${transactionId}`;
}

/** Journals of other transactions for this workspace that never settled. */
export function listUnresolvedAdmissions(store, identity, { exclude = '' } = {}) {
    if (!store) return [];
    return store.list(ADMISSION_JOURNAL_KIND, `${identity.instance}.`)
        .filter(name => name !== exclude)
        .map((name) => {
            let journal = null;
            try { journal = store.read(ADMISSION_JOURNAL_KIND, name); } catch (_) {}
            return Object.freeze({
                name,
                operation: journal?.operation || 'unknown',
                phase: journal?.phase || 'unreadable',
                createdAt: journal?.createdAt || null,
            });
        });
}

/**
 * @param {object} options
 * @param {Array<{name: string, read: Function, write: Function, restore: Function}>} options.items
 *   Metadata adapters in write order. `read` returns a JSON value or null for
 *   absence; `restore(prior)` puts that exact prior value (or absence) back.
 * @param {Function} [options.validate] non-settling immutable-identity check,
 *   run after the snapshot and immediately before the first candidate write.
 * @param {Function} [options.settle] final validation that ends rollback authority.
 * @returns {Promise<{transactionId: string, outcome: 'settled', warnings: string[]}>}
 */
export async function runJournaledAdmission({
    identity,
    store,
    operation,
    items = [],
    source = null,
    validate = async () => undefined,
    settle = async () => undefined,
    transactionId = crypto.randomBytes(8).toString('hex'),
    now = () => new Date(),
} = {}) {
    if (!identity?.instance) throw admissionError('Graph admission requires one exact workspace identity');
    if (!store) throw admissionError('Graph admission requires a host state store for its journal');
    const name = admissionJournalName(identity, transactionId);

    // Snapshot before any admission write. A prior value that cannot be read
    // cannot be restored, so the admission stops here with nothing written.
    const entries = items.map(item => ({
        item,
        prior: plain(item.read()),
        candidate: null,
        state: 'pending',
    }));
    const journal = {
        schema: ADMISSION_JOURNAL_SCHEMA,
        version: ADMISSION_JOURNAL_VERSION,
        transactionId,
        operation: String(operation || 'admission'),
        instance: identity.instance,
        workspaceRoot: identity.workspaceRoot,
        createdAt: now().toISOString(),
        phase: 'snapshot',
        source: plain(source),
        items: [],
        recovery: null,
    };
    const persist = (phase) => {
        journal.phase = phase;
        journal.items = entries.map(entry => ({
            name: entry.item.name,
            prior: entry.prior,
            candidate: entry.candidate,
            state: entry.state,
        }));
        store.write(ADMISSION_JOURNAL_KIND, name, journal);
    };

    await validate();
    persist('admitting');
    try {
        for (const entry of entries) {
            entry.state = 'writing';
            persist('admitting');
            await entry.item.write();
            entry.candidate = plain(entry.item.read());
            entry.state = 'written';
            persist('admitting');
        }
        await settle();
    } catch (error) {
        await recoverAdmission({ error, entries, persist, journal, store, name });
        throw error;
    }

    // Settled. Journal cleanup is reporting, never a reason to roll back.
    const warnings = [];
    try {
        persist('settled');
        store.remove(ADMISSION_JOURNAL_KIND, name);
    } catch (cleanupError) {
        warnings.push(`the settled admission journal ${name} could not be removed: ${cleanupError.message}`);
    }
    return Object.freeze({ transactionId, outcome: 'settled', warnings: Object.freeze(warnings) });
}

async function recoverAdmission({ error, entries, persist, journal, store, name }) {
    const results = [];
    for (const entry of [...entries].reverse()) {
        const itemName = entry.item.name;
        if (entry.state === 'pending') continue;
        let current;
        try {
            current = plain(entry.item.read());
        } catch (readError) {
            results.push({ name: itemName, outcome: 'unreadable', detail: readError.message });
            continue;
        }
        if (same(current, entry.prior)) {
            results.push({ name: itemName, outcome: 'unchanged' });
            continue;
        }
        // A write that failed part way never produced an observed candidate,
        // so its current value cannot be proven to be ours.
        if (entry.state !== 'written' || !same(current, entry.candidate)) {
            results.push({ name: itemName, outcome: 'successor-preserved' });
            continue;
        }
        try {
            await entry.item.restore(entry.prior);
            const restored = plain(entry.item.read());
            results.push(same(restored, entry.prior)
                ? { name: itemName, outcome: 'restored' }
                : { name: itemName, outcome: 'restore-unverified' });
        } catch (restoreError) {
            results.push({ name: itemName, outcome: 'restore-failed', detail: restoreError.message });
        }
    }
    const recoveryRequired = results.some(result => !['restored', 'unchanged'].includes(result.outcome));
    journal.recovery = { cause: String(error?.message || error), results };
    let journalProblem = '';
    try {
        persist(recoveryRequired ? 'recovery-required' : 'recovered');
        if (!recoveryRequired) store.remove(ADMISSION_JOURNAL_KIND, name);
    } catch (journalError) {
        journalProblem = `; the admission journal ${name} could not be updated: ${journalError.message}`;
    }
    error.admission = Object.freeze({
        outcome: recoveryRequired ? 'recovery-required' : 'recovered',
        journal: recoveryRequired ? name : null,
        results: Object.freeze(results.map(result => Object.freeze(result))),
    });
    if (recoveryRequired) {
        const described = results
            .filter(result => !['restored', 'unchanged'].includes(result.outcome))
            .map(result => `${result.name}: ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`);
        error.message = `${error.message}; admission metadata recovery required [${described.join('; ')}]; `
            + `journal ${name} was retained${journalProblem}`;
    } else if (journalProblem) {
        error.message = `${error.message}${journalProblem}`;
    }
}
