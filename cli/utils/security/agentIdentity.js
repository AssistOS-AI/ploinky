function normalizeSegment(value, label) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) {
        throw new Error(`agentIdentity: ${label} is required`);
    }
    if (raw.includes('/') || raw.includes(':') || /\s/.test(raw)) {
        throw new Error(`agentIdentity: ${label} must not contain '/', ':' or whitespace (got '${raw}')`);
    }
    return raw;
}

export function deriveAgentRef(repoName, agentName) {
    const repo = normalizeSegment(repoName, 'repoName');
    const agent = normalizeSegment(agentName, 'agentName');
    return `${repo}/${agent}`;
}

export function deriveAgentPrincipalId(repoName, agentName) {
    return `agent:${deriveAgentRef(repoName, agentName)}`;
}

export default {
    deriveAgentRef,
    deriveAgentPrincipalId
};
