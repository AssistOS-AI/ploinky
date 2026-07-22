import { execFile as nodeExecFile } from 'node:child_process';

function executeProof(command, args, options, execFile) {
    return new Promise((resolve, reject) => {
        execFile(command, args, options, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

export async function proveContainerLoopbackBinding({
    runtime,
    containerId,
    hostAlias,
    port,
    proofPath,
    expectedBody,
    execFile = nodeExecFile,
} = {}) {
    if (!['podman', 'docker'].includes(runtime)) throw new Error('privateListenerBinding: unsupported runtime');
    if (!/^[a-f0-9]{64}$/.test(String(containerId || ''))) throw new Error('privateListenerBinding: immutable container id required');
    if (!['host.containers.internal', 'host.docker.internal'].includes(hostAlias)) {
        throw new Error('privateListenerBinding: runtime-owned host alias required');
    }
    const script = [
        "const http=require('http')",
        "const u=process.argv[1]",
        "http.get(u,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{process.stdout.write(b);process.exit(r.statusCode===200?0:2)})}).on('error',()=>process.exit(3))",
    ].join(';');
    const url = `http://${hostAlias}:${Number(port)}${String(proofPath || '/')}`;
    const body = await executeProof(runtime, ['exec', containerId, 'node', '-e', script, url], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
    }, execFile);
    if (String(body) !== String(expectedBody)) throw new Error('privateListenerBinding: loopback proof mismatch');
    return true;
}

export default proveContainerLoopbackBinding;
