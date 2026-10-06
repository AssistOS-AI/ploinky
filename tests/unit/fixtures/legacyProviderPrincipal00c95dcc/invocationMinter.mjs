// Differential oracle (test fixture, not runtime code): R58 commit 00c95dcc's
// resolveProviderPrincipal from cli/server/mcp-proxy/invocationMinter.js,
// verbatim, over the verbatim 00c95dcc agent registry next to this file.
import { resolveAgentDescriptor } from './agentRegistry.mjs';

export function resolveProviderPrincipal({ providerAgentRef, providerPrincipal }) {
    if (providerPrincipal) return String(providerPrincipal).trim();
    const descriptor = resolveAgentDescriptor(providerAgentRef);
    if (!descriptor) {
        throw new Error(`invocationMinter: could not resolve provider '${providerAgentRef}'`);
    }
    return descriptor.principalId;
}
