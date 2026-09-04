import { zod } from 'mcp-sdk';

const { z } = zod;
// Only loaded configuration and its declared tool objects can populate this
// cache. No session, actor, token, request argument, or client-supplied key is held.
const configuredSchemas = new WeakMap();

function freezeSchemaSpec(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeSchemaSpec(child);
        Object.freeze(value);
    }
    return value;
}

export function getConfiguredToolInputSchema(config, tool) {
    let entries = configuredSchemas.get(config);
    if (!entries) {
        entries = new Map((Array.isArray(config?.tools) ? config.tools : [])
            .filter(entry => entry && typeof entry === 'object')
            .map(entry => [entry, null]));
        configuredSchemas.set(config, entries);
    }
    if (!entries.has(tool)) throw new Error('Tool is not declared in this configuration');
    const existing = entries.get(tool);
    if (existing) return existing;

    let schema = null;
    let errorMessage = null;
    // Preserve the established field-map compiler and its empty-object fallback
    // for absent/non-object input or a failed build. Validation semantics do not
    // change as part of schema reuse.
    if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        try {
            const spec = freezeSchemaSpec(structuredClone(tool.inputSchema));
            schema = buildZodObjectSchema(spec);
        } catch (err) {
            errorMessage = `[AgentServer/MCP] Failed to build inputSchema for tool '${tool.name}': ${err.message}`;
        }
    }
    // Zod internally memoizes object shapes: keep its graph private and do not
    // deep-freeze it. Parsing creates request-local results and errors.
    const compiled = Object.freeze({ schema: schema || z.object({}), configured: Boolean(schema), errorMessage });
    entries.set(tool, compiled);
    return compiled;
}

function createLiteralUnionSchema(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }
    const unique = [...new Set(values)];
    if (unique.length === 1) {
        return z.literal(unique[0]);
    }
    return z.union(unique.map(value => z.literal(value)));
}

function buildZodObjectSchema(spec) {
    if (!spec || typeof spec !== 'object') {
        return null;
    }
    const shape = {};
    let hasFields = false;
    for (const [key, fieldSpec] of Object.entries(spec)) {
        shape[key] = createFieldSchema(fieldSpec);
        hasFields = true;
    }
    if (!hasFields) {
        return z.object({});
    }
    return z.object(shape);
}

function createFieldSchema(fieldSpec) {
    if (typeof fieldSpec === 'string') {
        fieldSpec = { type: fieldSpec };
    }
    if (!fieldSpec || typeof fieldSpec !== 'object') {
        return z.any();
    }
    const type = typeof fieldSpec.type === 'string' ? fieldSpec.type.toLowerCase() : 'string';
    let schema;
    switch (type) {
        case 'string': {
            if (Array.isArray(fieldSpec.enum) && fieldSpec.enum.every(value => typeof value === 'string')) {
                schema = createLiteralUnionSchema(fieldSpec.enum) || z.string();
            } else {
                schema = z.string();
            }
            if (typeof fieldSpec.minLength === 'number') {
                schema = schema.min(fieldSpec.minLength);
            }
            if (typeof fieldSpec.maxLength === 'number') {
                schema = schema.max(fieldSpec.maxLength);
            }
            break;
        }
        case 'number': {
            schema = z.number();
            if (typeof fieldSpec.min === 'number') {
                schema = schema.min(fieldSpec.min);
            }
            if (typeof fieldSpec.max === 'number') {
                schema = schema.max(fieldSpec.max);
            }
            if (Array.isArray(fieldSpec.enum) && fieldSpec.enum.every(value => typeof value === 'number')) {
                schema = createLiteralUnionSchema(fieldSpec.enum) || schema;
            }
            break;
        }
        case 'boolean':
            schema = z.boolean();
            break;
        case 'array': {
            const itemSchema = createFieldSchema(fieldSpec.items ?? { type: 'string' });
            schema = z.array(itemSchema);
            if (typeof fieldSpec.minItems === 'number') {
                schema = schema.min(fieldSpec.minItems);
            }
            if (typeof fieldSpec.maxItems === 'number') {
                schema = schema.max(fieldSpec.maxItems);
            }
            break;
        }
        case 'object': {
            const nested = buildZodObjectSchema(fieldSpec.properties) || z.object({});
            schema = fieldSpec.additionalProperties === true ? nested.passthrough() : nested;
            break;
        }
        default:
            schema = z.any();
            break;
    }

    if (!schema) {
        schema = z.any();
    }

    if (fieldSpec.isArray && type !== 'array') {
        let arraySchema = z.array(schema);
        if (typeof fieldSpec.minItems === 'number') {
            arraySchema = arraySchema.min(fieldSpec.minItems);
        }
        if (typeof fieldSpec.maxItems === 'number') {
            arraySchema = arraySchema.max(fieldSpec.maxItems);
        }
        schema = arraySchema;
    }

    if (Array.isArray(fieldSpec.enum) && !['string', 'number'].includes(type)) {
        const enumSchema = createLiteralUnionSchema(fieldSpec.enum);
        if (enumSchema) {
            schema = enumSchema;
        }
    }

    if (fieldSpec.nullable) {
        schema = schema.nullable();
    }
    if (fieldSpec.optional) {
        schema = schema.optional();
    }
    if (typeof fieldSpec.description === 'string' && schema.describe) {
        schema = schema.describe(fieldSpec.description);
    }
    return schema;
}
