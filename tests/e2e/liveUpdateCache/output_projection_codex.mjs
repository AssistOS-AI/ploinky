import { TextDecoder } from 'node:util';

const REASONS = new Set(['admitted-record', 'registry-bind', 'container-mount', 'rebuild-request',
    'build-writer-unproven', 'build-receipt-unowned', 'unknown-entry', 'unpublished-unproven',
    'receipt-writer-unproven', 'seed-index', 'reader:service', 'reader:attachment',
    'reader:seed-copy', 'reader:candidate', 'reader:unknown']);

export function createGcOutputProjection({ maxBytes = 16 * 1024 * 1024, maxLineBytes = 64 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024
        || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > 64 * 1024) {
        throw new Error('gc-output-limits-invalid');
    }
    const decoder = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const channels = new Map(['stdout', 'stderr'].map(name => [name, { name, decoder: decoder(), pending: '', undecoded: 0, ended: false }]));
    let bytes = 0, discardedLines = 0, failure = null, summary = null;
    const fail = code => { failure ??= code; for (const value of channels.values()) {
        value.pending = ''; value.undecoded = 0; value.decoder = decoder();
    } };
    function line(source, value) {
        if (failure) return;
        const prefix = /^(?:\[DEBUG\] )?\[deps-gc\] (.*)$/.exec(value.replace(/\r$/, ''));
        if (!prefix) { discardedLines += 1; return; }
        if (source !== 'stdout') return fail('gc-summary-source-invalid');
        if (summary) return fail('gc-summary-duplicate');
        if (prefix[1].startsWith('skipped (') && prefix[1].endsWith(')')) {
            summary = Object.freeze({ outcome: 'skipped' });
            return;
        }
        const matched = /^removed (\d+) object\(s\); retained bytes by reason (\{.*\})$/.exec(prefix[1]);
        if (!matched) return fail('gc-summary-invalid');
        const removedCount = Number(matched[1]);
        if (!Number.isSafeInteger(removedCount) || removedCount < 0) return fail('gc-summary-invalid');
        const retainedBytesByReason = {};
        const seen = new Set(), fields = matched[2].slice(1, -1).trim();
        for (const field of fields ? fields.split(',') : []) {
            const parsed = /^[ \t]*"([A-Za-z:_-]+)"[ \t]*:[ \t]*(0|[1-9]\d*)[ \t]*$/.exec(field);
            if (!parsed) return fail('gc-summary-invalid');
            const key = parsed[1], value = Number(parsed[2]);
            if (!REASONS.has(key) || !Number.isSafeInteger(value)) return fail('gc-summary-unknown-field');
            if (seen.has(key)) return fail('gc-summary-duplicate-field');
            seen.add(key);
            retainedBytesByReason[key] = value;
        }
        summary = Object.freeze({ outcome: 'collected', removedCount, retainedBytesByReason: Object.freeze(retainedBytesByReason) });
    }
    function text(channel, value) {
        channel.pending += value;
        let index;
        while (!failure && (index = channel.pending.indexOf('\n')) >= 0) {
            const complete = channel.pending.slice(0, index);
            channel.pending = channel.pending.slice(index + 1);
            if (Buffer.byteLength(complete) > maxLineBytes) return fail('gc-output-line-limit');
            line(channel.name, complete);
        }
        if (!failure && Buffer.byteLength(channel.pending) + channel.undecoded > maxLineBytes) fail('gc-output-line-limit');
    }
    return Object.freeze({
        push(source, chunk) {
            const channel = channels.get(source);
            if (!channel || channel.ended || (!Buffer.isBuffer(chunk) && typeof chunk !== 'string')) {
                fail('gc-output-channel-invalid'); return false;
            }
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + buffer.length);
            if (bytes > maxBytes) fail('gc-output-byte-limit');
            if (!failure) {
                try {
                    const decoded = channel.decoder.decode(buffer, { stream: true });
                    channel.undecoded += buffer.length - Buffer.byteLength(decoded);
                    text(channel, decoded);
                } catch { fail('gc-output-utf8-invalid'); }
            }
            return !failure;
        },
        end(source) {
            const channel = channels.get(source);
            if (!channel || channel.ended) { fail('gc-output-channel-invalid'); return false; }
            channel.ended = true;
            if (!failure) {
                try {
                    const decoded = channel.decoder.decode();
                    channel.undecoded -= Buffer.byteLength(decoded);
                    text(channel, decoded);
                    if (!failure && channel.pending) line(channel.name, channel.pending);
                } catch { fail('gc-output-utf8-invalid'); }
            }
            channel.pending = '';
            return !failure;
        },
        snapshot() {
            const closed = [...channels.values()].every(channel => channel.ended);
            return Object.freeze({ bytes, discardedLines, failure: failure || (closed && !summary ? 'gc-summary-missing' : null),
                closed, summary: failure ? null : summary });
        },
    });
}
