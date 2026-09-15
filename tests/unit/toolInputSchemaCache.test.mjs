import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfiguredToolInputSchema } from '../../Agent/server/toolInputSchemaCache.mjs';

const standardSpec = {
    type: 'object',
    properties: {
        name: { type: 'string', enum: ['alice', 'bob'], minLength: 3 },
        count: { type: 'integer', minimum: 0, maximum: 2 },
        nested: { type: 'object', properties: { flag: { type: 'boolean' } }, required: ['flag'], additionalProperties: false },
        labels: { type: 'array', items: { type: 'string' }, uniqueItems: true, maxItems: 2 },
        metadata: { type: 'object', additionalProperties: true },
    },
    required: ['name', 'nested'],
    additionalProperties: false,
};

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

test('each declared tool compiles only once for a configuration, including absent and empty schemas', () => {
    let reads = 0;
    const tool = { name: 'cached', get inputSchema() { reads += 1; return standardSpec; } };
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

for (const [format, inputSchema] of [['standard', standardSpec], ['legacy', legacySpec]]) {
    test(`${format} warm schemas preserve cold validation, nested values and independent parse results`, async () => {
        const tool = { name: format, inputSchema };
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
        assert.equal(compiled.schema.safeParse({ ...valid, name: 'unknown' }).success, false);
        assert.equal(compiled.schema.safeParse({ ...valid, nested: {} }).success, false);
        const parsed = await Promise.all(Array.from({ length: 20 }, (_, index) =>
            compiled.schema.parseAsync({ name: index % 2 ? 'alice' : 'bob', nested: { flag: true } })));
        parsed[0].nested.flag = false;
        assert.ok(parsed.slice(1).every(entry => entry.nested.flag));
        assert.equal(parsed[0].optionalDefault, undefined);
        assert.deepEqual(compiled.schema.parse(valid), valid);
    });
}

test('cached standard listings and retained refinement inputs are isolated immutable snapshots', () => {
    const spec = { type: 'object', properties: { value: { type: 'object', enum: [{ allowed: true }] } }, required: ['value'] };
    const tool = { name: 'snapshot', inputSchema: spec };
    const config = { tools: [tool] };
    const compiled = getConfiguredToolInputSchema(config, tool);
    assert.ok(Object.isFrozen(compiled));
    assert.ok(Object.isFrozen(compiled.jsonSchema.properties.value.enum[0]));
    assert.notStrictEqual(compiled.jsonSchema, spec);
    assert.throws(() => { compiled.jsonSchema.properties.value.enum[0].allowed = false; }, TypeError);
    spec.properties.value.enum[0].allowed = false;
    assert.equal(compiled.schema.safeParse({ value: { allowed: true } }).success, true);
    assert.equal(compiled.schema.safeParse({ value: { allowed: false } }).success, false);
    assert.deepEqual(compiled.jsonSchema.properties.value.enum, [{ allowed: true }]);
});

test('invalid schemas fail closed on every lookup without falling back to an empty schema', () => {
    for (const inputSchema of [
        null, [], 'string', 42,
        { type: 'object', properties: null },
        { type: 'object', properties: {}, default: {} },
        { type: 'object', properties: { value: { type: 'string', default: 'unsupported' } } },
        { type: 'object', properties: {}, oneOf: [] },
    ]) {
        const tool = { name: 'invalid', inputSchema };
        const config = { tools: [tool] };
        for (let i = 0; i < 3; i += 1) {
            assert.throws(() => getConfiguredToolInputSchema(config, tool), /Failed to build inputSchema for tool 'invalid'/);
        }
    }
});
