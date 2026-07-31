import path from 'node:path';

import {
    buildGeneratedRouterDescriptorEnv,
    createGeneratedRouterDescriptorPayload,
    signGeneratedRouterDescriptorEnvelope,
    writeGeneratedRouterDescriptorFile,
} from '../../cli/utils/security/generatedRouterDescriptor.js';
import {
    buildSubjectIdentityKey,
} from '../../cli/utils/security/subjectIdentityKey.js';

let sequence = 0;

export function installGeneratedRouterRuntime({
    origin,
    tempDir,
    agentPrincipal = 'agent:AssistOSExplorer/onlyOffice',
    publicAuthority = '127.0.0.1:19090',
    requestAuthority = publicAuthority,
    listenerClass = 'public',
} = {}) {
    const parsed = new URL(origin);
    sequence += 1;
    const payload = createGeneratedRouterDescriptorPayload({
        agentPrincipal,
        attestationId: `sha256:${'3'.repeat(64)}`,
        edgeTopologyFile: '/run/ploinky/edge-topology/current.json',
        generationId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
        instanceId: '11111111-2222-4333-8444-555555555555',
        internalRouterUrl: 'http://127.0.0.1:8081',
        issuedAtUnixMs: 1785456000000 + sequence,
        launchId: `bbbbbbbb-cccc-4ddd-8eee-${String(sequence).padStart(12, '0')}`,
        listenerClass,
        networkFingerprint: `sha256:${'1'.repeat(64)}`,
        physicalOrigin: parsed.origin,
        publicAuthority,
        requestAuthority,
        routerHost: parsed.hostname,
        routerPort: String(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
        runtimeProof: {
            backend: 'netavark',
            engine: 'podman',
            remote: false,
            rootless: true,
        },
        socketLocalAddressClass: listenerClass,
        topology: listenerClass === 'managed'
            ? 'native-linux-rootless-managed'
            : 'box-public-loopback',
    });
    const signed = signGeneratedRouterDescriptorEnvelope(payload);
    const descriptorFile = path.join(tempDir, `router-descriptor-${sequence}.json`);
    writeGeneratedRouterDescriptorFile(descriptorFile, signed.bytes);
    const env = {
        ...buildGeneratedRouterDescriptorEnv(payload, { descriptorFile }),
        PLOINKY_AGENT_API_PUBLIC_KEY: signed.publicKey,
        PLOINKY_AGENT_API_KEY: buildSubjectIdentityKey(agentPrincipal),
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY: 'generated',
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'generated',
    };
    Object.assign(process.env, env);
    return Object.freeze({ descriptorFile, env: Object.freeze(env), payload });
}
