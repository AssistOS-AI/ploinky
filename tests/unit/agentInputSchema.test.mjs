import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJsonSchema, isJsonSchema } from '../../Agent/server/inputSchema.mjs';

const wrap = field => ({ type: 'object', properties: { value: field }, required: ['value'], additionalProperties: false });

test('standard schemas enforce required, optional, additional and nested properties without changing arguments', () => {
    const schema = buildJsonSchema({ type: 'object', properties: {
        name: { type: 'string', minLength: 1 },
        metadata: { type: 'object', additionalProperties: true },
        nested: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false },
    }, required: ['name'], additionalProperties: false, minProperties: 1 });
    const args = { name: 'owner', metadata: { arbitrary: [1, 'two'] }, nested: { enabled: false } };
    assert.deepEqual(schema.parse(args), args);
    assert.deepEqual(schema.parse({ name: 'owner' }), { name: 'owner' });
    for (const invalid of [{}, { name: '' }, { name: 'owner', extra: true }, { name: 'owner', nested: {} }, { name: 'owner', nested: { enabled: true, extra: true } }]) {
        assert.equal(schema.safeParse(invalid).success, false, JSON.stringify(invalid));
    }
    assert.equal(buildJsonSchema({ type: 'object', minProperties: 1 }).safeParse({}).success, false);
    assert.deepEqual(buildJsonSchema({ type: 'object' }).parse({ extra: 'allowed by default' }), { extra: 'allowed by default' });
});

test('standard schemas preserve integer, inclusive numeric bounds, enum and string constraints together', () => {
    const amount = buildJsonSchema(wrap({ type: 'integer', minimum: 1, maximum: 10 }));
    for (const value of [1, 10]) assert.equal(amount.safeParse({ value }).success, true);
    for (const value of [-1, 0, 1.5, 11, '1', Infinity]) assert.equal(amount.safeParse({ value }).success, false);
    const label = buildJsonSchema(wrap({ type: 'string', enum: ['ab', 'abc', 'bad'], minLength: 3, maxLength: 3, pattern: '^a' }));
    assert.equal(label.safeParse({ value: 'abc' }).success, true);
    for (const value of ['ab', 'abcd', 'bad']) assert.equal(label.safeParse({ value }).success, false);
    const unicode = buildJsonSchema(wrap({ type: 'string', minLength: 1, maxLength: 1 }));
    assert.equal(unicode.safeParse({ value: '😀' }).success, true);
    assert.equal(unicode.safeParse({ value: '😀x' }).success, false);
    const uri = buildJsonSchema(wrap({ type: 'string', format: 'uri' }));
    for (const value of ['https://example.test/callback', 'urn:example:test']) assert.equal(uri.safeParse({ value }).success, true);
    for (const value of ['/callback', 'not a uri', 'https://example.test/%broken', 'https://example.test/with space']) assert.equal(uri.safeParse({ value }).success, false);
});

test('standard arrays retain nested constraints, item bounds and structural uniqueness', () => {
    const schema = buildJsonSchema(wrap({ type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
        items: { type: 'object', properties: { id: { type: 'string', pattern: '^id-' }, enabled: { type: 'boolean' } }, required: ['id'], additionalProperties: false },
    }));
    assert.equal(schema.safeParse({ value: [{ id: 'id-1' }, { id: 'id-2' }] }).success, true);
    for (const value of [[], [{ id: 'id-1' }, { id: 'id-2' }, { id: 'id-3' }], [{ id: 'bad' }], [{ id: 'id-1', extra: true }], [{ id: 'id-1', enabled: true }, { enabled: true, id: 'id-1' }]]) {
        assert.equal(schema.safeParse({ value }).success, false, JSON.stringify(value));
    }
    const numbers = buildJsonSchema(wrap({ type: 'array', uniqueItems: true, items: { type: 'number' } }));
    assert.equal(numbers.safeParse(JSON.parse('{"value":[-0,0]}')).success, false);
    const objects = buildJsonSchema(wrap({ type: 'array', uniqueItems: true, items: { type: 'object' } }));
    assert.equal(objects.safeParse(JSON.parse('{"value":[{"x":-0},{"x":0}]}')).success, false);
    assert.equal(buildJsonSchema(wrap({ type: 'number', enum: [0] })).safeParse({ value: -0 }).success, true);
});

test('unsupported or malformed standard constraints fail closed and legacy field names remain recognizable', () => {
    for (const input of [
        { type: 'object', oneOf: [] }, { type: 'object', additionalProperties: {} },
        { type: 'object', properties: null }, { type: 'object', required: null },
        { type: 'object', required: ['missing'] }, { type: 'object', minProperties: -1 },
        wrap({ type: 'string', format: 'unsupported' }), wrap({ type: 'string', pattern: '[' }),
        wrap({ type: 'array', uniqueItems: 'true' }), wrap({ type: 'integer', minimum: '1' }),
        wrap({ type: 'string', enum: [] }), wrap({ type: 'string', optional: true }),
    ]) assert.throws(() => buildJsonSchema(input), /Invalid tool inputSchema/);
    assert.equal(isJsonSchema({ type: 'object', properties: {} }), true);
    assert.equal(isJsonSchema({ anyOf: [] }), true);
    assert.equal(isJsonSchema({ type: { type: 'string' }, required: { type: 'boolean', optional: true } }), false);
    assert.equal(isJsonSchema({ type: 'string' }), false);
    assert.equal(isJsonSchema({ type: 'number', limit: { type: 'number', optional: true } }), false);
    assert.equal(isJsonSchema({ type: 'object', properties: { type: 'string' } }), false);
});
