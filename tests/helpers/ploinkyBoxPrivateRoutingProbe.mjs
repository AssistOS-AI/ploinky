#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

import {
    classifyPrivateListenerRequest,
    createPrivateListenerSet,
} from '../../cli/server/privateListenerSet.js';

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
        killSignal: 'SIGKILL',
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

const nestedPrivateRequestScript = [
    "const h=require('node:http');",
    "const u=process.argv[1];",
    "const q=h.get(u,r=>{let b='';r.setEncoding('utf8');r.on('data',c=>b+=c);r.on('end',()=>{process.stdout.write(b);process.exit(r.statusCode===200?0:2)});});",
    "q.setTimeout(4000,()=>q.destroy(new Error('timeout')));",
    "q.on('error',()=>process.exit(3));",
].join('');

function executeNestedPrivateRequest(containerId, url) {
    return new Promise((resolve) => {
        execFile('podman', [
            'container', 'exec', containerId,
            'node', '-e', nestedPrivateRequestScript, url,
        ], {
            encoding: 'utf8',
            timeout: 5_000,
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024,
        }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
}

const evidence = {
    kind: 'ploinky-box-private-routing-probe',
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

let listenerSet;
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

    const privateBind = String(process.env.PLOINKY_PRIVATE_BIND || '');
    if (privateBind !== '0.0.0.0') {
        throw new Error('private-routing probe requires the Box wildcard private-listener bind');
    }
    const proofPath = `/.well-known/ploinky-private-proof/${crypto.randomBytes(18).toString('base64url')}`;
    const expectedBody = crypto.randomBytes(18).toString('base64url');
    const privateServer = http.createServer((request, response) => {
        if (classifyPrivateListenerRequest(request) !== 'private') {
            response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ error: 'private_listener_required' }));
            return;
        }
        if (request.method === 'GET' && request.url === proofPath) {
            response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            response.end(expectedBody);
            return;
        }
        response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: 'proof_only' }));
    });
    const interfaceClassifier = Object.freeze({
        refresh: async () => Object.freeze({ gateways: Object.freeze([]), lastError: '' }),
        snapshot: () => Object.freeze({ gateways: Object.freeze([]), lastError: '' }),
        classify: () => 'unmanaged',
    });
    listenerSet = createPrivateListenerSet({
        httpServer: privateServer,
        interfaceClassifier,
        port: 8081,
        wildcardHost: true,
    });
    const listenerSnapshot = await listenerSet.start();
    evidence.listener = {
        addresses: listenerSnapshot.addresses,
        port: listenerSnapshot.port,
        privateBind,
    };
    if (JSON.stringify(listenerSnapshot.addresses) !== JSON.stringify(['0.0.0.0'])
        || listenerSnapshot.port !== 8081) {
        throw new Error('private-routing probe did not bind the exact Box wildcard listener');
    }
    evidence.box.listeningSockets = commandText('ss', ['-ltnup']);
    const startedAt = Date.now();
    const requestResult = await executeNestedPrivateRequest(
        nestedContainerId,
        `http://host.containers.internal:8081${proofPath}`,
    );
    evidence.privateRequest.elapsedMs = Date.now() - startedAt;
    evidence.privateRequest.exitCode = requestResult.error
        ? (Number.isInteger(requestResult.error.code) ? requestResult.error.code : null)
        : 0;
    evidence.privateRequest.signal = requestResult.error?.signal || null;
    evidence.privateRequest.responseMatched = String(requestResult.stdout) === expectedBody;
    evidence.privateRequest.stderr = String(requestResult.stderr || '').trim();
    if (requestResult.error) throw requestResult.error;
    if (!evidence.privateRequest.responseMatched) {
        throw new Error('private-routing application proof response did not match');
    }
    evidence.privateRequest.ok = true;
} catch (error) {
    evidence.error = error?.message || String(error);
    process.exitCode = 1;
} finally {
    if (listenerSet) await listenerSet.close();
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
}
