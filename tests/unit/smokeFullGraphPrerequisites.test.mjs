import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
    new URL('../../container/smoke-runtime.mjs', import.meta.url),
    'utf8',
);

test('full-graph smoke requires an explicit safe media candidate and real operator Umami config', () => {
    assert.match(source, /SMOKE_EDGE_DESIRED_FILE/);
    assert.match(source, /SMOKE_MEDIA_PUBLIC_IPV4/);
    assert.match(source, /normalizePublicMediaIPv4\(configuredPublicIPv4\)/);
    assert.match(source, /must not duplicate manifest or HTTP route policy authority/);
    assert.match(source, /Cloudflare host\/DNS mutation belongs to the separately authorized external gate/);
    assert.match(source, /ploinky\(\['var', 'UMAMI_TELEMETRY_ALLOWED_ORIGINS', telemetryOrigin\]\)/);
    assert.match(source, /ploinky\(\['echo', '\$UMAMI_TELEMETRY_ALLOWED_ORIGINS'\]\)/);
    assert.doesNotMatch(
        source,
        /ENV\.UMAMI_TELEMETRY_ALLOWED_ORIGINS|UMAMI_TELEMETRY_ALLOWED_ORIGINS:\s*telemetryOrigin/,
    );
});

test('routing probe is removed before the strict full-graph listener inventory', () => {
    const cleanup = source.indexOf("ploinky(['shutdown'])");
    const fullGraph = source.indexOf('runConfiguredFullGraph();');
    assert.ok(cleanup > 0, 'smoke must remove the disposable routing probe');
    assert.ok(fullGraph > cleanup, 'probe cleanup must precede full Explorer startup and inventory');
    assert.match(source, /assertExactOuterBoundary\('post-routing-probe-removal'\)/);
});
