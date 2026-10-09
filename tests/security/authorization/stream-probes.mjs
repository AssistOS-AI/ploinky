import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertDenied, TARGET, WORKSPACE } from './core.mjs';

const deniedActors = ['anonymous', 'selfRegistered', 'userA', 'userB'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function terminalFixtureNames(prefix) {
  assert.match(prefix, /^authz-[a-z0-9-]{8,80}$/, 'Terminal fixture prefix must be a generated, shell-safe test identifier');
  const directory = `${prefix}-terminal`;
  // The Box terminal sees the workspace at the same absolute path as the host.
  const host = path.join(WORKSPACE, directory);
  return { directory, host, container: host };
}

export function markerCommand(prefix, marker) {
  const fixture = terminalFixtureNames(prefix);
  assert.match(marker, /^authz-[a-z0-9-]{8,100}$/, 'Marker must be a generated literal, never user-provided shell syntax');
  return `printf '%s\\n' '${marker}' > '${fixture.container}/marker.txt'\n`;
}

export async function registerDirectory(ctx) {
  const fixture = terminalFixtureNames(ctx.prefix);
  await ctx.guard();
  assert.equal(await fs.realpath(WORKSPACE), WORKSPACE);
  // Non-recursive exclusive creation: an existing path is never adopted.
  await fs.mkdir(fixture.host, { mode: 0o755 });
  assert.equal(await fs.realpath(fixture.host), fixture.host);
  ctx.cleanup(async () => {
    await ctx.guard();
    assert.equal(await fs.realpath(WORKSPACE), WORKSPACE);
    const info = await fs.lstat(fixture.host);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Fixture directory identity changed');
    assert.equal(await fs.realpath(fixture.host), fixture.host);
    assert.equal(path.dirname(fixture.host), WORKSPACE);
    assert.equal(path.basename(fixture.host), `${ctx.prefix}-terminal`);
    await fs.rm(fixture.host, { recursive: true, force: false });
  });
  return fixture;
}

async function waitForMarker(filename, expected) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try { if ((await fs.readFile(filename, 'utf8')).trim() === expected) return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(150);
  }
  return false;
}

async function runWorkspaceSelectorProbes(ctx, fixture) {
  const baseline = `${ctx.prefix}-workspace-marker`;
  const filename = path.join(fixture.host, 'fixture.txt');
  await ctx.guard();
  await fs.writeFile(filename, baseline, { flag: 'wx', mode: 0o644 });
  const resource = `/workspace-files/${fixture.directory}/fixture.txt`;
  const controls = new Set();
  for (const actor of ['admin', 'userA', 'userB']) await ctx.check(`router:workspace-file-fixture-positive:${actor}`, async () => {
    const response = await ctx.request(actor, { path: resource });
    assert.equal(response.status, 200, 'Existing workspace fixture must be readable by an authorized principal');
    assert.equal(response.text, baseline, 'Positive response must contain the actual fixture, not a fallback page');
    controls.add(actor);
  });
  if (!controls.has('admin') || !controls.has('userA') || !controls.has('userB')) {
    ctx.recordGap('router:workspace-file-selector-bypass', 'Existing fixture read positive controls failed; no selector-bypass denial is credited.', { kind: 'positive-unavailable' });
  } else {
    const selectors = ['', '?agent=authorization-suite-nonexistent', '?agent=userPersistoAgent'];
    for (const actor of ['anonymous', 'selfRegistered']) for (const selector of selectors) {
      await ctx.check(`router:workspace-file-selector-deny:${actor}:${selector || 'default'}`, async () => {
        const response = await ctx.request(actor, { path: resource + selector });
        const exposed = response.status === 200 && response.text === baseline;
        ctx.report.workspaceSelectorEvidence ||= [];
        ctx.report.workspaceSelectorEvidence.push({ actor, selector: selector || 'default', status: response.status, fixtureContentDisclosed: exposed });
        assertDenied(response);
        assert.equal(response.text.includes(baseline), false, 'Denied response must not disclose fixture content');
      });
    }
  }
  // The write matrix never depends on a read leak: it runs after a positive
  // write that changes and persists bytes, whatever the read probes found.
  await runWorkspaceWriteMatrix(ctx, fixture, filename);
}

