export function formatOuterRuntimeBanner({ runtimeName, user, cwd = '/workspace' }) {
    return [
        "[ploinky] Entering outer runtime '" + runtimeName + "'",
        '[ploinky] user=' + user + ' cwd=' + cwd + '; exit returns to the previous prompt',
    ];
}

export function resolveAgentAttachmentIdentity(agentName, containerName, registry = {}) {
    const record = registry[containerName] || {};
    const runtime = record.runtime || 'container';
    const image = record.containerImage
        || (runtime === 'bwrap' || runtime === 'seatbelt'
            ? 'host (' + runtime + ')'
            : '<unknown>');
    return { agentName, containerName, image };
}

export function formatAgentAttachmentBanner({ agentName, containerName, image }) {
    return [
        "[ploinky] Attaching to agent '" + agentName + "'",
        '[ploinky] container=' + containerName,
        '[ploinky] image=' + image,
    ];
}
