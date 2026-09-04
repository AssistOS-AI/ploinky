import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfiguredToolInputSchema } from '../../Agent/server/toolInputSchemaCache.mjs';

const legacySpec = {
    name: { type: 'string', enum: ['alice', 'bob'] },
    count: { type: 'number', min: 0, max: 2, optional: true },
    nested: { type: 'object', properties: { flag: 'boolean' } },
    labels: { type: 'string', isArray: true, maxItems: 2, optional: true },
    metadata: { type: 'object', additionalProperties: true, optional: true },
    nullable: { type: 'boolean', nullable: true, optional: true },
    optionalDefault: { type: 'string', optional: true, default: 'not-applied' },
};

function result(schema, input) {
    const parsed = schema.safeParse(input);
    return parsed.success ? { data: parsed.data } : { issues: JSON.parse(JSON.stringify(parsed.error.issues)) };
}

test('declared tool schemas compile only once for a configuration, including absent and empty schemas', () => {
    let reads = 0;
    const tool = { name: 'cached', get inputSchema() { reads += 1; return legacySpec; } };
    const config = { tools: [tool, { name: 'absent' }, { name: 'empty', inputSchema: {} }] };
    const entries = config.tools.map(entry => getConfiguredToolInputSchema(config, entry));
    const coldReads = reads;
    assert.ok(coldReads > 0);
    for (let i = 0; i < 100; i += 1) {
        for (const [index, entry] of config.tools.entries()) {
            assert.strictEqual(getConfiguredToolInputSchema(config, entry), entries[index]);
            assert.strictEqual(getConfiguredToolInputSchema(config, entry).schema, entries[index].schema);
        }
    }
    assert.equal(reads, coldReads, 'warm lookups must not inspect or recompile a tool schema');
    assert.equal(entries[1].configured, false);
    assert.equal(entries[2].configured, true);
    for (const entry of entries.slice(1)) {
        assert.deepEqual(entry.schema.parse({ extra: 'stripped' }), {});
        assert.equal(entry.schema.safeParse(null).success, false);
    }
});

test('tool and configuration identities cannot collide or grow from undeclared tools', () => {
    const first = { name: 'same', inputSchema: { value: 'string' } };
    const second = { name: 'same', inputSchema: { value: 'number' } };
    const config = { tools: [first, second] };
    const otherConfig = { tools: [first] };
    const firstSchema = getConfiguredToolInputSchema(config, first).schema;
    const secondSchema = getConfiguredToolInputSchema(config, second).schema;
    assert.notStrictEqual(firstSchema, secondSchema);
    assert.notStrictEqual(firstSchema, getConfiguredToolInputSchema(otherConfig, first).schema);
    assert.equal(firstSchema.safeParse({ value: 2 }).success, false);
    assert.equal(secondSchema.safeParse({ value: 2 }).success, true);
    assert.throws(() => getConfiguredToolInputSchema(config, { ...first }), /not declared/);
    const appended = { name: 'late', inputSchema: {} };
    config.tools.push(appended);
    assert.throws(() => getConfiguredToolInputSchema(config, appended), /not declared/);
});

test('warm schemas preserve legacy validation and parsing behavior', async () => {
    const tool = { name: 'legacy', inputSchema: legacySpec };
    const config = { tools: [tool] };
    const compiled = getConfiguredToolInputSchema(config, tool);
    const coldConfig = structuredClone(config);
    const cold = getConfiguredToolInputSchema(coldConfig, coldConfig.tools[0]);
    const valid = { name: 'alice', nested: { flag: true }, labels: ['a', 'b'], metadata: { untyped: [1] } };
    for (const value of [
        valid, { name: 'bob', nested: { flag: false } },
        { ...valid, count: 0 }, { ...valid, count: 2 }, { ...valid, count: -1 },
        { ...valid, count: 3 }, { ...valid, name: '' }, { ...valid, name: 'unknown' },
        { ...valid, nested: {} }, { ...valid, labels: ['a', 'b', 'c'] },
        { ...valid, extra: true }, { ...valid, nested: { flag: true, extra: true } },
        {}, null, [], '',
    ]) assert.deepEqual(result(compiled.schema, value), result(cold.schema, value));
    assert.deepEqual(compiled.schema.parse(valid), valid);
    assert.deepEqual(compiled.schema.parse({ ...valid, extra: true, nested: { flag: true, extra: true } }), valid);
    assert.equal(compiled.schema.safeParse({ ...valid, name: 'unknown' }).success, false);
    assert.equal(compiled.schema.safeParse({ ...valid, nested: {} }).success, false);
    const parsed = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        compiled.schema.parseAsync({ name: index % 2 ? 'alice' : 'bob', nested: { flag: true } })));
    parsed[0].nested.flag = false;
    assert.ok(parsed.slice(1).every(entry => entry.nested.flag));
    assert.equal(parsed[0].optionalDefault, undefined, 'legacy default metadata is not applied');
    assert.deepEqual(compiled.schema.parse(valid), valid);
});

test('schema snapshots are detached and frozen without freezing Zod memoization', () => {
    const literal = { allowed: true };
    const tool = { name: 'snapshot', inputSchema: { value: { type: 'object', enum: [literal] } } };
    const config = { tools: [tool] };
    const compiled = getConfiguredToolInputSchema(config, tool);
    const retainedLiteral = compiled.schema.shape.value._def.value;
    assert.ok(Object.isFrozen(compiled));
    assert.ok(Object.isFrozen(retainedLiteral));
    assert.notStrictEqual(retainedLiteral, literal);
    assert.throws(() => { retainedLiteral.allowed = false; }, TypeError);
    literal.allowed = false;
    assert.deepEqual(retainedLiteral, { allowed: true });
    assert.equal(compiled.schema.safeParse({ value: retainedLiteral }).success, true);
});

test('absent, non-object, array and failed schemas retain the master fallback behavior', () => {
    for (const inputSchema of [undefined, null, false, 42, 'string']) {
        const tool = { name: 'fallback', inputSchema };
        const config = { tools: [tool] };
        const compiled = getConfiguredToolInputSchema(config, tool);
        assert.equal(compiled.configured, false);
        assert.equal(compiled.errorMessage, null);
        assert.deepEqual(compiled.schema.parse({ ignored: true }), {});
        assert.strictEqual(getConfiguredToolInputSchema(config, tool), compiled);
    }
    const broken = { name: 'broken', inputSchema: { value: { type: 'string', enum: ['only'], minLength: 2 } } };
    const config = { tools: [broken] };
    const compiled = getConfiguredToolInputSchema(config, broken);
    assert.equal(compiled.configured, false);
    assert.match(compiled.errorMessage, /Failed to build inputSchema for tool 'broken'/);
    assert.deepEqual(compiled.schema.parse({ ignored: true }), {});
    assert.strictEqual(getConfiguredToolInputSchema(config, broken), compiled);
    const arrayTool = { name: 'array', inputSchema: ['string'] };
    const arrayConfig = { tools: [arrayTool] };
    assert.deepEqual(getConfiguredToolInputSchema(arrayConfig, arrayTool).schema.parse({ 0: 'value' }), { 0: 'value' });
});

test('JSON Schema-looking objects are still legacy field maps rather than a new schema dialect', () => {
    const tool = { name: 'legacy-only', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } };
    const config = { tools: [tool] };
    const { schema } = getConfiguredToolInputSchema(config, tool);
    assert.equal(schema.safeParse({ value: 'new dialect must not be introduced' }).success, false);
    assert.deepEqual(schema.parse({ type: {}, properties: 'legacy property' }), { type: {}, properties: 'legacy property' });
});