const SINK_SELECTORS = ['default', 'authorization-suite-nonexistent', 'userPersistoAgent', 'webAssist', 'webmeetAgent'];
const SINK_DENIALS = [['anonymous', 'absent'], ['selfRegistered', 'absent'], ['selfRegistered', 'valid'], ['userA', 'absent'], ['userA', 'invalid']];
const WEBCHAT_SELECTORS = ['default', 'webAssist', 'webmeetAgent'];
const WEBCHAT_OPERATIONS = ['upload', 'directory-create', 'directory-list', 'suggestions'];
const WEBCHAT_UNSAFE_OPERATIONS = ['upload', 'directory-create'];

// The exact, fixed write-matrix identities. Denials and positives are listed
// here so the offline harness tests can pin the counts. Every denial names the
// one positive control that proves the same sink works for an entitled actor;
// the runtime gate and the mandatory-check enumerator both read this field, so
// they cannot drift apart. Every positive is itself a mandatory check.
export const WORKSPACE_WRITE_POSITIVE_FOR_OPERATION = Object.freeze({
  'sink-upload': 'router:workspace-upload-owner-positive:admin',
  upload: 'router:webchat-upload-positive:admin',
  'directory-create': 'router:webchat-directory-create-positive:admin',
  'directory-list': 'router:webchat-directory-list-positive:userA',
  suggestions: 'router:webchat-suggestions-positive:userA',
});

export function workspaceWriteMatrix() {
  const positives = [
    { id: 'router:workspace-upload-owner-positive:admin', operation: 'sink-upload', actor: 'admin', proof: 'valid', selector: 'default' },
    ...['default', 'userPersistoAgent'].map(selector => ({ id: `router:workspace-upload-positive:userA:valid:${selector}`, operation: 'sink-upload', actor: 'userA', proof: 'valid', selector })),
    { id: 'router:webchat-upload-positive:admin', operation: 'upload', actor: 'admin', proof: 'valid', selector: 'default' },
    { id: 'router:webchat-directory-create-positive:admin', operation: 'directory-create', actor: 'admin', proof: 'valid', selector: 'default' },
    { id: 'router:webchat-directory-list-positive:userA', operation: 'directory-list', actor: 'userA', proof: 'absent', selector: 'default' },
    { id: 'router:webchat-suggestions-positive:userA', operation: 'suggestions', actor: 'userA', proof: 'absent', selector: 'default' },
  ].map(row => ({ ...row, positiveControl: null }));
  const denials = [];
  for (const [actor, proof] of SINK_DENIALS) for (const selector of SINK_SELECTORS) {
    denials.push({ id: `router:workspace-upload-deny:${actor}:${proof}:${selector}`, operation: 'sink-upload', actor, proof, selector });
  }
  for (const operation of WEBCHAT_OPERATIONS) for (const actor of ['anonymous', 'selfRegistered']) for (const selector of WEBCHAT_SELECTORS) {
    // Unsafe operations send a valid-looking request; GET/HEAD reads never need proof.
    denials.push({ id: `router:webchat-${operation}-deny:${actor}:${selector}`, operation, actor, proof: WEBCHAT_UNSAFE_OPERATIONS.includes(operation) ? 'valid' : 'absent', selector });
  }
  for (const operation of WEBCHAT_UNSAFE_OPERATIONS) for (const proof of ['absent', 'invalid']) for (const selector of WEBCHAT_SELECTORS) {
    denials.push({ id: `router:webchat-${operation}-deny:userA:${proof}:${selector}`, operation, actor: 'userA', proof, selector });
  }
  return { positives, denials: denials.map(row => ({ ...row, positiveControl: WORKSPACE_WRITE_POSITIVE_FOR_OPERATION[row.operation] })) };
}

/** Mandatory-check definitions for the whole write matrix (68 checks, each recorded exactly once per run). */
export function workspaceWriteCheckDefinitions() {
  const { positives, denials } = workspaceWriteMatrix();
  const source = 'tests/security/authorization/stream-probes.mjs workspaceWriteMatrix';
  return [...positives, ...denials].map(row => ({ id: row.id, kind: 'live', boundary: 'router', source, positiveControlAnyOf: row.positiveControl ? [row.positiveControl] : null }));
}

function proofOptions(proof, nonce) {
  if (proof === 'valid') return { proof: true };
  if (proof === 'invalid') return { proof: false, headers: { origin: TARGET, 'x-ploinky-browser-csrf-token': `v2.authorization-suite-invalid-${nonce}` } };
  return { proof: false };
}

