#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { createPrivateListener } from '../../cli/server/privateListener.js';
import { proveContainerLoopbackBinding } from '../../cli/server/privateListenerBindings/containerLoopbackBinding.js';

const nestedContainerId = String(process.argv[2] || '');
const networkArguments = JSON.parse(String(process.argv[3] || '[]'));

if (!/^[a-f0-9]{64}$/.test(nestedContainerId)) {
    throw new Error('private-routing probe requires one immutable nested container ID');
}
if (!Array.isArray(networkArguments) || networkArguments.some((value) => typeof value !== 'string')) {
    throw new Error('private-routing probe requires exact string network arguments');
}

function commandText(command, args, options = {}) {
    return String(execFileSync(command, args, {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        ...options,
    })).trim();
}

function commandJson(command, args, options = {}) {
    return JSON.parse(commandText(command, args, options));
}

function selectedPodmanInfo(info) {
    const host = info?.host || info?.Host || {};
    return {
        networkBackend: host.networkBackend || host.NetworkBackend || '',
        rootless: host.security?.rootless ?? host.Security?.Rootless ?? null,
        architecture: host.arch || host.Arch || '',
        operatingSystem: host.os || host.Os || '',
    };
}

function pastaProcessArguments(fsApi = fs) {
    const processes = [];
    for (const entry of fsApi.readdirSync('/proc', { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        try {
            const argv = fsApi.readFileSync(`/proc/${entry.name}/cmdline`, 'utf8')
                .split('\0')
                .filter(Boolean);
            if (argv.some((argument) => /(?:^|\/)pasta$/.test(argument))) {
                processes.push(argv);
            }
        } catch {}
    }
    return processes;
}

const nestedNetworkScript = [
    "const d=require('node:dns'),f=require('node:fs'),o=require('node:os');",
    "const result={hosts:f.readFileSync('/etc/hosts','utf8'),networkInterfaces:o.networkInterfaces(),ipv4Routes:f.readFileSync('/proc/net/route','utf8')};",
    "const timer=setTimeout(()=>{result.resolution={error:'timeout'};process.stdout.write(JSON.stringify(result));},4000);",
    "d.lookup('host.containers.internal',{all:true},(error,addresses)=>{clearTimeout(timer);result.resolution=error?{error:error.code||error.message}:{addresses};process.stdout.write(JSON.stringify(result));});",
].join('');

const evidence = {
    schema: 1,
    networkArguments,
    box: {},
    nestedPodman: {},
    nestedContainer: {},
    privateRequest: {
        method: 'GET',
        endpoint: 'http://host.containers.internal:8081/.well-known/ploinky-private-proof/<redacted>',
        timeoutMs: 5_000,
        ok: false,
    },
};

let listener;
try {
    evidence.box.addresses = commandJson('ip', ['-j', '-4', 'address', 'show']);
    evidence.box.routes = commandJson('ip', ['-j', '-4', 'route', 'show']);
    evidence.nestedPodman.version = commandJson('podman', ['version', '--format', 'json']);
    evidence.nestedPodman.info = selectedPodmanInfo(
        commandJson('podman', ['info', '--format', 'json']),
    );
    evidence.nestedPodman.pastaProcesses = pastaProcessArguments();
    const nestedInspection = commandJson('podman', ['container', 'inspect', nestedContainerId])[0];
    evidence.nestedContainer.inspect = {
        id: String(nestedInspection?.Id || ''),
        image: String(nestedInspection?.Image || ''),
        networkMode: String(nestedInspection?.HostConfig?.NetworkMode || ''),
        networkSettings: nestedInspection?.NetworkSettings || {},
    };
    evidence.nestedContainer.namespace = commandJson('podman', [
        'container', 'exec', nestedContainerId,
        'node', '-e', nestedNetworkScript,
    ]);

    listener = await createPrivateListener({
        host: String(process.env.PLOINKY_PRIVATE_BIND || '127.0.0.1'),
        handler: (_request, response) => {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'proof_only' }));
        },
        proveBinding: async (proof) => {
            evidence.box.listeningSockets = commandText('ss', ['-ltnup']);
            const startedAt = Date.now();
            const captureExecFile = (command, args, options, callback) => {
                execFile(command, args, options, (error, stdout, stderr) => {
                    evidence.privateRequest.elapsedMs = Date.now() - startedAt;
                    evidence.privateRequest.exitCode = error
                        ? (Number.isInteger(error.code) ? error.code : null)
                        : 0;
                    evidence.privateRequest.signal = error?.signal || null;
                    evidence.privateRequest.responseMatched = String(stdout) === String(proof.expectedBody);
                    evidence.privateRequest.stderr = String(stderr || '').trim();
                    callback(error, stdout, stderr);
                });
            };
            try {
                await proveContainerLoopbackBinding({
                    runtime: 'podman',
                    containerId: nestedContainerId,
                    hostAlias: 'host.containers.internal',
                    ...proof,
                    execFile: captureExecFile,
                });
                evidence.privateRequest.ok = true;
                return true;
            } catch (error) {
                evidence.privateRequest.error = error?.message || String(error);
                throw error;
            }
        },
    });
    evidence.listener = {
        address: listener.address(),
        privateBind: String(process.env.PLOINKY_PRIVATE_BIND || '127.0.0.1'),
    };
} catch (error) {
    evidence.error = error?.message || String(error);
    process.exitCode = 1;
} finally {
    if (listener) {
        await new Promise((resolve) => listener.close(resolve));
    }
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
}
