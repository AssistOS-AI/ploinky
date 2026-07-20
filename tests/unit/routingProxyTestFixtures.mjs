export const CONTAINER_ID = 'a'.repeat(64);
export const AGENT_SECRET = Buffer.alloc(32, 7);

export function routingState(overrides = {}) {
    const routeOverrides = overrides.route || {};
    return {
        surfaces: {
            public: { authority: '127.0.0.1:8080' },
            private: { authority: '127.0.0.1:8081' },
        },
        routes: {
            alpha: {
                agent: 'alpha',
                repo: 'test',
                effectiveInstanceId: 'alpha-instance-1',
                enableGeneration: 'alpha-enable-1',
                relay: {
                    kind: 'container-exec-stdio',
                    runtime: 'podman',
                    containerId: CONTAINER_ID,
                    containerName: 'ploinky-alpha',
                    targetAgentId: 'agent:test/alpha',
                    effectiveInstanceId: 'alpha-instance-1',
                    networkMode: 'bridge',
                },
                deniedPorts: [22, 8081],
                primaryService: { port: 7000 },
                ...routeOverrides,
            },
        },
        privateCallerAcls: {
            alpha: [{
                callerAgentId: 'agent:test/alpha',
                port: 7000,
                method: 'POST',
                path: '/alpha/control',
            }],
        },
        ...overrides.routing,
    };
}
export function generationInput(overrides = {}) {
    const routing = routingState(overrides);
    return {
        routingBytes: Buffer.from(JSON.stringify(routing)),
        policyBytes: Buffer.from(JSON.stringify(overrides.policy || { entries: [] })),
        publicAuthority: '127.0.0.1:8080',
        privateAuthority: '127.0.0.1:8081',
    };
}
