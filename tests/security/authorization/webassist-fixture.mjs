/**
 * Inference-free webAssist session fixture for the cross-session history checks.
 *
 * A webAssist chat session can be created only by web_cli_chat, which performs
 * inference. The suite seeds one instead: for each anonymous jar it decodes the guest
 * identity from that jar's own `ploinky_guest` JWT, then writes, under a run-owned site
 * in the fixture workspace's webAssist data root, the session knowledge unit with a
 * marker turn (through the AgenticKnowledgeUnits library, which takes its own root and
 * per-unit locks) and the session-owner record.
 *
 * The owner record is written from the data-structure contract, independently of the
 * product code, so format drift is caught by the live read:
 *
 *   <data root>/sites/<site>/session-owners/<sessionId>.json   mode 0600
 *   { "schema": 2, "kind": "guest", "id": "<user:guest:uuid>",
 *     "secretHash": "<sha256 hex of the UTF-8 sessionSecret string>", "createdAt": "<ISO>" }
 *
 * Ownership of what the fixture creates is exclusive and explicit: it refuses to adopt
 * an existing site, arms cleanup before it creates anything, and removes only the site
 * it created (and the `sites` and `data` directories only when it created them and they
 * are empty). Any failure to seed is thrown, so the checks that depend on it FAIL; it
 * never degrades to a gap. The caller holds the workspace mutation lock; every mutation
 * phase re-proves it through ctx.guard().
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const GUEST_COOKIE = 'ploinky_guest';
const GUEST_SUBJECT = /^user:guest:[A-Za-z0-9-]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The persistent storage root of the webAssist agent: <workspace>/.data/<persistentStorage.key>. */
export function webAssistPersistentRoot(workspace) {
  assert.ok(path.isAbsolute(String(workspace)), 'A workspace root is required');
  return path.join(workspace, '.data', 'webAssist');
}

/** The guest identity a jar presents: the `sub` of its own guest-session JWT (no signature check; the Router verifies it). */
export function guestSubjectFromJar(cookies, { now = () => Date.now() } = {}) {
  const cookie = (cookies || []).find(entry => entry?.name === GUEST_COOKIE && entry.value);
  assert.ok(cookie, 'The jar holds no guest session cookie; initialize the webAssist route first');
  const parts = String(cookie.value).split('.');
  assert.equal(parts.length, 3, 'The guest cookie is not a compact JWT');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { assert.fail('The guest cookie payload is not JSON'); }
  assert.equal(payload?.typ, 'guest-session', 'The cookie is not a guest session');
  assert.equal(typeof payload.sub, 'string');
  assert.match(payload.sub, GUEST_SUBJECT, 'The guest subject has the user:guest:<uuid> form');
  if (payload.exp !== undefined) assert.ok(Number(payload.exp) * 1000 > now(), 'The guest session has expired');
  return payload.sub;
}

export const secretHashOf = secret => createHash('sha256').update(String(secret), 'utf8').digest('hex');

