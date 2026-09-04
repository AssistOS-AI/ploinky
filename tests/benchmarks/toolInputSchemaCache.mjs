import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import { getConfiguredToolInputSchema } from '../../Agent/server/toolInputSchemaCache.mjs';

// Synthetic schema-construction microbenchmark, not an HTTP/load or leak test.
// Cold uses a new configuration identity each round; warm uses one identity.
// Both take the exact production compilation/lookup path.
const rounds = Number(process.argv[2] || 200);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 2000) {
    throw new Error('rounds must be an integer between 1 and 2000');
}
if (typeof global.gc !== 'function') throw new Error('Run node with --expose-gc');

const tools = Array.from({ length: 40 }, (_, index) => {
    const fields = {
        name: { type: 'string', description: 'Display name' },
        enabled: { type: 'boolean' },
        count: { type: 'number' },
        kind: { type: 'string', enum: ['one', 'two', 'three'] },
        labels: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { title: { type: 'string' }, active: { type: 'boolean' } } },
    };
    return {
        name: `tool-${index}`,
        inputSchema: index % 2
            ? { type: 'object', properties: fields, required: ['name'], additionalProperties: false }
            : fields,
    };
});

function sampledBytes(node) {
    return node.selfSize + (node.children || []).reduce((sum, child) => sum + sampledBytes(child), 0);
}

async function measure(mode) {
    global.gc();
    const session = new Session();
    session.connect();
    try {
        await session.post('HeapProfiler.startSampling', {
            samplingInterval: 16384,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
        });
        const sharedConfig = { tools };
        const expected = new Map();
        let distinctSchemas = 0;
        const started = performance.now();
        for (let round = 0; round < rounds; round += 1) {
            const config = mode === 'cold' ? { tools } : sharedConfig;
            for (const tool of tools) {
                const { schema } = getConfiguredToolInputSchema(config, tool);
                if (expected.get(tool) !== schema) distinctSchemas += 1;
                if (mode === 'warm' && round > 0) assert.strictEqual(schema, expected.get(tool));
                expected.set(tool, schema);
            }
        }
        const elapsedMs = performance.now() - started;
        const { profile } = await session.post('HeapProfiler.stopSampling');
        assert.equal(distinctSchemas, mode === 'cold' ? rounds * tools.length : tools.length);
        return {
            mode, rounds, tools: tools.length, lookups: rounds * tools.length, distinctSchemas,
            elapsedMs: Number(elapsedMs.toFixed(2)),
            sampledAllocationBytes: sampledBytes(profile.head),
        };
    } finally {
        session.disconnect();
    }
}

for (const mode of ['cold', 'warm']) console.log(JSON.stringify(await measure(mode)));
