import http from 'node:http';
import { parseArgs } from 'node:util';

import { captureEdgeRoutingLease } from '../sandbox/edgeGeneration.js';
import { CACHE_OPERATOR_HEADER, CACHE_OPERATOR_PATH, signCacheOperatorRequest } from './cacheOperatorAssertion.js';

const OPTIONS = new Map([
    ['purge-config', ['host', 'zone', 'secret']],
    ['clear', ['host']],
    ['hold', ['agent']],
    ['release', ['agent']],
]);

function parseCacheCommand([op, ...args]) {
    const names = OPTIONS.get(op);
    if (!names) throw new Error('Usage: cache purge-config | clear | hold | release');
    try {
        const options = Object.fromEntries(names.map(name => [name, { type: 'string', multiple: true }]));
        const { values } = parseArgs({ args, options, allowPositionals: false, strict: true });
        if (!names.every(name => values[name]?.length === 1 && values[name][0].trim())) throw new Error();
        return { op, ...Object.fromEntries(names.map(name => [name, values[name][0]])) };
    } catch {
        // Invalid arguments can contain a mistakenly pasted secret.
        throw new Error(`Usage: cache ${op} ${names.map(name => `--${name} <${name}>`).join(' ')}`);
    }
}

function sendRequest(body, assertion, request) {
    return new Promise((resolve, reject) => {
        const req = request({
            host: '127.0.0.1', port: 8081, method: 'POST', path: CACHE_OPERATOR_PATH, agent: false,
            headers: { 'content-type': 'application/json', 'content-length': body.length, [CACHE_OPERATOR_HEADER]: assertion },
            signal: AbortSignal.timeout(120_000),
        }, async res => {
            try {
                if (res.statusCode !== 200) throw new Error();
                const chunks = [];
                let size = 0;
                for await (const chunk of res) {
                    size += chunk.length;
                    if (size > 256 * 1024) throw new Error();
                    chunks.push(chunk);
                }
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                res.destroy();
                reject(new Error('Private Router did not confirm the cache command.'));
            }
        });
        req.on('error', () => reject(new Error('Private Router request failed.')));
        req.end(body);
    });
}

export async function runCacheCommand(args, {
    configure = async options => (await import('../server/cdn/cachePurgeConfig.js')).configureCachePurge(options),
    captureLease = captureEdgeRoutingLease,
    request = http.request,
    report = console.log,
} = {}) {
    const input = parseCacheCommand(args);
    if (input.op === 'purge-config') {
        await configure({ host: input.host, zoneId: input.zone, secretHandle: input.secret });
        report('Cache purge configuration saved.');
        return 0;
    }
    const body = Buffer.from(JSON.stringify(input));
    const result = await sendRequest(body, signCacheOperatorRequest(body, captureLease()), request);
    const purges = input.op === 'clear' ? [result?.purge] : result?.purges;
    if (!Array.isArray(purges) || (purges.length === 0 && input.op !== 'release')
        || purges.some(p => typeof p?.host !== 'string' || !p.host || p.outcome !== 'accepted')
        || (input.op === 'clear' ? result.purge.host !== input.host : result?.success !== true)) {
        const outcomes = Array.isArray(purges) ? purges.map(p => p?.outcome)
            .filter(outcome => ['failed', 'cooldown', 'unconfigured'].includes(outcome)) : [];
        throw new Error(`Cache ${input.op} failed${outcomes.length ? `: ${outcomes.join(', ')}` : ''}.`);
    }
    if (input.op === 'release' && !purges.length) {
        report('Cache release completed. Nothing to purge.');
    } else if (input.op === 'hold' && result.probeSkipped === 'no_page_marks') {
        report('Cache hold completed. Origin probe skipped because the application has no page marks.');
    } else {
        report(`Cache ${input.op} completed.`);
    }
    return 0;
}