function selectorQuery(selector) {
  return selector === 'default' ? '' : `agent=${encodeURIComponent(selector)}`;
}

function joinQuery(base, selector) {
  const extra = selectorQuery(selector);
  if (!extra) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${extra}`;
}

export function workspaceWriteRequest(row, fixture, payload) {
  const options = proofOptions(row.proof, payload.slice(-12));
  const headers = { ...(options.headers || {}) };
  if (row.operation === 'sink-upload') {
    return { method: 'PUT', path: joinQuery(`/upload?path=${encodeURIComponent(`${fixture.directory}/fixture.txt`)}`, row.selector),
      body: payload, proof: options.proof, headers: { ...headers, 'content-type': 'text/plain' } };
  }
  if (row.operation === 'upload') {
    return { method: 'POST', path: joinQuery('/webchat/uploads', row.selector), body: payload, proof: options.proof,
      headers: { ...headers, 'content-type': 'text/plain', 'x-file-name': 'fixture.txt', 'x-destination-path': encodeURIComponent(fixture.directory), 'x-overwrite': '1' } };
  }
  if (row.operation === 'directory-create') {
    return { method: 'POST', path: joinQuery('/webchat/directories', row.selector), body: { path: `${fixture.directory}/${payload}` },
      proof: options.proof, headers };
  }
  if (row.operation === 'directory-list') {
    return { method: 'GET', path: joinQuery(`/webchat/directories?path=${encodeURIComponent(fixture.directory)}`, row.selector), headers };
  }
  return { method: 'GET', path: joinQuery(`/webchat/suggestions/files?query=${encodeURIComponent(`${fixture.directory}/fix`)}`, row.selector), headers };
}

// Keys under which a workspace read returns directory entries or file contents.
const LISTING_KEY = /^(entries|files|items|children|listing|directories|dirs|suggestions|results|contents?)$/i;
const ENTRY_KEY = /^(name|path|filename|type|isDirectory|size)$/;

/**
 * A denied request must not disclose the workspace. The Router's generic 401
 * (authContext.js respondUnauthenticated) legitimately carries
 * `login: /auth/login?returnTo=<this request's own path>&agent=<route>`, so the
 * caller's own request target echoed there is not a disclosure and a substring
 * test for the fixture name cannot tell it from a leaked listing. The decision is
 * structural instead: the parsed body may not contain a listing-shaped key or an
 * array of entry-shaped objects, the fixture name or the fixture's bytes in any
 * value, and its `login` value must be the login page whose `returnTo` is exactly
 * `requestPath`. A body that is not JSON is judged on its whole text.
 */
export function assertNoWorkspaceDisclosure(response, { requestPath, fixtureName = 'fixture.txt', fixtureText = '' }) {
  const message = 'A denied request disclosed a workspace listing';
  const leaks = value => { const text = String(value); return text.includes(fixtureName) || (fixtureText.length >= 8 && text.includes(fixtureText)); };
  let body;
  try { body = JSON.parse(response.text); } catch { body = response.json; }
  if (body === null || typeof body !== 'object') {
    assert.equal(leaks(response.text ?? ''), false, message);
    return;
  }
  const walk = (node, key) => {
    if (Array.isArray(node)) {
      assert.equal(LISTING_KEY.test(key), false, `${message} (listing-shaped field ${key})`);
      assert.equal(node.some(item => item && typeof item === 'object' && Object.keys(item).some(name => ENTRY_KEY.test(name))), false, `${message} (directory-entry array)`);
      node.forEach(item => walk(item, key));
    } else if (node && typeof node === 'object') {
      assert.equal(LISTING_KEY.test(key), false, `${message} (listing-shaped field ${key})`);
      for (const [name, value] of Object.entries(node)) walk(value, name);
    } else if (typeof node === 'string' && key === 'login') {
      const url = new URL(node, 'http://router.invalid');
      assert.ok(url.origin === 'http://router.invalid' && url.pathname === '/auth/login', `${message} (login field is not the login page)`);
      assert.equal(url.searchParams.get('returnTo'), requestPath, `${message} (login returnTo is not this request's own path)`);
      url.searchParams.delete('returnTo');
      assert.equal(leaks(url.searchParams.toString()), false, message);
    } else {
      assert.equal(leaks(node ?? ''), false, message);
    }
  };
  walk(body, '');
}

async function fileSha(filename) {
  return createHash('sha256').update(await fs.readFile(filename)).digest('hex');
}

export async function runWorkspaceWriteMatrix(ctx, fixture, filename) {
  const { positives, denials } = workspaceWriteMatrix();
  const byId = new Map(positives.map(row => [row.id, row]));
  let counter = 0;
  const payload = label => `${ctx.prefix}-${label}-${++counter}`;
  let current = null;
  const passedPositives = new Set();
  ctx.report.workspaceWriteEvidence ||= [];

  async function positiveWrite(row) {
    let passed = false;
    await ctx.check(row.id, async () => {
      const body = payload(row.operation === 'upload' ? 'webchat-positive' : 'sink-positive');
      const before = await fileSha(filename);
      const response = await ctx.request(row.actor, workspaceWriteRequest(row, fixture, body));
      assert.ok([200, 201].includes(response.status), `Authorized write must succeed; got ${response.status}`);
      assert.equal(response.json?.ok, true);
      assert.equal(await fs.readFile(filename, 'utf8'), body, 'Authorized write must persist its own distinct bytes');
      const readBack = await ctx.request('admin', { path: `/workspace-files/${fixture.directory}/fixture.txt` });
      assert.equal(readBack.status, 200);
      assert.equal(readBack.text, body, 'Read-back must return the bytes just written');
      current = await fileSha(filename);
      assert.notEqual(current, before, 'Positive control must change the fixture bytes');
      ctx.report.workspaceWriteEvidence.push({ id: row.id, status: response.status, sha256: current });
      passed = true;
      passedPositives.add(row.id);
    });
    return passed;
  }

  async function denial(row) {
    if (!passedPositives.has(row.positiveControl)) {
      ctx.recordGap(row.id, 'positive-unavailable: the owning authorized write control did not change the fixture.', { kind: 'positive-unavailable' });
      return;
    }
    await ctx.check(row.id, async () => {
      const body = payload('deny');
      const request = workspaceWriteRequest(row, fixture, body);
      const fixtureText = await fs.readFile(filename, 'utf8');
      const response = await ctx.request(row.actor, request);
      const after = await fileSha(filename);
      const created = row.operation === 'directory-create'
        ? await fs.stat(path.join(fixture.host, body)).then(() => true, () => false)
        : false;
      const expected = current;
      // Each denial is judged on its own distinct payload; a leaking write
      // re-baselines the hash so later denials are not blamed for it.
      current = after;
      ctx.report.workspaceWriteEvidence.push({ id: row.id, status: response.status, fixtureChanged: after !== expected, directoryCreated: created });
      assert.equal(after, expected, 'A denied request changed the owned fixture bytes');
      assert.equal(created, false, 'A denied request created a workspace directory');
      assertNoWorkspaceDisclosure(response, { requestPath: request.path, fixtureText });
      assertDenied(response);
    });
  }

  await positiveWrite(byId.get('router:workspace-upload-owner-positive:admin'));
  for (const row of denials.filter(item => item.operation === 'sink-upload')) await denial(row);
  for (const selector of ['default', 'userPersistoAgent']) {
    await positiveWrite(byId.get(`router:workspace-upload-positive:userA:valid:${selector}`));
  }
  await positiveWrite(byId.get('router:webchat-upload-positive:admin'));
  const createRow = byId.get('router:webchat-directory-create-positive:admin');
  await ctx.check(createRow.id, async () => {
    const name = payload('directory-positive');
    const response = await ctx.request(createRow.actor, workspaceWriteRequest(createRow, fixture, name));
    assert.equal(response.status, 201, `Authorized directory creation must succeed; got ${response.status}`);
    assert.equal(response.json?.ok, true);
    assert.ok((await fs.stat(path.join(fixture.host, name))).isDirectory(), 'Authorized directory must exist');
    passedPositives.add(createRow.id);
  });
  for (const id of ['router:webchat-directory-list-positive:userA', 'router:webchat-suggestions-positive:userA']) {
    const row = byId.get(id);
    await ctx.check(id, async () => {
      const response = await ctx.request(row.actor, workspaceWriteRequest(row, fixture, ''));
      assert.equal(response.status, 200, `Authorized read must succeed without a mutation proof; got ${response.status}`);
      assert.ok(response.text.includes('fixture.txt'), 'Authorized read must return the fixture entry');
      passedPositives.add(id);
    });
  }
  for (const row of denials.filter(item => item.operation !== 'sink-upload')) await denial(row);
}

export async function runTerminalProbes(ctx, fixture) {
  let discoveryId;
  let terminalId;
  let discoveryClosed = false;
  let terminalClosed = false;
  let launch;
  let discoveryReady = false;
  async function containUnexpectedCreation(actor, response, kind) {
    const object = kind === 'discovery' ? response.json?.discovery : response.json?.session;
    if (response.status !== 201 || response.json?.ok !== true || !/^[A-Za-z0-9_-]{16,128}$/.test(object?.id)) return;
    // These IDs were returned by this probe's create against its own exclusive
    // directory/launch. Even an authorization failure must not leak resources.
    ctx.secrets.add(object.id);
    const resource = kind === 'discovery' ? 'target-discoveries' : 'sessions';
    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      let result = await ctx.request(actor, { method: 'DELETE', path: `/webtty/${resource}/${object.id}` });
      if (![200, 404].includes(result.status)) result = await ctx.request('admin', { method: 'DELETE', path: `/webtty/${resource}/${object.id}` });
      assert.ok([200, 404].includes(result.status), 'Unexpectedly created test-owned terminal resource must be closed');
      closed = true;
    };
    ctx.cleanup(cleanup);
    await ctx.check(`router:terminal-unexpected-${kind}-cleanup:${actor}`, cleanup);
  }
  await ctx.check('router:terminal-discovery-positive:admin', async () => {
    const response = await ctx.request('admin', { method: 'POST', path: '/webtty/target-discoveries', body: { dir: fixture.directory }, timeout: 30000 });
    if (response.status === 503) ctx.recordGap('router:terminal-backend', 'Administrator discovery returned 503; unavailable terminal functionality cannot count as authorization denial.', { kind: 'positive-unavailable' });
    assert.equal(response.status, 201, 'Administrator must discover real terminal targets in the disposable directory');
    assert.equal(response.json?.ok, true);
    const discovery = response.json.discovery;
    assert.ok(/^[A-Za-z0-9_-]{16,128}$/.test(discovery?.id), 'Valid test-owned discovery ID required');
    discoveryId = discovery.id;
    ctx.secrets.add(discoveryId);
    ctx.cleanup(async () => {
      if (discoveryClosed) return;
      const result = await ctx.request('admin', { method: 'DELETE', path: `/webtty/target-discoveries/${discoveryId}` });
      assert.ok([200, 404].includes(result.status), 'Only an already-known disposable discovery may be absent during cleanup');
      discoveryClosed = true;
    });
    const target = discovery.targets?.find(candidate => candidate.kind === 'box' && candidate.access === 'rw');
    assert.ok(target && /^[A-Za-z0-9_-]{32}$/.test(target.launch), 'A writable Ploinky Box target must exist; no optional robot tool backend is substituted');
    launch = target.launch;
    ctx.secrets.add(launch);
    discoveryReady = true;
  });
  if (!discoveryReady) {
    ctx.recordGap('router:terminal-session-probes', 'Positive target discovery did not complete; terminal stream/input/create denial coverage is unavailable.', { kind: 'positive-unavailable' });
    return;
  }
  for (const actor of deniedActors) await ctx.check(`router:terminal-discovery-deny:${actor}`, async () => {
    const response = await ctx.request(actor, { method: 'POST', path: '/webtty/target-discoveries', body: { dir: fixture.directory } });
    await containUnexpectedCreation(actor, response, 'discovery');
    assertDenied(response);
  });
  // Use the real unconsumed administrator launch as the denied create resource.
  for (const actor of deniedActors) await ctx.check(`router:terminal-create-deny:${actor}`, async () => {
    const response = await ctx.request(actor, { method: 'POST', path: '/webtty/sessions', body: { launch, cols: 80, rows: 24 } });
    await containUnexpectedCreation(actor, response, 'session');
    assertDenied(response);
  });
  let terminalReady = false;
  let launchConsumed = false;
  await ctx.check('router:terminal-create-positive:admin', async () => {
    const response = await ctx.request('admin', { method: 'POST', path: '/webtty/sessions', body: { launch, cols: 80, rows: 24 }, timeout: 30000 });
    if (response.status === 503) ctx.recordGap('router:terminal-backend', 'Administrator session creation returned 503; native runtime is unavailable.', { kind: 'positive-unavailable' });
    assert.equal(response.status, 201, 'Administrator must create the exact box terminal target');
    // Consuming a launch removes its whole discovery batch (cli/server/webtty/launchRecords.mjs, consume -> removeBatch).
    launchConsumed = true;
    assert.equal(response.json?.ok, true);
    assert.equal(response.json?.session?.target?.kind, 'box');
    terminalId = response.json?.session?.id;
    assert.match(terminalId || '', /^[A-Za-z0-9_-]{16,128}$/);
    ctx.secrets.add(terminalId);
    ctx.cleanup(async () => {
      if (terminalClosed) return;
      const result = await ctx.request('admin', { method: 'DELETE', path: `/webtty/sessions/${terminalId}` });
      assert.ok([200, 404].includes(result.status), 'Only known disposable terminal may be absent after automatic detach cleanup');
      terminalClosed = true;
    });
    terminalReady = true;
  });
  if (!terminalReady) {
    ctx.recordGap('router:terminal-existing-session-probes', 'Positive session creation failed; no existing terminal is available to prove stream/input/resize/delete denials.', { kind: 'positive-unavailable' });
    return;
  }
  const streamPath = `/webtty/sessions/${terminalId}/stream`;
  async function livePositiveStream() {
    const response = await ctx.request('admin', { path: streamPath, stream: true });
    assert.equal(response.status, 200, 'Administrator must still own a live terminal before negative probe');
    assert.match(String(response.headers['content-type']), /^text\/event-stream/);
  }
  await ctx.check('router:terminal-sse-positive:admin', livePositiveStream);
  let resizeReady = false;
  await ctx.check('router:terminal-resize-positive:admin', async () => {
    await livePositiveStream();
    const response = await ctx.request('admin', { method: 'POST', path: `/webtty/sessions/${terminalId}/resize`, body: { cols: 81, rows: 25 } });
    assert.equal(response.status, 200);
    assert.equal(response.json?.ok, true);
    resizeReady = true;
  });
  const baseline = `${ctx.prefix}-terminal-positive`;
  const marker = path.join(fixture.host, 'marker.txt');
  let shellReady = false;
  await ctx.check('router:terminal-harmless-command-positive:admin', async () => {
    await livePositiveStream();
    const response = await ctx.request('admin', { method: 'POST', path: `/webtty/sessions/${terminalId}/input`, body: { data: markerCommand(ctx.prefix, baseline) } });
    assert.equal(response.status, 200);
    assert.equal(response.json?.ok, true);
    assert.ok(await waitForMarker(marker, baseline), 'Authorized shell must write its marker in the exact test-owned workspace directory');
    shellReady = true;
  });
  for (const actor of deniedActors) {
    await ctx.check(`router:terminal-sse-deny:${actor}`, async () => {
      await livePositiveStream();
      const response = await ctx.request(actor, { path: streamPath, stream: true });
      assertDenied(response);
    });
    if (!shellReady) {
      ctx.recordGap(`router:terminal-input-deny:${actor}`, 'Shell marker positive failed; no command functionality control is available.', { kind: 'positive-unavailable' });
    } else await ctx.check(`router:terminal-input-deny:${actor}`, async () => {
      await livePositiveStream();
      const response = await ctx.request(actor, { method: 'POST', path: `/webtty/sessions/${terminalId}/input`, body: { data: markerCommand(ctx.prefix, `${ctx.prefix}-unauthorized`) } });
      await pause(250);
      const changed = (await fs.readFile(marker, 'utf8')).trim() !== baseline;
      ctx.report.terminalSideEffects ||= [];
      ctx.report.terminalSideEffects.push({ actor, changed, status: response.status });
      assert.equal(changed, false, 'Unprivileged terminal input changed the test-owned shell marker');
      assertDenied(response);
    });
    if (resizeReady) await ctx.check(`router:terminal-resize-deny:${actor}`, async () => {
      await livePositiveStream();
      const response = await ctx.request(actor, { method: 'POST', path: `/webtty/sessions/${terminalId}/resize`, body: { cols: 80, rows: 24 } });
      assertDenied(response);
    });
    else ctx.recordGap(`router:terminal-resize-deny:${actor}`, 'Administrator resize positive failed.', { kind: 'positive-unavailable' });
    await ctx.check(`router:terminal-delete-deny:${actor}`, async () => {
      await livePositiveStream();
      const response = await ctx.request(actor, { method: 'DELETE', path: `/webtty/sessions/${terminalId}` });
      await livePositiveStream();
      assertDenied(response);
    });
  }
  await ctx.check('router:terminal-delete-positive:admin', async () => {
    const response = await ctx.request('admin', { method: 'DELETE', path: `/webtty/sessions/${terminalId}` });
    assert.equal(response.status, 200, 'Administrator must close the actual disposable session');
    assert.equal(response.json?.ok, true);
    terminalClosed = true;
  });
  // Positive control for discovery deletion: a second discovery whose launch is never consumed is
  // removed with 200, so the 404 below is the consumed-batch contract and not a broken DELETE.
  let freshDiscoveryId;
  let freshClosed = false;
  await ctx.check('router:terminal-discovery-delete-positive:admin', async () => {
    const created = await ctx.request('admin', { method: 'POST', path: '/webtty/target-discoveries', body: { dir: fixture.directory }, timeout: 30000 });
    assert.equal(created.status, 201, 'Administrator must create a second, unconsumed discovery');
    freshDiscoveryId = created.json?.discovery?.id;
    assert.match(freshDiscoveryId || '', /^[A-Za-z0-9_-]{16,128}$/);
    ctx.secrets.add(freshDiscoveryId);
    ctx.cleanup(async () => {
      if (freshClosed) return;
      const result = await ctx.request('admin', { method: 'DELETE', path: `/webtty/target-discoveries/${freshDiscoveryId}` });
      assert.ok([200, 404].includes(result.status), 'Only a disposable discovery may be absent during cleanup');
      freshClosed = true;
    });
    const removed = await ctx.request('admin', { method: 'DELETE', path: `/webtty/target-discoveries/${freshDiscoveryId}` });
    assert.equal(removed.status, 200, 'An unconsumed discovery must be removable');
    assert.equal(removed.json?.ok, true);
    freshClosed = true;
    const again = await ctx.request('admin', { method: 'DELETE', path: `/webtty/target-discoveries/${freshDiscoveryId}` });
    assert.equal(again.status, 404, 'A removed discovery is gone');
  });
  await ctx.check('router:terminal-discovery-cleanup:admin', async () => {
    const response = await ctx.request('admin', { method: 'DELETE', path: `/webtty/target-discoveries/${discoveryId}` });
    if (launchConsumed) {
      // cli/server/handlers/webtty.js: a cancelled-or-missing discovery is 404 {ok:false,error:'not_found'}.
      assert.equal(response.status, 404, 'The created session consumed the launch and removed its whole discovery batch');
      assert.deepEqual(response.json, { ok: false, error: 'not_found' });
    } else {
      assert.equal(response.status, 200);
    }
    discoveryClosed = true;
  });
}

