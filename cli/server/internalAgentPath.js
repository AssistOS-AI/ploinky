/**
 * Shared detector for router-owned `__agent` control-plane paths (DS015).
 *
 * An agent's `__agent/*` routes (e.g. the public-route-share authorizer) are
 * reached ONLY by the router itself, over a direct loopback call carrying a
 * minted Router Request. The public listener must never forward an `__agent`
 * path to an agent, including a synthesized relay/proxy path, must be treated as
 * control-plane. This helper therefore checks both external request paths and
 * synthesized upstream paths.
 *
 * A segment counts as `__agent` whether it is raw or percent-encoded
 * (`%5F%5Fagent`, and a couple of layers of double-encoding), because the agent
 * HTTP server decodes the path before routing.
 */

const MAX_DECODE_PASSES = 3;

function fullyDecodeSegment(segment) {
    let current = String(segment);
    for (let i = 0; i < MAX_DECODE_PASSES; i += 1) {
        let next;
        try {
            next = decodeURIComponent(current);
        } catch {
            break;
        }
        if (next === current) break;
        current = next;
    }
    return current;
}

export function hasInternalAgentSegment(path) {
    const pathname = String(path || '').split('?')[0].split('#')[0];
    return pathname.split('/').filter(Boolean).some((segment) => {
        if (segment === '__agent') return true;
        return fullyDecodeSegment(segment) === '__agent';
    });
}

export default { hasInternalAgentSegment };
