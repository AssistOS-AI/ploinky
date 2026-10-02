// Native node:test reporter for the hardware-limits verification runner.
//
// It writes one JSON record per line: a header, one record per test start,
// pass, fail or diagnostic, and a final stream-complete record carrying the
// number of records written before it. The runner decides success from these
// records plus the child's exit status, never from human-readable TAP text.
//
// Usage (the runner supplies the environment):
//   node --test --test-reporter=/abs/tests/hardware-limits/reporter.mjs \
//        --test-reporter-destination=/abs/events.jsonl files...

import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TEXT = 2048;

function bounded(value, limit = MAX_TEXT) {
    const text = String(value ?? '');
    return text.length > limit ? `${text.slice(0, limit)}...[${text.length - limit} more]` : text;
}

function relativeFile(file, root) {
    if (!file) return '';
    const resolved = String(file).startsWith('file://') ? new URL(file).pathname : String(file);
    const relative = root ? path.relative(root, resolved) : resolved;
    return relative.split(path.sep).join('/');
}

// Only exact run-owned source/HOME/TMPDIR prefixes are normalized. Relative
// filenames, fixture names, numeric values and diagnostic wording remain part
// of the proof. Stack traces are omitted because source line/column locations
// change independently of the failure cause. No other message text is erased.
function normalizeDiagnosticText(value, { root, home, tmpdir } = {}) {
    let text = String(value);
    const prefixes = [[root, '<SOURCE>'], [home, '<HOME>'], [tmpdir, '<TMP>']]
        .filter(([prefix]) => typeof prefix === 'string' && prefix.length > 1)
        .map(([prefix, label]) => [prefix.replace(/\/+$/, ''), label])
        .sort(([left], [right]) => right.length - left.length);
    for (const [prefix, label] of prefixes) {
        text = text === prefix ? label : text.split(`${prefix}/`).join(`${label}/`);
    }
    return text;
}

export function summarizeFailure(error, locations = {}) {
    if (!error) return null;
    const cause = error.cause && typeof error.cause === 'object' ? error.cause : null;
    const failureType = bounded(error.failureType || '', 64);
    const code = bounded(error.code || cause?.code || '', 128);
    const category = bounded(`${failureType}:${cause?.name || error.name || 'Error'}:${cause?.code || error.code || ''}`, 256);
    const summary = { failureType, code, message: bounded(cause?.message || error.message || error), category, signature: null };
    let remaining = 65536;
    const seen = new Set();
    const text = (value) => {
        const normalized = normalizeDiagnosticText(value, locations);
        remaining -= Buffer.byteLength(normalized);
        if (remaining < 0) throw new Error('diagnostic bound');
        return normalized;
    };
    const canonical = (value, depth = 0) => {
        if (depth > 8) throw new Error('diagnostic depth');
        if (value === null) return ['null'];
        if (typeof value === 'boolean') return ['boolean', value];
        if (typeof value === 'string') return ['string', text(value)];
        if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
        if (typeof value === 'bigint') return ['bigint', text(String(value))];
        if (value === undefined) return ['undefined'];
        if (typeof value !== 'object' || seen.has(value)) throw new Error('unsupported diagnostic value');
        seen.add(value);
        try {
            if (!(value instanceof Error) && Object.getOwnPropertySymbols(value).length) throw new Error('unsupported diagnostic symbols');
            if (Array.isArray(value)) {
                if (Object.keys(value).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new Error('unsupported diagnostic array properties');
                if (value.length > 256) throw new Error('diagnostic array bound');
                return ['array', value.map((item) => canonical(item, depth + 1))];
            }
            if (value instanceof Error) {
                const fields = { name: value.name, message: value.message };
                const keys = new Set([...Object.keys(value), 'code', 'failureType', 'operator', 'actual', 'expected', 'cause']);
                for (const key of keys) if (key !== 'stack' && key in value) fields[key] = value[key];
                return ['error', canonical(fields, depth + 1)];
            }
            if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('unsupported diagnostic object');
            const keys = Object.keys(value).sort();
            if (keys.length > 256) throw new Error('diagnostic object bound');
            return ['object', keys.map((key) => [text(key), canonical(value[key], depth + 1)])];
        } finally { seen.delete(value); }
    };
    try {
        const diagnostic = JSON.stringify(canonical(error));
        if (Buffer.byteLength(diagnostic) > 65536) throw new Error('diagnostic bound');
        summary.signature = crypto.createHash('sha256').update(diagnostic).digest('hex');
    } catch (_) { summary.proofUnavailable = true; }
    return summary;
}

export default async function* hardwareLimitsReporter(source) {
    const runId = String(process.env.PLOINKY_HWL_RUN_ID || '');
    const childId = String(process.env.PLOINKY_HWL_CHILD_ID || '');
    const root = String(process.env.PLOINKY_HWL_TEST_ROOT || process.cwd());
    let sequence = 0;
    const stacks = new Map();
    const record = (event, fields) => {
        sequence += 1;
        return `${JSON.stringify({
            schema: 1,
            runId,
            childId,
            sequence,
            event,
            ...fields,
        })}\n`;
    };
    yield record('header', {
        file: '',
        testId: '',
        parentId: null,
        payload: { node: process.version, pid: process.pid },
    });
    for await (const { type, data } of source) {
        if (type !== 'test:start' && type !== 'test:pass' && type !== 'test:fail'
            && type !== 'test:diagnostic') {
            continue;
        }
        const file = relativeFile(data?.file, root);
        if (type === 'test:diagnostic') {
            yield record('diagnostic', {
                file,
                testId: '',
                parentId: null,
                payload: { message: bounded(data?.message) },
            });
            continue;
        }
        const nesting = Number.isSafeInteger(data?.nesting) ? data.nesting : 0;
        const name = bounded(data?.name, 1024);
        const stack = stacks.get(file) || [];
        if (type === 'test:start') {
            stack.length = nesting;
            stack[nesting] = name;
            stacks.set(file, stack);
        }
        const parentName = nesting > 0 ? stack[nesting - 1] || null : null;
        const testId = `${file}::${name}`;
        const parentId = parentName === null ? null : `${file}::${parentName}`;
        if (type === 'test:start') {
            yield record('start', { file, testId, parentId, payload: { name, nesting } });
            continue;
        }
        const details = data?.details || {};
        const kind = details.type === 'suite' ? 'suite' : 'test';
        let event = type === 'test:pass' ? 'pass' : 'fail';
        if (data?.skip !== undefined && data.skip !== false) event = 'skip';
        else if (data?.todo !== undefined && data.todo !== false) event = 'todo';
        yield record(event, {
            file,
            testId,
            parentId,
            payload: {
                name,
                nesting,
                kind,
                durationMs: Number(details.duration_ms) || 0,
                error: event === 'fail' ? summarizeFailure(details.error, { root, home: process.env.HOME, tmpdir: process.env.TMPDIR }) : null,
            },
        });
    }
    const written = sequence;
    yield record('stream-complete', {
        file: '',
        testId: '',
        parentId: null,
        payload: { recordsBefore: written },
    });
}
