import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from './nativeHelpers.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

function availableHostPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close((error) => {
                if (error) reject(error);
                else resolve(address.port);
            });
        });
    });
}

function treeHash(root) {
    const hash = crypto.createHash('sha256');
    function walk(directory, relative = '') {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name);
            const next = path.join(relative, name);
            const stat = fs.lstatSync(target);
            hash.update(`${next}\0${stat.mode}\0`);
            if (stat.isDirectory()) walk(target, next);
            else if (stat.isFile()) hash.update(fs.readFileSync(target));
            else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(target));
        }
    }
    walk(root);
    return hash.digest('hex');
}

function inBoxContentHash(containerId, harness) {
    return execInBox(harness.runner, containerId, [
        '/usr/local/bin/node', '-e', [
            "const c=require('node:crypto'),f=require('node:fs'),p=require('node:path');",
            "const h=c.createHash('sha256');",
            "function w(root,d=root){for(const n of f.readdirSync(d).sort()){const x=p.join(d,n),s=f.lstatSync(x);h.update(p.relative(root,x)+'\\0'+s.mode+'\\0');if(s.isDirectory())w(root,x);else if(s.isFile())h.update(f.readFileSync(x));else if(s.isSymbolicLink())h.update(f.readlinkSync(x));}}",
            "for(const root of ['/workspace','/opt/ploinky/node_modules']){h.update(root+'\\0');w(root)}",
            "process.stdout.write(h.digest('hex'));",
        ].join(''),
    ]);
}

function normalizeRuntimeInventory(inventory) {
    return String(inventory || '').split(/\r?\n/).filter(Boolean).map((line) => {
        let record;
        try {
            record = JSON.parse(line);
        } catch (_) {
            return line;
        }
        const isNetworkRecord = Object.hasOwn(record, 'network_interface')
            || Object.hasOwn(record, 'NetworkInterface');
        const networkName = String(record.name ?? record.Name ?? '');
        if (isNetworkRecord && networkName === 'podman') {
            // Podman synthesizes the default network when queried and reports
            // the query time as its creation time. Its stable ID and complete
            // semantic configuration remain mutation evidence; the generated
            // timestamp does not.
            delete record.created;
            delete record.Created;
            return JSON.stringify(record);
        }
        return line;
    }).join('\n');
}

function inBoxRuntimeInventory(containerId, harness) {
    return normalizeRuntimeInventory(execInBox(harness.runner, containerId, [
        'bash', '-c', [
            'podman container ls --all --no-trunc --format "{{json .}}"',
            'podman image ls --all --no-trunc --format "{{json .}}"',
            'podman volume ls --format "{{json .}}"',
            'podman network ls --format "{{json .}}"',
        ].map((command) => `${command} | LC_ALL=C sort`).join('; '),
    ]));
}

