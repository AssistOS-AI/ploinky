import {
    AgentCredentialContextError,
    assertAgentCredentialContext,
    createBwrapAgentCredentialContext,
    createContainerAgentCredentialContext,
} from './agentCredentialContext.mjs';

function invalidRuntime(message) {
    throw new AgentCredentialContextError(
        'PLOINKY_AGENT_CREDENTIAL_RUNTIME_INVALID',
        message,
    );
}

/**
 * Select the one credential transport admitted by the outer runtime.
 *
 * This is deliberately a selector, not a discovery sequence: a failure in the
 * selected transport is returned to the caller and never retries through the
 * other runtime's credential adapter.
 */
export function bootstrapAgentCredentialContext(env = process.env, {
    createBwrapContext = createBwrapAgentCredentialContext,
    createContainerContext = createContainerAgentCredentialContext,
    assertContext = assertAgentCredentialContext,
} = {}) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        invalidRuntime('an exact runtime environment is required');
    }
    const runtimeKind = env.PLOINKY_RUNTIME;
    const ownsBwrapCredential = Object.prototype.hasOwnProperty.call(
        env,
        'PLOINKY_AGENT_CREDENTIAL_FILE',
    );
    const ownsContainerDescriptor = Object.prototype.hasOwnProperty.call(
        env,
        'PLOINKY_ROUTER_DESCRIPTOR_FILE',
    );

    if (runtimeKind === 'bwrap') {
        if (ownsContainerDescriptor) {
            invalidRuntime('bwrap runtime cannot admit a container Router descriptor');
        }
        return assertContext(createBwrapContext());
    }
    if (runtimeKind === 'container') {
        if (ownsBwrapCredential || !ownsContainerDescriptor) {
            invalidRuntime('container runtime requires only its signed Router descriptor transport');
        }
        return assertContext(createContainerContext(env));
    }
    invalidRuntime('runtime credential selection must be exact bwrap or container');
}

export default bootstrapAgentCredentialContext;
