// Task-reference MCP tools (interface contract §2.2). A tool declared with
// `taskReference: {version: 1, provider}` runs as an ordinary bounded
// synchronous tool, never as a TaskQueue entry. AgentServer advertises the
// declaration as `annotations.ploinkyTaskReference`, injects a required
// `originRequestId` into the tool's strict input schema, and accepts only one
// admission-result object from the tool process.

export const TASK_REFERENCE_ANNOTATION = 'ploinkyTaskReference';
export const TASK_REFERENCE_STATES = Object.freeze(['accepted', 'queued', 'pending-coordinator']);
export const ORIGIN_REQUEST_ID_SOURCE = '^[A-Za-z0-9_-]{22}$';
const ORIGIN_REQUEST_ID = new RegExp(ORIGIN_REQUEST_ID_SOURCE);
const TASK_ID = /^[A-Za-z0-9_-]{22,64}$/;
const ROUTE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// Declarations that would make the tool asynchronous or long-lived.
const FORBIDDEN_WITH_TASK_REFERENCE = Object.freeze(['async', 'continuationTool', 'taskMessageTool', 'timeoutMs']);

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value, keys) {
    const own = Object.keys(value).sort();
    const want = [...keys].sort();
    return own.length === want.length && own.every((key, index) => key === want[index]);
}

function invalidDeclaration(tool, reason) {
    return new Error(`[AgentServer/MCP] Invalid taskReference for tool '${tool?.name}': ${reason}`);
}

// Returns null when the tool declares no task reference. Presence is the own
// property: an invalid declaration is a configuration error, never absence.
export function readTaskReferenceDeclaration(tool) {
    if (!tool || typeof tool !== 'object' || !Object.hasOwn(tool, 'taskReference')) return null;
    const value = tool.taskReference;
    if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'provider'])) {
        throw invalidDeclaration(tool, 'it must be exactly {version, provider}');
    }
    if (value.version !== 1) throw invalidDeclaration(tool, 'version must be the number 1');
    if (typeof value.provider !== 'string' || !ROUTE_KEY.test(value.provider)) {
        throw invalidDeclaration(tool, 'provider must be a route key');
    }
    for (const key of FORBIDDEN_WITH_TASK_REFERENCE) {
        if (Object.hasOwn(tool, key)) throw invalidDeclaration(tool, `it cannot be combined with '${key}'`);
    }
    return Object.freeze({ version: 1, provider: value.provider });
}

export function taskReferenceAnnotation(declaration) {
    return { [TASK_REFERENCE_ANNOTATION]: { version: declaration.version, provider: declaration.provider } };
}

// The strict JSON input schema of a task-reference tool: the configured JSON
// schema (or an empty object schema) with a required `originRequestId` of 22
// base64url characters, and no other undeclared property. A field-map schema
// cannot express the pattern and is refused, as is a configured
// `originRequestId` property.
export function taskReferenceInputSchema(tool, { isJsonSchema }) {
    const configured = tool.inputSchema !== undefined;
    const base = configured ? tool.inputSchema : { type: 'object', properties: {} };
    if (!isPlainObject(base) || (configured && !isJsonSchema(base))) {
        throw invalidDeclaration(tool, 'a task-reference tool needs a standard JSON object input schema');
    }
    if (base.type !== 'object') throw invalidDeclaration(tool, 'its input schema must have type object');
    const properties = isPlainObject(base.properties) ? base.properties : {};
    if (Object.hasOwn(properties, 'originRequestId')) {
        throw invalidDeclaration(tool, 'originRequestId is injected by AgentServer and cannot be configured');
    }
    if (base.additionalProperties === true) {
        throw invalidDeclaration(tool, 'its input schema must not allow additional properties');
    }
    const required = Array.isArray(base.required) ? base.required : [];
    return {
        ...base,
        type: 'object',
        properties: {
            ...properties,
            originRequestId: {
                type: 'string',
                description: 'Caller-generated identity of this intentional request, persisted before the first transmission.',
                minLength: 22,
                maxLength: 22,
                pattern: ORIGIN_REQUEST_ID_SOURCE,
            },
        },
        required: [...required, 'originRequestId'],
        additionalProperties: false,
    };
}

function admissionError(reason) {
    const error = new Error(`task-reference admission result rejected: ${reason}`);
    error.code = 'TASK_REFERENCE_RESULT_INVALID';
    return error;
}

// The tool process must print exactly one JSON object on stdout:
// {"taskRef":{"version":1,"provider":…,"id":…},"state":…,"originRequestId":…}.
// The provider must be the declared one and originRequestId the argument.
export function parseTaskReferenceAdmission(stdout, { provider, originRequestId }) {
    const text = String(stdout ?? '').trim();
    if (!text.startsWith('{') || !text.endsWith('}')) throw admissionError('stdout must be exactly one JSON object');
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        throw admissionError('stdout must be exactly one JSON object');
    }
    if (!isPlainObject(value) || !hasExactKeys(value, ['taskRef', 'state', 'originRequestId'])) {
        throw admissionError('the object must have exactly taskRef, state and originRequestId');
    }
    const { taskRef } = value;
    if (!isPlainObject(taskRef) || !hasExactKeys(taskRef, ['version', 'provider', 'id'])
        || taskRef.version !== 1 || typeof taskRef.id !== 'string' || !TASK_ID.test(taskRef.id)) {
        throw admissionError('taskRef must be {version: 1, provider, id} with a 22-64 character base64url id');
    }
    if (taskRef.provider !== provider) throw admissionError('taskRef.provider is not the declared provider');
    if (!TASK_REFERENCE_STATES.includes(value.state)) throw admissionError('state is not an admission state');
    if (typeof value.originRequestId !== 'string' || !ORIGIN_REQUEST_ID.test(value.originRequestId)
        || value.originRequestId !== originRequestId) {
        throw admissionError('originRequestId does not match the request');
    }
    return Object.freeze({
        taskRef: Object.freeze({ version: 1, provider: taskRef.provider, id: taskRef.id }),
        state: value.state,
        originRequestId: value.originRequestId,
    });
}

// The Router origin token travels in the trusted `x-ploinky-auth-info` header
// of the forwarded tool call as `taskRefOrigin`. Returns it, or ''.
export function readTaskRefOrigin(requestHeaders) {
    const raw = requestHeaders?.['x-ploinky-auth-info'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || !value) return '';
    try {
        const parsed = JSON.parse(value);
        return typeof parsed?.taskRefOrigin === 'string' ? parsed.taskRefOrigin : '';
    } catch {
        return '';
    }
}
