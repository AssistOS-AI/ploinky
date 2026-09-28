// Per-agent opt-out for the agent-port relay.
//
// `/base-agent-additional-server/<agent>/<port>/` relays to any loopback port
// inside the agent container, subject only to the route's access policy. An
// agent that runs private services on loopback declares in its manifest:
//
//   routerAccess.agentPorts: false          no port is relayed, for any caller
//   routerAccess.agentPorts: [7000, 9000]   only these container ports
//
// Without the field the relay keeps its existing behaviour.

export const AGENT_PORT_RELAY_DISABLED = 'AGENT_PORT_RELAY_DISABLED';
export const AGENT_PORT_NOT_DECLARED = 'AGENT_PORT_NOT_DECLARED';

/**
 * @returns {{ mode: 'all' } | { mode: 'none' } | { mode: 'listed', ports: number[] }}
 * @throws {Error} when the manifest value is malformed
 */
export function normalizeAgentPortRelayPolicy(value, label = 'routerAccess.agentPorts') {
    if (value === undefined || value === null || value === true) return Object.freeze({ mode: 'all' });
    if (value === false) return Object.freeze({ mode: 'none' });
    if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
        throw new Error(`${label} must be true, false, or a non-empty list of at most 64 container ports`);
    }
    const ports = value.map((port) => {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`${label} entries must be integer TCP ports from 1 to 65535`);
        }
        return port;
    });
    if (new Set(ports).size !== ports.length) throw new Error(`${label} must not repeat a port`);
    return Object.freeze({ mode: 'listed', ports: Object.freeze([...ports].sort((a, b) => a - b)) });
}

export function agentPortRelayPolicyFromManifest(manifest) {
    return normalizeAgentPortRelayPolicy(manifest?.routerAccess?.agentPorts);
}

/** @returns {null | { status: number, code: string }} a denial, or null to continue */
export function agentPortRelayDenial(policy, port) {
    if (policy.mode === 'none') return Object.freeze({ status: 403, code: AGENT_PORT_RELAY_DISABLED });
    if (policy.mode === 'listed' && !policy.ports.includes(Number(port))) {
        return Object.freeze({ status: 403, code: AGENT_PORT_NOT_DECLARED });
    }
    return null;
}