function shellQuote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function spawnWithPty(command, args, options) {
    const scriptArgs = process.platform === 'darwin'
        ? ['-q', '/dev/null', command, ...args]
        : ['-q', '-e', '-c', [command, ...args].map(shellQuote).join(' '), '/dev/null'];
    return spawnSync('script', scriptArgs, {
        ...options,
        // Node implements a piped stdin as a socketpair on macOS. BSD script
        // rejects that descriptor while copying terminal attributes, whereas
        // an ignored stdin is backed by /dev/null and lets script own the PTY.
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

test('runtime inventory ignores only the generated Podman default-network timestamp', () => {
    const defaultNetwork = {
        name: 'podman',
        id: 'stable-default-network-id',
        driver: 'bridge',
        network_interface: 'podman0',
        created: '2026-08-10T09:08:36.298131078Z',
    };
    const laterDefaultNetwork = {
        ...defaultNetwork,
        created: '2026-08-10T09:08:38.185953441Z',
    };
    assert.equal(
        normalizeRuntimeInventory(JSON.stringify(defaultNetwork)),
        normalizeRuntimeInventory(JSON.stringify(laterDefaultNetwork)),
    );

    const managedNetwork = { ...defaultNetwork, name: 'ploinky-managed-network' };
    const recreatedManagedNetwork = { ...laterDefaultNetwork, name: managedNetwork.name };
    assert.notEqual(
        normalizeRuntimeInventory(JSON.stringify(managedNetwork)),
        normalizeRuntimeInventory(JSON.stringify(recreatedManagedNetwork)),
    );
});

test('public status renders the core workspace view without mutating Box state', {
    timeout: 10 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const harness = createPodmanHarness(t, candidateReference);
    const prepared = await harness.supervisor.prepareBoxForCommand({
        explicitPort: await availableHostPort(),
        imageRef: candidateReference,
    });
    execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', '-e', [
            "const f=require('node:fs');",
            "f.mkdirSync('/workspace/.ploinky',{recursive:true});",
            "f.writeFileSync('/workspace/.ploinky/routing.json','{\"port\":8080}\\n');",
            "f.writeFileSync('/workspace/.ploinky/agents.json',JSON.stringify({",
            "ploinky_status_probe:{type:'agent',runtime:'podman',agentName:'statusProbe',",
            "repoName:'statusProbeRepo',containerImage:'status/probe:latest',",
            "createdAt:'2026-07-31T00:00:00.000Z',projectPath:'/workspace'}}));",
        ].join(''),
    ]);
    assert.equal(harness.supervisor.inspectBoxStatus().state, 'running-initialized');

    const hostBefore = treeHash(harness.workspace);
    const boxBefore = inBoxContentHash(prepared.containerId, harness);
    const runtimeBefore = inBoxRuntimeInventory(prepared.containerId, harness);
    const environment = {
        ...process.env,
        HOME: harness.lockHome,
        ...(harness.engineEnvironment.XDG_CONFIG_HOME
            ? { XDG_CONFIG_HOME: harness.engineEnvironment.XDG_CONFIG_HOME }
            : {}),
    };
    delete environment.NO_COLOR;
    delete environment.PLOINKY_COLOR;
    const status = spawnSync(path.join(repositoryRoot, 'bin/ploinky'), ['status'], {
        cwd: harness.child,
        encoding: 'utf8',
        env: environment,
        timeout: 120_000,
    });

    assert.equal(status.error, undefined, status.error?.message);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Workspace status:/);
    assert.match(status.stdout, /Agent runtimes:/);
    assert.doesNotMatch(status.stdout, /^Ploinky Box:/m);
    assert.doesNotMatch(status.stdout, /\u001B\[/);

    const coloredStatus = spawnWithPty(path.join(repositoryRoot, 'bin/ploinky'), ['status'], {
        cwd: harness.child,
        encoding: 'utf8',
        env: environment,
        timeout: 120_000,
    });
    assert.equal(coloredStatus.error, undefined, coloredStatus.error?.message);
    assert.equal(coloredStatus.status, 0, coloredStatus.stderr);
    assert.ok(coloredStatus.stdout.includes(
        '\u001B[1m\u001B[36mWorkspace status:\u001B[0m',
    ));
    assert.ok(coloredStatus.stdout.includes('\u001B[90m\u2022\u001B[0m'));
    assert.ok(coloredStatus.stdout.includes('\u001B[36mploinky_status_probe\u001B[0m'));

    const noColorStatus = spawnWithPty(path.join(repositoryRoot, 'bin/ploinky'), ['status'], {
        cwd: harness.child,
        encoding: 'utf8',
        env: { ...environment, NO_COLOR: '1' },
        timeout: 120_000,
    });
    assert.equal(noColorStatus.error, undefined, noColorStatus.error?.message);
    assert.equal(noColorStatus.status, 0, noColorStatus.stderr);
    assert.doesNotMatch(noColorStatus.stdout, /\u001B\[/);
    assert.match(noColorStatus.stdout, /^  - ploinky_status_probe/m);
    assert.doesNotMatch(noColorStatus.stdout, /\u2022/);

    assert.equal(treeHash(harness.workspace), hostBefore);
    assert.equal(inBoxContentHash(prepared.containerId, harness), boxBefore);
    assert.equal(inBoxRuntimeInventory(prepared.containerId, harness), runtimeBefore);
});
