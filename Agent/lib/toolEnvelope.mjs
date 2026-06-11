/**
 * toolEnvelope.mjs
 *
 * Shared parse / normalize / write helpers used by tool wrappers that live
 * inside an agent container. Tools read a single JSON envelope from stdin,
 * potentially with layers of { tool, input, arguments, params } wrappers,
 * and emit their response to stdout.
 *
 * The secure-wire envelope also carries:
 *   - invocation: a verified invocation grant (set by the AgentServer after
 *     verifying the router's signed invocation token). Tools MUST NOT invent
 *     caller or delegated-user data outside of what this field exposes.
 */

export function readStdinFallback(process) {
    return new Promise((resolve) => {
        if (process.stdin.isTTY) return resolve('');
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
    });
}

export function safeParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export function unwrapInput(envelope) {
    let current = envelope;
    for (let i = 0; i < 6; i += 1) {
        if (!current || typeof current !== 'object') break;
        if (current.input && typeof current.input === 'object') {
            current = current.input;
            continue;
        }
        if (current.arguments && typeof current.arguments === 'object') {
            current = current.arguments;
            continue;
        }
        if (current.params?.arguments && typeof current.params.arguments === 'object') {
            current = current.params.arguments;
            continue;
        }
        if (current.params?.input && typeof current.params.input === 'object') {
            current = current.params.input;
            continue;
        }
        break;
    }
    return current && typeof current === 'object' ? current : {};
}

export function extractMetadata(envelope) {
    if (!envelope || typeof envelope !== 'object') return {};
    return envelope.metadata && typeof envelope.metadata === 'object'
        ? envelope.metadata
        : {};
}

export function extractInvocationGrant(envelope) {
    const metadata = extractMetadata(envelope);
    const grant = metadata.invocation && typeof metadata.invocation === 'object'
        ? metadata.invocation
        : null;
    return grant;
}

/**
 * Derive a normalized actor suitable for ACL checks.
 * Uses only the router-verified invocation grant.
 *
 * Returns:
 *   {
 *     authenticated,
 *     principalId,
 *     agent: { principalId, name } | null,
 *     delegatedUser: { id, username, email, roles } | null,
 *     invocationToken: string,
 *     invocationVerified: bool
 *   }
 */
export function deriveActor(envelope) {
    const grant = extractInvocationGrant(envelope);
    const metadata = extractMetadata(envelope);
    if (grant) {
        const callerPrincipal = grant.caller && typeof grant.caller === 'object'
            ? String(grant.caller.id || '').trim()
            : String(grant.caller || grant.sub || '').trim();
        const delegated = (grant.usr || grant.user) && typeof (grant.usr || grant.user) === 'object' ? (grant.usr || grant.user) : null;
        return {
            authenticated: true,
            invocationVerified: true,
            principalId: callerPrincipal || '',
            agent: callerPrincipal && /^agent:/i.test(callerPrincipal)
                ? { principalId: callerPrincipal, name: callerPrincipal.replace(/^agent:/i, '') }
                : null,
            delegatedUser: delegated
                ? {
                      id: String(delegated.sub || delegated.id || ''),
                      username: String(delegated.username || delegated.preferred_username || ''),
                      email: String(delegated.email || ''),
                      roles: Array.isArray(delegated.roles) ? [...delegated.roles] : []
                  }
                : null,
            invocationToken: String(metadata.invocationToken || ''),
            scope: Array.isArray(grant.scope) ? [...grant.scope] : [],
            tool: String(grant.tool || ''),
            workspaceId: String(grant.workspace_id || '')
        };
    }
    return {
        authenticated: false,
        invocationVerified: false,
        principalId: '',
        agent: null,
        delegatedUser: null,
        invocationToken: '',
        scope: [],
        tool: '',
        workspaceId: ''
    };
}

export function writeJson(value, stream) {
    (stream || process.stdout).write(JSON.stringify(value));
}

export default {
    readStdinFallback,
    safeParseJson,
    unwrapInput,
    extractMetadata,
    extractInvocationGrant,
    deriveActor,
    writeJson
};
