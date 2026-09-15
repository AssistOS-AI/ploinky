import { zod } from 'mcp-sdk';

const { z } = zod;
const commonKeywords = ['type', 'description', 'enum'];
const keywordsByType = {
    object: ['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'],
    array: ['items', 'minItems', 'maxItems', 'uniqueItems'],
    string: ['minLength', 'maxLength', 'pattern', 'format'],
    number: ['minimum', 'maximum'],
    integer: ['minimum', 'maximum'],
    boolean: [],
    null: [],
};

function invalid(path, message) {
    throw new Error(`Invalid tool inputSchema at ${path}: ${message}`);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equalJsonValues(left, right) {
    // JSON numbers compare by value: -0 and 0 are the same item, including
    // inside arrays/objects. Object property order does not affect equality.
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
        || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
        && keys.every(key => Object.hasOwn(right, key) && equalJsonValues(left[key], right[key]));
}

export function isJsonSchema(spec) {
    if (!isObject(spec)) return false;
    // Legacy field maps may have a field named "type", including the shorthand
    // { type: 'string' }. Prefer that established form when it is ambiguous;
    // standard schemas identify their object properties or another keyword.
    return (spec.type === 'object' && Object.hasOwn(spec, 'properties')
            && !(typeof spec.properties === 'string' || (isObject(spec.properties) && typeof spec.properties.type === 'string')))
        || Object.keys(spec).some(key => key.startsWith('$'))
        || ['required', 'allOf', 'anyOf', 'oneOf'].some(key => Array.isArray(spec[key]))
        || typeof spec.additionalProperties === 'boolean'
        || typeof spec.minProperties === 'number'
        || typeof spec.maxProperties === 'number';
}

function buildSchema(spec, path) {
    if (!isObject(spec)) invalid(path, 'expected a schema object');
    const allowed = keywordsByType[spec.type];
    if (!allowed) invalid(path, 'an explicit supported type is required');
    for (const key of Object.keys(spec)) {
        if (!commonKeywords.includes(key) && !allowed.includes(key)) {
            invalid(path, `unsupported keyword '${key}' for ${spec.type}`);
        }
    }
    if (Object.hasOwn(spec, 'description') && typeof spec.description !== 'string') {
        invalid(path, 'description must be a string');
    }
    const bound = (key, integer = true) => {
        if (!Object.hasOwn(spec, key)) return undefined;
        const value = spec[key];
        if (typeof value !== 'number' || !Number.isFinite(value)
            || (integer && (!Number.isSafeInteger(value) || value < 0))) {
            invalid(path, `${key} must be ${integer ? 'a nonnegative integer' : 'a finite number'}`);
        }
        return value;
    };
    let schema;
    switch (spec.type) {
        case 'object': {
            const properties = Object.hasOwn(spec, 'properties') ? spec.properties : {};
            if (!isObject(properties)) invalid(path, 'properties must be an object');
            const required = Object.hasOwn(spec, 'required') ? spec.required : [];
            if (!Array.isArray(required) || required.some(key => typeof key !== 'string')
                || new Set(required).size !== required.length) {
                invalid(path, 'required must contain unique property names');
            }
            if (required.some(key => !Object.hasOwn(properties, key))) {
                invalid(path, 'required properties must have declared schemas');
            }
            if (Object.hasOwn(spec, 'additionalProperties') && typeof spec.additionalProperties !== 'boolean') {
                invalid(path, 'only boolean additionalProperties is supported');
            }
            const shape = Object.create(null);
            for (const [key, field] of Object.entries(properties)) {
                const fieldSchema = buildSchema(field, `${path}.properties.${key}`);
                shape[key] = required.includes(key) ? fieldSchema : fieldSchema.optional();
            }
            schema = z.object(shape);
            schema = spec.additionalProperties === false ? schema.strict() : schema.passthrough();
            const min = bound('minProperties');
            const max = bound('maxProperties');
            if (min !== undefined) schema = schema.refine(value => Object.keys(value).length >= min, `Expected at least ${min} properties`);
            if (max !== undefined) schema = schema.refine(value => Object.keys(value).length <= max, `Expected at most ${max} properties`);
            break;
        }
        case 'array': {
            schema = z.array(Object.hasOwn(spec, 'items') ? buildSchema(spec.items, `${path}.items`) : z.unknown());
            const min = bound('minItems');
            const max = bound('maxItems');
            if (min !== undefined) schema = schema.min(min);
            if (max !== undefined) schema = schema.max(max);
            if (Object.hasOwn(spec, 'uniqueItems') && typeof spec.uniqueItems !== 'boolean') {
                invalid(path, 'uniqueItems must be boolean');
            }
            if (spec.uniqueItems) schema = schema.refine(
                values => !values.some((value, index) => values.slice(0, index).some(prior => equalJsonValues(prior, value))),
                'Array items must be unique',
            );
            break;
        }
        case 'string': {
            schema = z.string();
            const min = bound('minLength');
            const max = bound('maxLength');
            // JSON Schema counts Unicode code points, rather than UTF-16 units.
            if (min !== undefined) schema = schema.refine(value => [...value].length >= min, `Expected at least ${min} characters`);
            if (max !== undefined) schema = schema.refine(value => [...value].length <= max, `Expected at most ${max} characters`);
            if (Object.hasOwn(spec, 'pattern')) {
                if (typeof spec.pattern !== 'string') invalid(path, 'pattern must be a string');
                let pattern;
                try { pattern = new RegExp(spec.pattern, 'u'); } catch { invalid(path, 'invalid pattern'); }
                schema = schema.refine(value => pattern.test(value), 'String does not match pattern');
            }
            if (Object.hasOwn(spec, 'format')) {
                if (spec.format !== 'uri') invalid(path, `unsupported format '${spec.format}'`);
                schema = schema.refine(value => {
                    if (!/^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/.test(value)
                        || /%(?![0-9A-Fa-f]{2})/u.test(value)) return false;
                    try { new URL(value); return true; } catch { return false; }
                }, 'Expected an absolute URI');
            }
            break;
        }
        case 'integer':
        case 'number': {
            schema = z.number().finite();
            if (spec.type === 'integer') schema = schema.int();
            const min = bound('minimum', false);
            const max = bound('maximum', false);
            if (min !== undefined) schema = schema.min(min);
            if (max !== undefined) schema = schema.max(max);
            break;
        }
        case 'boolean': schema = z.boolean(); break;
        case 'null': schema = z.null(); break;
    }
    if (Object.hasOwn(spec, 'enum')) {
        if (!Array.isArray(spec.enum) || !spec.enum.length) invalid(path, 'enum must be a nonempty array');
        schema = schema.refine(value => spec.enum.some(option => equalJsonValues(option, value)), 'Value is not in enum');
    }
    if (spec.description) schema = schema.describe(spec.description);
    return schema;
}

export function buildJsonSchema(spec) {
    if (spec?.type !== 'object') invalid('$', 'tool arguments must have type object');
    return buildSchema(spec, '$');
}

export function preserveJsonSchemaToolListings(server, schemas) {
    // The pinned SDK converts Zod back to JSON Schema and loses refinements
    // (e.g. minProperties and uniqueItems). Wrap its public handler installation
    // to retain the original, validated schema without changing legacy listings.
    const setRequestHandler = server.server.setRequestHandler;
    server.server.setRequestHandler = function (requestSchema, handler) {
        if (requestSchema.shape.method.value === 'tools/list') {
            const sdkHandler = handler;
            handler = async (...args) => {
                const result = await sdkHandler(...args);
                return { ...result, tools: result.tools.map(tool => schemas.has(tool.name)
                    ? { ...tool, inputSchema: schemas.get(tool.name) } : tool) };
            };
        }
        return setRequestHandler.call(this, requestSchema, handler);
    };
    try { server.setToolRequestHandlers(); } finally { server.server.setRequestHandler = setRequestHandler; }
}
