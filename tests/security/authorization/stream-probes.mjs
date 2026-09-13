import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertDenied, WORKSPACE } from './core.mjs';

const deniedActors = ['anonymous', 'selfRegistered', 'userA', 'userB'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function terminalFixtureNames(prefix) {
  assert.match(prefix, /^authz-[a-z0-9-]{8,80}$/, 'Terminal fixture prefix must be a generated, shell-safe test identifier');
  const directory = `${prefix}-terminal`;
  return { directory, host: path.join(WORKSPACE, directory), container: `/workspace/${directory}` };
}

export function markerCommand(prefix, marker) {
  const fixture = terminalFixtureNames(prefix);
  assert.match(marker, /^authz-[a-z0-9-]{8,100}$/, 'Marker must be a generated literal, never user-provided shell syntax');
  return `printf '%s\\n' '${marker}' > '${fixture.container}/marker.txt'\n`;
}

async function registerDirectory(ctx) {
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
    ctx.recordGap('router:workspace-file-selector-bypass', 'Existing fixture read positive controls failed; no selector-bypass denial is credited.');
    return;
  }
  const selectors = ['', '?agent=authorization-suite-nonexistent', '?agent=userPersistoAgent'];
  const leaked = [];
  for (const actor of ['anonymous', 'selfRegistered']) for (const selector of selectors) {
    await ctx.check(`router:workspace-file-selector-deny:${actor}:${selector || 'default'}`, async () => {
      const response = await ctx.request(actor, { path: resource + selector });
      const exposed = response.status === 200 && response.text === baseline;
      if (exposed) leaked.push({ actor, selector });
      ctx.report.workspaceSelectorEvidence ||= [];
      ctx.report.workspaceSelectorEvidence.push({ actor, selector: selector || 'default', status: response.status, fixtureContentDisclosed: exposed });
      assertDenied(response);
      assert.equal(response.text.includes(baseline), false, 'Denied response must not disclose fixture content');
    });
  }
  // A confirmed read bypass justifies one bounded, unique write probe per
  // affected principal/selector. Files stay inside the exclusively owned folder.
  for (const [index, { actor, selector }] of leaked.entries()) {
    const name = `bypass-write-${index}.txt`;
    const target = path.join(fixture.host, name);
    await ctx.guard();
    await fs.writeFile(target, baseline, { flag: 'wx', mode: 0o644 });
    const requestedPath = `${fixture.directory}/${name}`;
    let positive = false;
    await ctx.check(`router:workspace-upload-positive:${index}`, async () => {
      const response = await ctx.request('admin', { method: 'PUT', path: `/upload?path=${encodeURIComponent(requestedPath)}`, body: baseline, headers: { 'content-type': 'text/plain' } });
      assert.equal(response.status, 200);
      assert.equal(response.json?.ok, true);
      assert.equal(await fs.readFile(target, 'utf8'), baseline);
      positive = true;
    });
    if (!positive) {
      ctx.recordGap(`router:workspace-upload-selector-deny:${actor}:${index}`, 'Authorized upload to existing disposable file failed.');
      continue;
    }
    await ctx.check(`router:workspace-upload-selector-deny:${actor}:${index}`, async () => {
      const response = await ctx.request(actor, {
        method: 'PUT', path: `/upload?path=${encodeURIComponent(requestedPath)}${selector.replace('?', '&')}`,
        body: `${ctx.prefix}-unauthorized-upload`, proof: false, headers: { 'content-type': 'text/plain' },
      });
      const changed = (await fs.readFile(target, 'utf8')) !== baseline;
      ctx.report.workspaceSelectorEvidence.push({ actor, selector: selector || 'default', operation: 'upload', status: response.status, fixtureChanged: changed, originAndCsrfOmitted: true });
      assert.equal(changed, false, 'Unprivileged selector changed an existing test-owned workspace file without Origin or CSRF');
      assertDenied(response);
    });
  }
}

async function runTerminalProbes(ctx, fixture) {
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
    if (response.status === 503) ctx.recordGap('router:terminal-backend', 'Administrator discovery returned 503; unavailable terminal functionality cannot count as authorization denial.');
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
    ctx.recordGap('router:terminal-session-probes', 'Positive target discovery did not complete; terminal stream/input/create denial coverage is unavailable.');
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
  await ctx.check('router:terminal-create-positive:admin', async () => {
    const response = await ctx.request('admin', { method: 'POST', path: '/webtty/sessions', body: { launch, cols: 80, rows: 24 }, timeout: 30000 });
    if (response.status === 503) ctx.recordGap('router:terminal-backend', 'Administrator session creation returned 503; native runtime is unavailable.');
    assert.equal(response.status, 201, 'Administrator must create the exact box terminal target');
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
    ctx.recordGap('router:terminal-existing-session-probes', 'Positive session creation failed; no existing terminal is available to prove stream/input/resize/delete denials.');
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
      ctx.recordGap(`router:terminal-input-deny:${actor}`, 'Shell marker positive failed; no command functionality control is available.');
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
    else ctx.recordGap(`router:terminal-resize-deny:${actor}`, 'Administrator resize positive failed.');
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
  await ctx.check('router:terminal-discovery-cleanup:admin', async () => {
    const response = await ctx.request('admin', { method: 'DELETE', path: `/webtty/target-discoveries/${discoveryId}` });
    assert.equal(response.status, 200);
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
    ctx.recordGap('router:mcp-session-horizontal-delete', 'Two initialized MCP sessions with successful supported ping controls are required.');
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
  else ctx.recordGap('router:mcp-session-horizontal-delete', 'Authorized own-session delete did not demonstrate the operation.');
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
  ctx.recordGap('router:stream-revocation-continuation', 'Terminal SSE handshake and existing-session role checks were bounded at response headers; an already-open stream was not held across provider revocation.');
}
