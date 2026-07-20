import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    CloudflarePublicationApiClient,
} from '../../cli/sandbox/cloudflarePublicationApi.js';
import {
    buildCloudflaredArguments,
    createCloudflaredConnector,
} from '../../cli/sandbox/cloudflarePublicationConnector.js';
import {
    createCloudflarePublicationJournal,
} from '../../cli/sandbox/cloudflarePublicationJournal.js';

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cloudflare-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

class FakeChild extends EventEmitter {
    constructor(pid = 4242) {
        super();
        this.pid = pid;
        this.exitCode = null;
        this.signalCode = null;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
    }

    kill(signal) {
        this.signalCode = signal;
        queueMicrotask(() => this.emit('exit', null, signal));
        return true;
    }
}

test('cloudflared connector uses only an ephemeral 0600 token file and minimal environment', async (t) => {
    const runtimeDirectory = temporaryDirectory(t);
    const token = 'connector-token-value';
    const calls = [];
    const output = [];
    const exits = [];
    const child = new FakeChild();
    const connector = createCloudflaredConnector({
        runtimeDirectory,
        environment: {
            PATH: '/test/bin',
            SSL_CERT_FILE: '/certs/ca.pem',
            PLOINKY_MASTER_KEY: 'must-not-leak',
            CLOUDFLARE_API_TOKEN: 'must-not-leak-either',
        },
        spawnImpl(binary, args, options) {
            calls.push({ binary, args: [...args], options: { ...options, env: { ...options.env } } });
            const tokenFile = args.at(-1);
            assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
            assert.equal(fs.readFileSync(tokenFile, 'utf8'), `${token}\n`);
            return child;
        },
    });
    const handle = await connector.start({
        tunnelToken: token,
        onOutput: (entry) => output.push(entry),
        onExit: (entry) => exits.push(entry),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].binary, 'cloudflared');
    assert.deepEqual(calls[0].args.slice(0, -1), ['tunnel', '--no-autoupdate', 'run', '--token-file']);
    assert.doesNotMatch(JSON.stringify(calls[0].args), new RegExp(token));
    assert.deepEqual(calls[0].options.env, {
        PATH: '/test/bin',
        SSL_CERT_FILE: '/certs/ca.pem',
    });
    assert.equal(calls[0].options.shell, false);
    child.stderr.write('connector failed with connector-');
    child.stderr.write('token-value Bearer another-');
    child.stderr.write('secret\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(output.length, 1);
    assert.doesNotMatch(output[0].message, /connector-token-value|another-secret/);
    await handle.stop();
    assert.equal(exits.length, 1);
    assert.equal(exits[0].intentional, true);
    assert.deepEqual(fs.readdirSync(runtimeDirectory), []);
});

test('cloudflared command surface contains no quick tunnel, tunnel creation, token argv, or origin override', () => {
    const args = buildCloudflaredArguments('/run/ploinky/cloudflared/token');
    const serialized = args.join(' ');
    assert.equal(serialized, 'tunnel --no-autoupdate run --token-file /run/ploinky/cloudflared/token');
    assert.doesNotMatch(serialized, /quick|create|--token(?:\s|=)|127\.0\.0\.1|8080/);
    assert.throws(() => buildCloudflaredArguments('relative-token'));
});

test('journal is atomic, mode 0600, and contains only non-secret reconciliation data', (t) => {
    const root = temporaryDirectory(t);
    const journal = createCloudflarePublicationJournal({ workspaceRoot: root });
    const written = journal.write({
        mode: 'cloudflare',
        configurationGeneration: `sha256:${'a'.repeat(64)}`,
        desiredDigest: `sha256:${'b'.repeat(64)}`,
        phase: 'dns-reconciled',
        scope: { accountId: 'account', zoneId: 'zone', tunnelId: 'tunnel' },
        ingressDigest: `sha256:${'c'.repeat(64)}`,
        managedDnsRecords: [{
            hostname: 'office.example.test',
            recordId: 'record-1',
            zoneId: 'zone',
            content: 'tunnel.cfargotunnel.com',
        }],
        lastError: null,
    });
    assert.deepEqual(journal.read(), written);
    assert.equal(fs.statSync(journal.path).mode & 0o777, 0o600);
    const raw = fs.readFileSync(journal.path, 'utf8');
    assert.doesNotMatch(raw, /TokenSecret|apiToken|connectorToken|publication\/cloudflare/);
});

test('corrupt and symlinked reconciliation journals fail closed', (t) => {
    const root = temporaryDirectory(t);
    const journal = createCloudflarePublicationJournal({ workspaceRoot: root });
    fs.mkdirSync(path.dirname(journal.path), { recursive: true });
    fs.writeFileSync(journal.path, '{truncated', { mode: 0o600 });
    assert.throws(() => journal.read(), (error) => error.code === 'CLOUDFLARE_JOURNAL_CORRUPT');
    fs.unlinkSync(journal.path);
    const target = path.join(root, 'outside.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, journal.path);
    assert.throws(() => journal.read(), (error) => error.code === 'CLOUDFLARE_JOURNAL_CORRUPT');
});

test('API client validates exact account/tunnel/zone scope without exposing tunnel creation', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        let result;
        if (url.endsWith('/user/tokens/verify')) result = { status: 'active' };
        else if (url.includes('/cfd_tunnel/tunnel_123') && !url.endsWith('/configurations')) {
            result = { id: 'tunnel_123', account_tag: 'account_123', deleted_at: null };
        } else if (url.endsWith('/zones/zone_123')) {
            result = { id: 'zone_123', account: { id: 'account_123' } };
        } else throw new Error(`unexpected URL ${url}`);
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ success: true, result }),
        };
    };
    const api = new CloudflarePublicationApiClient({ fetchImpl, baseUrl: 'https://api.example.test' });
    await api.validateScope({
        apiToken: 'api-token',
        accountId: 'account_123',
        zoneId: 'zone_123',
        tunnelId: 'tunnel_123',
    });
    assert.equal(typeof api.createTunnel, 'undefined');
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer api-token'));
    assert.ok(calls.some((call) => call.url.includes('/accounts/account_123/cfd_tunnel/tunnel_123')));
    assert.ok(calls.some((call) => call.url.endsWith('/zones/zone_123')));
});

test('API errors identify the failed capability while redacting the API token', async () => {
    const apiToken = 'api-secret-value';
    const api = new CloudflarePublicationApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () => ({
            ok: false,
            status: 403,
            text: async () => JSON.stringify({
                success: false,
                errors: [{ code: 10000, message: `permission denied for ${apiToken}` }],
            }),
        }),
    });
    await assert.rejects(
        api.readZone({ apiToken, zoneId: 'zone' }),
        (error) => {
            assert.equal(error.operation, 'read-zone');
            assert.doesNotMatch(error.message, new RegExp(apiToken));
            assert.match(error.message, /permission denied/);
            return true;
        },
    );
});

test('DNS listing queries the exact hostname across all record types before mutation', async () => {
    let capturedUrl = '';
    const api = new CloudflarePublicationApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async (url) => {
            capturedUrl = url;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ success: true, result: [] }),
            };
        },
    });
    await api.listDnsRecords({ apiToken: 'api-token', zoneId: 'zone', hostname: 'office.example.test' });
    const url = new URL(capturedUrl);
    assert.equal(url.searchParams.get('name'), 'office.example.test');
    assert.equal(url.searchParams.has('type'), false);
});