async function runMcpSessionOwnership(ctx) {
  const sessions = new Map();
  const ready = new Set();
  const removed = new Set();
  const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
  async function ping(actor, session) {
    return ctx.request(actor, { method: 'POST', path: '/mcp', headers: { 'mcp-session-id': session }, body: rpc(2, 'ping', { agent: 'explorer' }) });
  }
  function assertPing(response) {
    assert.equal(response.status, 200);
    assert.equal(response.json?.jsonrpc, '2.0');
    assert.ok(Object.hasOwn(response.json, 'result') && !response.json.error, 'Existing MCP session must complete a supported local ping');
  }
  for (const actor of ['userA', 'userB']) await ctx.check(`router:mcp-session-create-positive:${actor}`, async () => {
    const response = await ctx.request(actor, { method: 'POST', path: '/mcp', body: rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'authorization-suite', version: '1' } }) });
    assert.equal(response.status, 200);
    assert.ok(response.json?.result?.serverInfo && !response.json.error);
    const session = response.headers['mcp-session-id'];
    assert.match(session || '', /^[A-Za-z0-9_-]{16,128}$/);
    sessions.set(actor, session);
    ctx.secrets.add(session);
    ctx.cleanup(async () => {
      if (removed.has(actor)) return;
      const result = await ctx.request(actor, { method: 'DELETE', path: '/mcp', headers: { 'mcp-session-id': session } });
      assert.equal(result.status, 204, 'Only test-owned MCP session is removed');
      removed.add(actor);
    });
    assertPing(await ping(actor, session));
    ready.add(actor);
  });
  if (ready.size !== 2) {
    ctx.recordGap('router:mcp-session-horizontal-delete', 'Two initialized MCP sessions with successful supported ping controls are required.', { kind: 'positive-unavailable' });
    for (const [actor, session] of sessions) await ctx.check(`router:mcp-session-setup-cleanup:${actor}`, async () => {
      const response = await ctx.request(actor, { method: 'DELETE', path: '/mcp', headers: { 'mcp-session-id': session } });
      assert.equal(response.status, 204);
      removed.add(actor);
    });
    return;
  }
  assert.notEqual(sessions.get('userA'), sessions.get('userB'));
  let ownerDeleteWorks = false;
  await ctx.check('router:mcp-session-delete-own-positive:userA', async () => {
    const response = await ctx.request('userA', { method: 'DELETE', path: '/mcp', headers: { 'mcp-session-id': sessions.get('userA') } });
    assert.equal(response.status, 204);
    removed.add('userA');
    const after = await ping('userA', sessions.get('userA'));
    assert.equal(after.status, 200);
    assert.equal(after.json?.error?.code, -32000, 'Own deleted protocol session must no longer be usable');
    assertPing(await ping('userB', sessions.get('userB')));
    ownerDeleteWorks = true;
  });
  if (ownerDeleteWorks) await ctx.check('router:mcp-session-horizontal-delete-deny:userA-to-userB', async () => {
    const response = await ctx.request('userA', { method: 'DELETE', path: '/mcp', headers: { 'mcp-session-id': sessions.get('userB') } });
    const after = await ping('userB', sessions.get('userB'));
    const invalidated = after.status === 200 && after.json?.error?.code === -32000;
    if (invalidated) removed.add('userB');
    ctx.report.mcpSessionOwnership = { differentVerifiedOrdinaryPrincipals: true, ownerDeleteControlPassed: true, crossDeleteStatus: response.status, victimSessionInvalidated: invalidated, source: 'cli/server/routerHandlers.js:734' };
    assert.equal(invalidated, false, 'One ordinary account deleted another account\'s existing MCP protocol session');
    assertDenied(response);
    assertPing(after);
  });
  else ctx.recordGap('router:mcp-session-horizontal-delete', 'Authorized own-session delete did not demonstrate the operation.', { kind: 'positive-unavailable' });
  // Complete cleanup now, before the later revocation probes invalidate users.
  for (const [actor, session] of sessions) if (!removed.has(actor)) await ctx.check(`router:mcp-session-cleanup:${actor}`, async () => {
    const response = await ctx.request(actor, { method: 'DELETE', path: '/mcp', headers: { 'mcp-session-id': session } });
    assert.equal(response.status, 204);
    removed.add(actor);
  });
}

