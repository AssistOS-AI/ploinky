import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    createCloudflaredRouterIntegration,
} from '../../ploinky-box/cloudflared/routerIntegration.mjs';

function harness() {
    const events = [];
    let starts = 0;
    let stops = 0;
    let releaseStop;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const status = {
        mode: 'cloudflare',
        management: 'connector-only',
        state: 'ready',
        connectorState: 'running',
        configurationGeneration: `sha256:${'a'.repeat(64)}`,
        desiredDigest: `sha256:${'b'.repeat(64)}`,
        hostnames: ['app.example.test'],
    };
    const integration = createCloudflaredRouterIntegration({
        audit: (event, value) => events.push({ event, value }),
        runtimeFactory: () => {
            starts += 1;
            return {
                getStatus: () => status,
                async stop() {
                    stops += 1;
                    await stopGate;
                },
            };
        },
    });
    return {
        integration,
        events,
        status,
        get starts() { return starts; },
        get stops() { return stops; },
        releaseStop,
    };
}

test('starts once after public then private listener readiness', () => {
    const fixture = harness();
    fixture.integration.markPublicListenerReady();
    assert.equal(fixture.starts, 0);
    fixture.integration.markPrivateListenerReady();
    assert.equal(fixture.starts, 1);
});

test('starts once after private then public listener readiness', () => {
    const fixture = harness();
    fixture.integration.markPrivateListenerReady();
    assert.equal(fixture.starts, 0);
    fixture.integration.markPublicListenerReady();
    assert.equal(fixture.starts, 1);
});

test('repeated readiness notifications never start another runtime', () => {
    const fixture = harness();
    fixture.integration.markPrivateListenerReady();
    fixture.integration.markPublicListenerReady();
    fixture.integration.markPrivateListenerReady();
    fixture.integration.markPublicListenerReady();
    assert.equal(fixture.starts, 1);
});

test('construction failure is redacted and does not escape listener notification', () => {
    const audits = [];
    const integration = createCloudflaredRouterIntegration({
        audit: (event, value) => audits.push({ event, value }),
        runtimeFactory() {
            throw Object.assign(new Error('secret-value'), {
                code: 'CLOUDFLARE_FIXTURE_FAILURE',
                retryable: true,
            });
        },
    });
    integration.markPublicListenerReady();
    integration.markPrivateListenerReady();
    const serialized = JSON.stringify({ status: integration.getStatus(), audits });
    assert.doesNotMatch(serialized, /secret-value/);
    assert.equal(integration.getStatus().state, 'error');
    assert.equal(integration.getStatus().error.code, 'CLOUDFLARE_FIXTURE_FAILURE');

    const unsafeAudits = [];
    const unsafe = createCloudflaredRouterIntegration({
        audit: (event, value) => unsafeAudits.push({ event, value }),
        runtimeFactory() {
            throw Object.assign(new Error('must-not-cross'), {
                code: 'secret-token-value',
            });
        },
    });
    unsafe.markPublicListenerReady();
    unsafe.markPrivateListenerReady();
    assert.doesNotMatch(
        JSON.stringify({ status: unsafe.getStatus(), audits: unsafeAudits }),
        /must-not-cross|secret-token-value/,
    );
});

test('status forwards only the safe runtime contract', () => {
    const fixture = harness();
    fixture.status.secret = 'must-not-cross';
    fixture.integration.markPublicListenerReady();
    fixture.integration.markPrivateListenerReady();
    assert.equal(fixture.integration.getStatus().state, 'ready');
    assert.equal(JSON.stringify(fixture.integration.getStatus()).includes('must-not-cross'), false);
});

test('stop before start is safe and prevents a later start', async () => {
    const fixture = harness();
    await fixture.integration.stop();
    fixture.integration.markPublicListenerReady();
    fixture.integration.markPrivateListenerReady();
    assert.equal(fixture.starts, 0);
    assert.equal(fixture.integration.getStatus().state, 'stopped');
});

test('stop is idempotent and every caller awaits the same runtime stop', async () => {
    const fixture = harness();
    fixture.integration.markPublicListenerReady();
    fixture.integration.markPrivateListenerReady();
    const first = fixture.integration.stop();
    const second = fixture.integration.stop();
    assert.equal(first, second);
    assert.equal(fixture.stops, 1);
    let completed = false;
    first.then(() => { completed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    fixture.releaseStop();
    await Promise.all([first, second]);
    assert.equal(completed, true);
    assert.equal(fixture.integration.getStatus().state, 'stopped');
});

test('RoutingServer is a thin facade consumer and stops publication before listeners', () => {
    const source = fs.readFileSync(path.resolve(
        import.meta.dirname,
        '../../cli/server/RoutingServer.js',
    ), 'utf8');
    assert.match(source, /ploinky-box\/cloudflared\/index\.mjs/);
    assert.doesNotMatch(source, /startCloudflarePublicationRuntime|maybeStartCloudflarePublicationRuntime/);
    assert.doesNotMatch(source, /publicListenerReady|privateListenerReady/);
    assert.equal(
        source.match(/cloudflaredRouterIntegration\.markPublicListenerReady\(\)/g)?.length,
        1,
    );
    assert.equal(
        source.match(/cloudflaredRouterIntegration\.markPrivateListenerReady\(\)/g)?.length,
        1,
    );
    const stop = source.indexOf('await cloudflaredRouterIntegration.stop()');
    const privateClose = source.indexOf('await privateListenerSet.close()');
    assert.ok(stop >= 0 && stop < privateClose);
});
