// The inference-free webAssist session fixture, against the real AgenticKnowledgeUnits
// library in a throw-away workspace: what it writes, under which locks, and what it removes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GUEST_COOKIE, createWebAssistSessionFactory, guestSubjectFromJar, secretHashOf, webAssistPersistentRoot } from './webassist-fixture.mjs';

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const SUB_A = 'user:guest:11111111-1111-4111-8111-111111111111';
const SUB_B = 'user:guest:22222222-2222-4222-8222-222222222222';
const jwt = (payload = {}) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ typ: 'guest-session', iss: 'ploinky-router', sub: SUB_A, exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.signature`;
const jar = (value = jwt()) => ({ cookies: value === null ? [] : [{ name: GUEST_COOKIE, value }] });

async function workspace(t, { persistent = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'authz-wa-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (persistent) await fs.mkdir(path.join(root, '.data', 'webAssist'), { recursive: true });
  return root;
}
function makeCtx(root, { guard } = {}) {
  const guards = [];
  return { prefix: 'authz-abc123-deadbeef', secrets: new Set(), cleanups: [], guards,
    clients: { anonymous: jar(jwt({ sub: SUB_A })), anonymousB: jar(jwt({ sub: SUB_B })) },
    cleanup(fn) { this.cleanups.push(fn); },
    async guard() { guards.push(snapshot(root)); if (guard) await guard(guards.length); },
  };
}
/** Which of the things the fixture creates exist right now, in creation order. */
function snapshot(root) {
  const data = path.join(root, '.data', 'webAssist', 'data');
  const siteDir = path.join(data, 'sites', 'a7-webassist-abc123-deadbeef');
  const kus = path.join(siteDir, '.aku', 'kus');
  const owners = path.join(siteDir, 'session-owners');
  return [existsSync(data), existsSync(path.join(data, 'sites')), existsSync(siteDir), existsSync(kus) && readdirSync(kus).some(name => name.startsWith('ku_sess_')),
    existsSync(owners), existsSync(owners) && readdirSync(owners).length > 0];
}
const exists = target => fs.lstat(target).then(() => true, () => false);
const runCleanups = async ctx => { for (const fn of [...ctx.cleanups].reverse()) await fn(); };
const site = root => path.join(webAssistPersistentRoot(root), 'data', 'sites', 'a7-webassist-abc123-deadbeef');

test('guest identity is decoded from the jar\'s own guest JWT and nothing else is accepted', () => {
  assert.equal(guestSubjectFromJar(jar(jwt({ sub: SUB_B })).cookies), SUB_B);
  const bad = {
    none: null, 'not a jwt': 'abc', 'not json': `x.${Buffer.from('nope').toString('base64url')}.y`,
    'user session': jwt({ typ: 'user-session' }), 'bad subject': jwt({ sub: 'guest:11111111' }), 'user subject': jwt({ sub: 'user:USER.3' }), 'missing subject': jwt({ sub: undefined }),
    expired: jwt({ exp: Math.floor(Date.now() / 1000) - 5 }),
  };
  for (const [name, value] of Object.entries(bad)) assert.throws(() => guestSubjectFromJar(jar(value).cookies), undefined, name);
  assert.throws(() => guestSubjectFromJar([{ name: 'ploinky_sso', value: jwt() }]), /no guest session cookie/);
  assert.equal(guestSubjectFromJar([{ name: 'ploinky_sso', value: 'x' }, { name: GUEST_COOKIE, value: jwt({ sub: SUB_A }) }]), SUB_A);
});

test('seeding writes the session, its marker turns and a schema-2 owner record, then cleans up exactly what it created', async t => {
  const root = await workspace(t);
  const ctx = makeCtx(root);
  const create = createWebAssistSessionFactory(ctx, { workspace: () => root });
  assert.equal(await exists(path.join(webAssistPersistentRoot(root), 'data')), false, 'nothing exists before the first seed');
  const a = await create('anonymous');
  const afterFirst = ctx.guards.length;
  const b = await create('anonymousB');
  assert.ok(ctx.guards.slice(afterFirst).some(shot => shot[3] === true), 'the second session is guarded too');
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.siteId, 'a7-webassist-abc123-deadbeef');
  assert.equal(a.siteId, b.siteId);
  for (const seeded of [a, b]) assert.ok(ctx.secrets.has(seeded.secret), 'the secret is registered for redaction');
  // Owner records: schema 2, mode 0600, hash only.
  for (const [seeded, sub] of [[a, SUB_A], [b, SUB_B]]) {
    const file = path.join(site(root), 'session-owners', `${seeded.sessionId}.json`);
    const info = await fs.stat(file);
    assert.equal(info.mode & 0o777, 0o600);
    const text = await fs.readFile(file, 'utf8');
    const record = JSON.parse(text);
    assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'id', 'kind', 'schema', 'secretHash']);
    assert.equal(record.schema, 2);
    assert.equal(record.kind, 'guest');
    assert.equal(record.id, sub);
    assert.equal(record.secretHash, createHash('sha256').update(seeded.secret, 'utf8').digest('hex'));
    assert.equal(secretHashOf(seeded.secret), record.secretHash);
    assert.ok(Number.isFinite(Date.parse(record.createdAt)));
    assert.equal(text.includes(seeded.secret), false, 'the plaintext secret is never stored');
    assert.notEqual(record.secretHash, createHash('sha256').update(Buffer.from(seeded.secret, 'base64url')).digest('hex'), 'the contract hashes the presented string, not its decoded bytes');
  }
  // The library reads back what the product will read: the turns carry the marker.
  const { AgenticKnowledgeUnits } = await import('achillesAgentLib/AgenticKnowledgeUnits');
  const aku = new AgenticKnowledgeUnits({ rootDir: site(root), actor: 'test' });
  assert.equal(await aku.exists(), true);
  await aku.loadAKU();
  const ku = await aku.loadKU(`ku_sess_${a.sessionId}`);
  assert.equal(ku.manifest.ku_type, 'session-profile');
  const turns = ku.events.filter(event => event.event_type === 'turn');
  assert.deepEqual(turns.map(event => event.metadata.speaker), ['user', 'agent']);
  assert.ok(turns.every(event => event.metadata.message.includes(a.marker)));
  assert.equal(JSON.stringify(ku).includes(b.marker), false, 'sessions do not share content');
  assert.equal((await fs.readdir(path.join(site(root), '.aku'))).some(name => /lock/i.test(name)), false, 'no AKU lock is left behind');
  assert.equal((await fs.readdir(path.join(site(root), '.aku', 'kus'))).some(name => /lock/i.test(name)), false);
  // Mutation lock: every phase re-proved the guard, and the first proof came before anything existed.
  // Every mutation is preceded by a guard call made after the previous one: data, sites, site, session unit, owners dir, owner file.
  const first = ctx.guards.length;
  for (let index = 0; index < 6; index++) {
    assert.ok(ctx.guards.some(shot => shot[index] === false && (index === 0 || shot[index - 1] === true)), `no guard ran between the previous step and creating step ${index}`);
  }
  assert.ok(first >= 6);
  await runCleanups(ctx);
  assert.equal(await exists(site(root)), false);
  assert.equal(await exists(path.join(webAssistPersistentRoot(root), 'data')), false, 'the data child the run created is removed when empty');
  assert.equal(await exists(webAssistPersistentRoot(root)), true, 'the persistent root is never removed');
});

test('cleanup deletes only the run-owned site and keeps data and sites it did not create or that are not empty', async t => {
  const root = await workspace(t);
  const other = path.join(webAssistPersistentRoot(root), 'data', 'sites', 'customer-site');
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, 'keep.txt'), 'keep');
  const ctx = makeCtx(root);
  await createWebAssistSessionFactory(ctx, { workspace: () => root })('anonymous');
  await runCleanups(ctx);
  assert.equal(await exists(site(root)), false);
  assert.equal(await fs.readFile(path.join(other, 'keep.txt'), 'utf8'), 'keep');
  // A directory the run created that has since gained other content is left alone, silently.
  const root2 = await workspace(t);
  const ctx2 = makeCtx(root2);
  await createWebAssistSessionFactory(ctx2, { workspace: () => root2 })('anonymous');
  await fs.writeFile(path.join(webAssistPersistentRoot(root2), 'data', 'sites', 'late.txt'), 'late');
  await runCleanups(ctx2);
  assert.equal(await exists(site(root2)), false);
  assert.equal(await fs.readFile(path.join(webAssistPersistentRoot(root2), 'data', 'sites', 'late.txt'), 'utf8'), 'late');
});

test('an existing site is never adopted or removed', async t => {
  const root = await workspace(t);
  await fs.mkdir(site(root), { recursive: true });
  await fs.writeFile(path.join(site(root), 'precious.txt'), 'x');
  const ctx = makeCtx(root);
  await assert.rejects(createWebAssistSessionFactory(ctx, { workspace: () => root })('anonymous'), /never adopted/);
  await runCleanups(ctx);
  assert.equal(await fs.readFile(path.join(site(root), 'precious.txt'), 'utf8'), 'x');
});

test('seeding that is impossible throws (the checks fail) instead of degrading', async t => {
  const missing = await workspace(t, { persistent: false });
  await assert.rejects(createWebAssistSessionFactory(makeCtx(missing), { workspace: () => missing })('anonymous'), /persistent storage root/);
  const linked = await workspace(t, { persistent: false });
  await fs.mkdir(path.join(linked, '.data'));
  await fs.mkdir(path.join(linked, 'elsewhere'));
  await fs.symlink(path.join(linked, 'elsewhere'), path.join(linked, '.data', 'webAssist'));
  await assert.rejects(createWebAssistSessionFactory(makeCtx(linked), { workspace: () => linked })('anonymous'), /non-symlink/);
  const linkedData = await workspace(t);
  await fs.mkdir(path.join(linkedData, 'elsewhere'));
  await fs.symlink(path.join(linkedData, 'elsewhere'), path.join(webAssistPersistentRoot(linkedData), 'data'));
  const ctx = makeCtx(linkedData);
  await assert.rejects(createWebAssistSessionFactory(ctx, { workspace: () => linkedData })('anonymous'), /non-symlink/);
  assert.deepEqual(await fs.readdir(path.join(linkedData, 'elsewhere')), [], 'nothing was written through the link');
  // An unreadable seed (the library cannot read back what was written) fails too.
  const root = await workspace(t);
  const ctx2 = makeCtx(root);
  const create = createWebAssistSessionFactory(ctx2, { workspace: () => root, loadAku: async () => class { async initAKU() {} async initKU() {} async recordEvent() {} async loadKU() { return { events: [] }; } } });
  await assert.rejects(create('anonymous'), /marker turn/);
  await runCleanups(ctx2);
  assert.equal(await exists(site(root)), false);
});

test('a failed ownership guard creates nothing, and a jar without a guest session creates nothing', async t => {
  const root = await workspace(t);
  const ctx = makeCtx(root, { guard: async () => { throw new Error('ownership guard failed'); } });
  await assert.rejects(createWebAssistSessionFactory(ctx, { workspace: () => root })('anonymous'), /ownership guard failed/);
  assert.equal(await exists(path.join(webAssistPersistentRoot(root), 'data')), false);
  const ctx2 = makeCtx(root);
  ctx2.clients.anonymous = jar(null);
  await assert.rejects(createWebAssistSessionFactory(ctx2, { workspace: () => root })('anonymous'), /no guest session cookie/);
  assert.equal(await exists(path.join(webAssistPersistentRoot(root), 'data')), false);
  await assert.rejects(createWebAssistSessionFactory(ctx2, { workspace: () => root })('nobody'), /Unknown jar/);
});

test('cleanup is armed before creation: a failure after the site exists still removes it', async t => {
  const root = await workspace(t);
  const ctx = makeCtx(root);
  const create = createWebAssistSessionFactory(ctx, { workspace: () => root, loadAku: async () => { throw new Error('library unavailable'); } });
  await assert.rejects(create('anonymous'), /library unavailable/);
  assert.equal(await exists(site(root)), true, 'the site directory was claimed before the failure');
  assert.equal(ctx.cleanups.length, 1, 'cleanup was already armed');
  await runCleanups(ctx);
  assert.equal(await exists(site(root)), false);
  assert.equal(await exists(path.join(webAssistPersistentRoot(root), 'data')), false);
});

test('writes go through the library in lock-taking order and cleanup refuses a swapped site directory', async t => {
  const root = await workspace(t);
  const calls = [];
  class Spy {
    constructor(options) { calls.push(['construct', options.rootDir, options.actor]); }
    async initAKU(metadata) { calls.push(['initAKU', metadata.site_id]); }
    async initKU(metadata) { calls.push(['initKU', metadata.ku_id, metadata.ku_type]); }
    async recordEvent(kuId, event) { calls.push(['recordEvent', kuId, event.event_type, event.metadata.speaker]); }
    async loadKU(kuId) { calls.push(['loadKU', kuId]); return { events: calls.filter(call => call[0] === 'recordEvent').map(call => ({ event_type: 'turn', metadata: { message: `${calls.marker}` } })) }; }
  }
  const ctx = makeCtx(root);
  // The spy echoes the marker back from the recorded events.
  const create = createWebAssistSessionFactory(ctx, { workspace: () => root, loadAku: async () => class extends Spy {
    async recordEvent(kuId, event) { calls.marker = event.metadata.message.split(' ')[0]; return super.recordEvent(kuId, event); }
  } });
  const seeded = await create('anonymous');
  assert.deepEqual(calls.map(call => call[0]), ['construct', 'initAKU', 'initKU', 'recordEvent', 'recordEvent', 'loadKU']);
  assert.deepEqual(calls[2].slice(1), [`ku_sess_${seeded.sessionId}`, 'session-profile']);
  assert.deepEqual(calls.filter(call => call[0] === 'recordEvent').map(call => call.slice(2)), [['turn', 'user'], ['turn', 'agent']]);
  assert.equal(calls[0][2], 'a7-harness');
  // The site directory is swapped for a symlink before cleanup: nothing outside is touched.
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'x'), 'x');
  await fs.rm(site(root), { recursive: true });
  await fs.symlink(outside, site(root));
  await assert.rejects(runCleanups(ctx), /changed identity/);
  assert.equal(await fs.readFile(path.join(outside, 'x'), 'utf8'), 'x');
});
