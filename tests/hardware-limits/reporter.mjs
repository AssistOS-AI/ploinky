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

function errorSummary(error) {
    if (!error) return null;
    const cause = error.cause && typeof error.cause === 'object' ? error.cause : null;
    return {
        failureType: bounded(error.failureType || '', 64),
        code: bounded(error.code || cause?.code || '', 128),
        message: bounded(cause?.message || error.message || error),
    };
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
                error: event === 'fail' ? errorSummary(details.error) : null,
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
