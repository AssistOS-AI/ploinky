import { HardwareStoreError, validateStoreToken } from '../../sandbox/hardwareLimits/store.mjs';

export function validateHardwareRequest(body) {
    const fields = {
        set_agent_limits: ['action', 'expectedToken', 'agentRef', 'limits'],
        clear_agent_limits: ['action', 'expectedToken', 'agentRef'],
        apply: ['action', 'expectedToken', 'containers'],
    };
    const fail = (code, message) => { throw new HardwareStoreError(message, { code, status: 400 }); };
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_json', 'Request body must be an object.');
    if (typeof body.action !== 'string') fail('unknown_action', 'Unsupported hardware limits action.');
    const allowed = Object.hasOwn(fields, body.action) ? fields[body.action] : null;
    if (!allowed) fail('unknown_action', 'Unsupported hardware limits action.');
    if (Object.keys(body).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(body, key))) fail('invalid_limits', 'Unexpected or missing request field.');
    validateStoreToken(body.expectedToken);
    if (body.action === 'apply' && (!Array.isArray(body.containers) || body.containers.length > 256 || body.containers.some((key) => typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024))) fail('invalid_limits', 'Apply requires bounded exact registry keys.');
    return body;
}