export async function runStreamProbes(ctx) {
  const fixture = await registerDirectory(ctx);
  await runTerminalProbes(ctx, fixture);
  await runWorkspaceSelectorProbes(ctx, fixture);
  await runMcpSessionOwnership(ctx);
  ctx.recordGap('router:stream-revocation-continuation', 'Terminal SSE handshake and existing-session role checks were bounded at response headers; an already-open stream was not held across provider revocation.', { kind: 'declared-limitation' });
}

// Bounded single-case proof used by the focused pre-fix entry: one anonymous
// WebChat overwrite attempt through an undeclared guest selector against a
// file this run created. It never runs the rest of the matrix.
export async function runWebchatUploadDenialProof(ctx, { id = 'router:webchat-upload-deny:anonymous:webAssist', register = registerDirectory } = {}) {
  const row = workspaceWriteMatrix().denials.find(item => item.id === id);
  assert.ok(row && row.operation === 'upload', 'Focused proof must name a WebChat upload denial');
  const fixture = await register(ctx);
  const filename = path.join(fixture.host, 'fixture.txt');
  const baseline = `${ctx.prefix}-prefix-baseline`;
  await ctx.guard();
  await fs.writeFile(filename, baseline, { flag: 'wx', mode: 0o644 });
  const before = await fileSha(filename);
  const payload = `${ctx.prefix}-prefix-denial-payload`;
  await ctx.check(row.id, async () => {
    const response = await ctx.request(row.actor, workspaceWriteRequest(row, fixture, payload));
    const content = await fs.readFile(filename, 'utf8');
    const after = await fileSha(filename);
    ctx.report.focusedProof = {
      id: row.id,
      status: response.status,
      beforeSha256: before,
      afterSha256: after,
      fixtureChanged: after !== before,
      fixtureHoldsDenialPayload: content === payload,
    };
    assert.equal(after, before, 'Anonymous WebChat upload through an undeclared selector changed a test-owned file');
    assertDenied(response);
  });
}
