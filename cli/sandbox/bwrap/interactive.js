import { spawn } from 'node:child_process';

import { AGENT_CREDENTIAL_MAX_BYTES } from '../../../Agent/lib/agentCredentialDescriptor.mjs';
import { resolveInteractiveSpawnResult } from '../interactiveProcess.js';

function interactiveError(code, message, cause) {
    const error = new Error(message, cause instanceof Error ? { cause } : undefined);
    error.code = code;
    return error;
}

/**
 * Launch an interactive outer sandbox through the immutable privileged helper.
 * Descriptor and credential bytes cross dedicated pipes only; the helper then
 * execs its fd-pinned inner bwrap with the caller's terminal streams inherited.
 */
export function spawnTrustedInteractiveLaunch(launch, credentialBytes, {
    assertHelper,
    spawnProcess = spawn,
    killProcess = (pid, signal) => process.kill(pid, signal),
} = {}) {
    if (!launch || typeof launch !== 'object'
        || typeof launch.helperPath !== 'string'
        || !Buffer.isBuffer(launch.descriptor)
        || launch.descriptor.subarray(0, 8).toString('ascii') !== 'PLBWLP02') {
        throw interactiveError(
            'PLOINKY_BWRAP_PROTOCOL_INVALID',
            'trusted interactive launch descriptor is missing or invalid',
        );
    }
    if (!Buffer.isBuffer(credentialBytes)
        || credentialBytes.length < 1
        || credentialBytes.length > AGENT_CREDENTIAL_MAX_BYTES) {
        if (Buffer.isBuffer(credentialBytes)) credentialBytes.fill(0);
        throw interactiveError(
            'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
            'trusted interactive credential bytes are missing or out of bounds',
        );
    }
    if (typeof assertHelper !== 'function') {
        credentialBytes.fill(0);
        throw interactiveError(
            'PLOINKY_BWRAP_HELPER_INVALID',
            'trusted interactive launch requires helper provenance validation',
        );
    }
    try {
        assertHelper();
    } catch (error) {
        credentialBytes.fill(0);
        throw error;
    }

    let child;
    try {
        child = spawnProcess(launch.helperPath, [], {
            detached: false,
            stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
        });
    } catch (error) {
        credentialBytes.fill(0);
        throw interactiveError(
            'PLOINKY_BWRAP_SPAWN_FAILED',
            'trusted interactive helper could not be spawned',
            error,
        );
    }

    const terminateChild = () => {
        if (!Number.isSafeInteger(child?.pid) || child.pid < 1) return;
        try { killProcess(child.pid, 'SIGKILL'); } catch (_) { }
    };
    const descriptorPipe = child?.stdio?.[3];
    const credentialPipe = child?.stdio?.[4];
    if (!child || typeof child.once !== 'function'
        || !descriptorPipe || typeof descriptorPipe.once !== 'function' || typeof descriptorPipe.end !== 'function'
        || !credentialPipe || typeof credentialPipe.once !== 'function' || typeof credentialPipe.end !== 'function') {
        credentialBytes.fill(0);
        terminateChild();
        throw interactiveError(
            'PLOINKY_BWRAP_PIPE_FAILED',
            'trusted interactive descriptor and credential pipes were not created',
        );
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let credentialCleared = false;
        const clearCredential = () => {
            if (credentialCleared) return;
            credentialCleared = true;
            credentialBytes.fill(0);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearCredential();
            terminateChild();
            reject(error?.code ? error : interactiveError(
                'PLOINKY_BWRAP_PIPE_FAILED',
                'trusted interactive helper transport failed',
                error instanceof Error ? error : undefined,
            ));
        };
        child.once('error', (error) => fail(interactiveError(
            'PLOINKY_BWRAP_SPAWN_FAILED',
            'trusted interactive helper failed to start',
            error,
        )));
        descriptorPipe.once('error', fail);
        credentialPipe.once('error', fail);
        child.once('exit', (status, signal) => {
            if (settled) return;
            settled = true;
            clearCredential();
            try {
                resolve(resolveInteractiveSpawnResult(
                    { status, signal },
                    { label: 'trusted bwrap interactive session' },
                ));
            } catch (error) {
                reject(error);
            }
        });
        try {
            descriptorPipe.end(launch.descriptor);
            credentialPipe.end(credentialBytes, (error) => {
                clearCredential();
                if (error) fail(error);
            });
        } catch (error) {
            fail(error);
        }
    });
}