async function lstatOrNull(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export function createWebAssistSessionFactory(ctx, {
  workspace = () => { throw new Error('No workspace'); },
  loadAku = async () => (await import('achillesAgentLib/AgenticKnowledgeUnits')).AgenticKnowledgeUnits,
  runId = ctx.prefix,
  now = () => new Date(),
} = {}) {
  const state = { armed: false, root: '', siteId: '', siteDir: '', sitesDir: '', dataDir: '', claimedSite: false, createdSites: false, createdData: false, aku: null, seeded: [] };

  async function armAndPrepare() {
    if (state.armed) return;
    const root = webAssistPersistentRoot(String(await workspace()));
    state.siteId = `a7-webassist-${String(runId).replace(/^authz-/, '').replace(/[^A-Za-z0-9._-]/g, '-')}`;
    assert.match(state.siteId, SITE_ID, 'The run-owned site id is valid');
    state.dataDir = path.join(root, 'data');
    state.sitesDir = path.join(state.dataDir, 'sites');
    state.siteDir = path.join(state.sitesDir, state.siteId);
    state.root = root;
    state.armed = true;
    // Armed before anything is created: it removes exactly what this fixture claimed.
    ctx.cleanup(async () => {
      if (state.claimedSite) {
        await ctx.guard();
        const info = await lstatOrNull(state.siteDir);
        if (info) {
          assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'The run-owned site directory changed identity');
          assert.equal(path.dirname(state.siteDir), state.sitesDir);
          await fs.rm(state.siteDir, { recursive: true, force: false });
        }
        state.claimedSite = false;
      }
      for (const [flag, dir] of [['createdSites', state.sitesDir], ['createdData', state.dataDir]]) {
        if (!state[flag]) continue;
        await ctx.guard();
        try { await fs.rmdir(dir); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error?.code)) throw error; }
        state[flag] = false;
      }
    });
    const persistent = await lstatOrNull(root);
    assert.ok(persistent && persistent.isDirectory() && !persistent.isSymbolicLink(), `The webAssist persistent storage root must be an existing non-symlink directory: ${root}`);
    for (const [flag, dir] of [['createdData', state.dataDir], ['createdSites', state.sitesDir]]) {
      await ctx.guard();
      const info = await lstatOrNull(dir);
      if (info) { assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${path.basename(dir)} must be a non-symlink directory`); continue; }
      state[flag] = true;
      await fs.mkdir(dir, { mode: 0o755 });
    }
    assert.equal(await fs.realpath(state.dataDir), path.join(await fs.realpath(root), 'data'), 'The data directory stays inside the persistent root');
    await ctx.guard();
    assert.equal(await lstatOrNull(state.siteDir), null, 'The run-owned site already exists; a site is never adopted');
    state.claimedSite = true;
    await fs.mkdir(state.siteDir, { mode: 0o755 });
    const AKU = await loadAku();
    state.aku = new AKU({ rootDir: state.siteDir, actor: 'a7-harness' });
    await state.aku.initAKU({ site_id: state.siteId, owner: 'a7-harness-run', run: String(runId) });
  }

  /** createSession(actor) -> { siteId, sessionId, marker, secret, subject } */
  return async function createSession(actor) {
    assert.ok(ctx.clients?.[actor], `Unknown jar ${actor}`);
    const subject = guestSubjectFromJar(ctx.clients[actor].cookies, { now: () => now().getTime() });
    await ctx.guard();
    await armAndPrepare();
    const sessionId = `a7-sess-${actor.toLowerCase().replace(/[^a-z0-9]/g, '')}-${randomBytes(8).toString('hex')}`;
    assert.match(sessionId, SESSION_ID);
    const marker = `a7-marker-${randomUUID()}`;
    const secret = randomBytes(32).toString('base64url');
    ctx.secrets?.add(secret);
    const kuId = `ku_sess_${sessionId}`;
    const createdAt = now().toISOString();
    await ctx.guard();
    await state.aku.initKU({
      ku_id: kuId, ku_name: `Session ${sessionId}`, ku_type: 'session-profile', keywords: ['session', sessionId], tags: ['session', 'profile'],
      summary: `Session profile for ${sessionId}`, state: '', metadata: { sessionId, createdAt },
    });
    for (const [speaker, message] of [['user', `${marker} user`], ['agent', `${marker} agent`]]) {
      await state.aku.recordEvent(kuId, {
        event_type: 'turn', title: speaker === 'user' ? 'User message' : 'Agent response', summary: message.slice(0, 200), tags: ['turn', speaker],
        metadata: { speaker, message, timestamp: createdAt },
      });
    }
    await ctx.guard();
    const ownersDir = path.join(state.siteDir, 'session-owners');
    const existing = await lstatOrNull(ownersDir);
    if (!existing) await fs.mkdir(ownersDir, { mode: 0o755 });
    const ownersInfo = await fs.lstat(ownersDir);
    assert.ok(ownersInfo.isDirectory() && !ownersInfo.isSymbolicLink(), 'session-owners must be a non-symlink directory');
    await ctx.guard();
    const ownerFile = path.join(ownersDir, `${sessionId}.json`);
    const record = { schema: 2, kind: 'guest', id: subject, secretHash: secretHashOf(secret), createdAt };
    await fs.writeFile(ownerFile, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.chmod(ownerFile, 0o600);
    // Read back what the library will serve, so an unreadable or malformed seed fails here, not as a vacuous denial later.
    const loaded = await state.aku.loadKU(kuId);
    const turns = (loaded.events || []).filter(event => event.event_type === 'turn');
    assert.ok(turns.some(event => String(event.metadata?.message || '').includes(marker)), 'The seeded session holds its marker turn');
    state.seeded.push({ actor, sessionId });
    return { siteId: state.siteId, sessionId, marker, secret, subject };
  };

}
