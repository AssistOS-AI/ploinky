import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manifestFixture, installPureGuards, H } from './test_support_codex.mjs';
import { createFakeHost } from './fake_host_support_codex.mjs';
import { createGitFixture, fixtureNames, runSuffix, OWNER_LABEL, ROLE_LABEL } from './git_fixture_codex.mjs';
import { buildCommandEnvironment } from './host_command_codex.mjs';
installPureGuards();

const realParent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'uc-fixture-'));
after(() => fs.rmSync(realParent, { recursive: true, force: true }));
const IMAGE = `docker.io/library/node@sha256:${'a'.repeat(64)}`;
let counter = 0;

function build(mutate = () => {}) {
    const { value: manifest } = manifestFixture(); const evidence = path.join(realParent, `case${counter++}`); fs.mkdirSync(evidence);
    manifest.evidence.root = evidence; manifest.evidence.functional = path.join(evidence, 'functional_codex.json'); manifest.evidence.release = path.join(evidence, 'release_codex.json');
    manifest.evidence.receipt = path.join(evidence, 'receipt_codex.json'); manifest.evidence.sourceManifest = path.join(evidence, 'sources_codex.json');
    const state = { commits: [], labels: null, port: String(manifest.fixtureEndpoint.port), hostIp: manifest.fixtureEndpoint.bindIP, image: manifest.fixtureEndpoint.imageId, id: H('server'), containerGone: false, reach: null };
    mutate(manifest, state);
    const commit = { value: 0 };
    const routes = [
        { match: (bin, args) => bin === '/usr/bin/git' && args.includes('config') && args.includes('user.name') && args.length === 4, reply: () => ({ stdout: 'Human Operator\n' }) },
        { match: (bin, args) => bin === '/usr/bin/git' && args.includes('config') && args.includes('user.email') && args.length === 4, reply: () => ({ stdout: 'human@example.invalid\n' }) },
        { match: (bin, args) => bin === '/usr/bin/git' && args.includes('rev-parse') && args.includes('HEAD'), reply: () => ({ stdout: `${String(++commit.value).padStart(40, 'c')}\n` }) },
        // A real clone creates its working directory; the fake does the same so the module's own file writes land in it.
        { match: (bin, args) => bin === '/usr/bin/git' && args.includes('clone'), reply: ({ args, options }) => { fs.mkdirSync(path.join(options.cwd, args.at(-1))); return {}; } },
        { match: (bin, args) => bin === '/usr/bin/git', reply: () => ({}) },
        { match: (bin, args) => args[0] === 'run', reply: ({ args }) => { const index = args.indexOf('--cidfile'); if (!state.noCidfile) fs.writeFileSync(args[index + 1], state.cidContent ?? state.id, { flag: 'wx' }); return state.runExit ? { code: state.runExit } : { stdout: `${state.stdoutId ?? state.id}\n` }; } },
        { match: (bin, args) => args[0] === 'container' && args[1] === 'inspect' && args.includes('{{json .Id}}\n{{json .Image}}\n{{json .Config.Labels}}\n{{json .HostConfig.PortBindings}}\n{{json .HostConfig.NetworkMode}}'),
            reply: () => ({ stdout: [JSON.stringify(state.id), JSON.stringify(`sha256:${state.image}`), JSON.stringify(state.labels ?? { [OWNER_LABEL]: manifest.runId, [ROLE_LABEL]: 'update-cache-git-fixture' }),
                JSON.stringify({ [`${manifest.fixtureEndpoint.internalPort}/tcp`]: [{ HostIp: state.hostIp, HostPort: state.port }] }), '"bridge"'].join('\n') + '\n' }) },
        { match: (bin, args) => args[0] === 'container' && args[1] === 'inspect', reply: () => state.containerGone ? { code: 125 } : ({ stdout: `${JSON.stringify(state.id)}\n${JSON.stringify(state.labels ?? { [OWNER_LABEL]: manifest.runId, [ROLE_LABEL]: 'update-cache-git-fixture' })}\n` }) },
        { match: (bin, args) => args[0] === 'stop' || args[0] === 'rm', reply: () => ({ stdout: `${state.id}\n` }) },
        { match: (bin, args) => args.includes('--input-type') || args.includes('-e'), reply: () => ({ stdout: state.reach ?? `200 ${'c'.repeat(40)}\trefs/heads/main\n` }) },
    ];
    const fake = createFakeHost(routes);
    const fixture = createGitFixture({ manifest, deps: fake.deps, probeAgentImage: IMAGE, env: buildCommandEnvironment({ PATH: '/usr/bin' }), random: () => Buffer.alloc(24, 7) });
    return { manifest, fake, fixture, state, evidence };
}
const argsOf = (h, predicate) => h.fake.log.filter(row => predicate(row.bin, row.args));

test('names derive from the run suffix and the fixture parent is created exclusively with a private marker outside the served tree', async () => {
    assert.equal(runSuffix('update-cache-20261004T120000Z-1234abcd_codex'), '1234abcd'); assert.throws(() => runSuffix('bad'), error => error.code === 'fixture-run-id');
    assert.deepEqual(fixtureNames('update-cache-20261004T120000Z-1234abcd_codex').aliases, ['uc-1234abcd-a', 'uc-1234abcd-b']);
    const h = build(); await h.fixture.prepare();
    const root = path.join(h.evidence, 'fixture'); assert.equal(fs.statSync(root).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(root, '.owner')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(root, '.owner'), 'utf8'), '07'.repeat(24)); assert.equal(fs.existsSync(path.join(root, 'serve', h.manifest.runId)), true);
    assert.equal(fs.existsSync(path.join(root, 'serve', '.owner')), false);
    const gitCalls = argsOf(h, bin => bin === '/usr/bin/git').map(row => row.args.slice(2).join(' '));
    assert.ok(gitCalls.some(call => call.startsWith('init --quiet --bare --initial-branch=main pkg.git')) && gitCalls.some(call => call.startsWith('init --quiet --bare --initial-branch=main agent.git')));
    assert.ok(gitCalls.includes('config user.name Human Operator') && gitCalls.includes('config commit.gpgsign false'));
    await assert.rejects(h.fixture.prepare(), error => error.code === 'fixture-prepared');
    const again = build(); fs.mkdirSync(path.join(again.evidence, 'fixture'));
    await assert.rejects(again.fixture.prepare()); assert.equal(fs.readdirSync(path.join(again.evidence, 'fixture')).length, 0, 'a pre-existing directory is never adopted or populated');
});

test('A and B are different commits of one package name with different marker bytes, served with refreshed server info', async () => {
    const h = build(); await h.fixture.prepare(); const a = await h.fixture.publishPackage('A', 'A-marker'), b = await h.fixture.publishPackage('B', 'B-marker');
    assert.notEqual(a.commit, b.commit); assert.notEqual(a.markerSha256, b.markerSha256); assert.equal(a.markerSha256.length, 64);
    const dir = path.join(h.evidence, 'fixture/work/pkg'); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.0.0');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name, h.fixture.names.packageName); assert.match(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), /B-marker/);
    const calls = argsOf(h, bin => bin === '/usr/bin/git').map(row => row.args.slice(2).join(' '));
    assert.equal(calls.filter(call => call === 'update-server-info').length >= 2, true); assert.ok(calls.includes('push --quiet origin HEAD:main'));
    await assert.rejects(h.fixture.publishPackage('a', 'x'), error => error.code === 'fixture-marker'); await assert.rejects(h.fixture.publishPackage('C', 'bad\nmarker'), error => error.code === 'fixture-marker');
    const agent = await h.fixture.publishAgent(); assert.match(agent, /^c{39}3$/);
    const agentDir = path.join(h.evidence, 'fixture/work/agent/probe'), manifest = JSON.parse(fs.readFileSync(path.join(agentDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, { container: IMAGE, agent: 'node /code/probe.mjs', readiness: { protocol: 'tcp' } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'package.json'), 'utf8')).dependencies[h.fixture.names.packageName], h.fixture.packageUrl);
    assert.equal(h.fixture.packageUrl, `git+http://${h.manifest.fixtureEndpoint.installerIP}:${h.manifest.fixtureEndpoint.port}/${h.manifest.runId}/pkg.git#refs/heads/main`);
});

test('the server is a rootless read-only init container on the exact approved publication with proved ownership', async () => {
    const h = build(); await h.fixture.prepare(); const id = await h.fixture.startServer(); assert.equal(id, H('server'));
    const [run] = argsOf(h, (bin, args) => args[0] === 'run'), e = h.manifest.fixtureEndpoint, args = run.args;
    assert.equal(run.bin, h.manifest.engine.path);
    for (const required of ['--detach', '--init', '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--network=${e.networkMode}`]) assert.ok(args.includes(required), required);
    for (const forbidden of ['--privileged', '--network=host', '--cap-add', '--device', '--pid=host', '--userns=host']) assert.equal(args.some(value => value.startsWith(forbidden)), false, forbidden);
    assert.equal(args[args.indexOf('--publish') + 1], `${e.bindIP}:${e.port}:${e.internalPort}/tcp`); assert.equal(args.filter(value => value === '--publish').length, 1);
    assert.equal(args[args.indexOf('--volume') + 1], `${path.join(h.evidence, 'fixture/serve')}:/srv:ro`); assert.equal(args[args.indexOf(e.imageId)], e.imageId);
    assert.ok(args.includes(`${OWNER_LABEL}=${h.manifest.runId}`)); assert.deepEqual(h.fixture.state().container, H('server'));
    await assert.rejects(h.fixture.startServer(), error => error.code === 'fixture-server-started');
    for (const [label, mutate] of [['label', (m, s) => { s.labels = { [OWNER_LABEL]: 'other', [ROLE_LABEL]: 'update-cache-git-fixture' }; }], ['image', (m, s) => { s.image = H('other-image'); }],
        ['port', (m, s) => { s.port = '9999'; }], ['host ip', (m, s) => { s.hostIp = '0.0.0.0'; }]]) {
        const bad = build(mutate); await bad.fixture.prepare(); await assert.rejects(bad.fixture.startServer(), error => error.code === 'fixture-server-contract', label);
        assert.equal(bad.fixture.state().container, H('server'), `${label}: the created ID stays recorded for owned cleanup`);
    }
});

test('the exact container ID is recovered from the private cidfile even when the launch command fails or its output disagrees', async () => {
    const ok = build(); await ok.fixture.prepare(); await ok.fixture.startServer();
    const [run] = argsOf(ok, (bin, args) => args[0] === 'run'); assert.equal(run.args[run.args.indexOf('--cidfile') + 1], path.join(ok.evidence, 'fixture', 'server.cid')); assert.equal(fs.readFileSync(path.join(ok.evidence, 'fixture', 'server.cid'), 'utf8'), H('server'));
    const failed = build((m, s) => { s.runExit = 125; }); await failed.fixture.prepare();
    await assert.rejects(failed.fixture.startServer(), error => error.code === 'command-exit-unexpected'); assert.equal(failed.fixture.state().container, H('server'), 'a container created before the command failed stays recorded for owned cleanup');
    const disagree = build((m, s) => { s.stdoutId = H('other'); }); await disagree.fixture.prepare();
    await assert.rejects(disagree.fixture.startServer(), error => error.code === 'fixture-server-id'); assert.equal(disagree.fixture.state().container, H('server'));
    const noCid = build((m, s) => { s.noCidfile = true; }); await noCid.fixture.prepare();
    await assert.rejects(noCid.fixture.startServer(), error => error.code === 'fixture-server-id'); assert.equal(noCid.fixture.state().container, H('server'), 'output without a cidfile is still recorded before refusing');
    const garbage = build((m, s) => { s.cidContent = 'not-an-id'; }); await garbage.fixture.prepare(); await assert.rejects(garbage.fixture.startServer(), error => error.code === 'fixture-server-id');
});

test('the recovery snapshot names the exact owned identities and never the private marker content', async () => {
    const h = build(); assert.throws(() => h.fixture.recoverySnapshot(), error => error.code === 'fixture-not-prepared'); await h.fixture.prepare(); await h.fixture.startServer();
    const snapshot = h.fixture.recoverySnapshot(), root = path.join(h.evidence, 'fixture');
    assert.equal(snapshot.runId, h.manifest.runId); assert.equal(snapshot.container.id, H('server')); assert.deepEqual(snapshot.container.labels, { [OWNER_LABEL]: h.manifest.runId, [ROLE_LABEL]: 'update-cache-git-fixture' });
    assert.equal(snapshot.fixtureRoot.path, root); assert.equal(snapshot.fixtureRoot.ino, fs.lstatSync(root).ino); assert.equal(snapshot.marker.ino, fs.lstatSync(path.join(root, '.owner')).ino);
    assert.deepEqual(snapshot.aliases, h.fixture.names.aliases); assert.equal(snapshot.repository.key, h.fixture.names.repoName); assert.equal(snapshot.repository.url, h.fixture.agentUrl);
    assert.equal(JSON.stringify(snapshot).includes(fs.readFileSync(path.join(root, '.owner'), 'utf8')), false);
});

test('Box reachability asks the Box itself and accepts only the exact published commit', async () => {
    const h = build(); await h.fixture.prepare(); const commit = 'c'.repeat(40);
    assert.equal(await h.fixture.reachableFromBox('pkg', commit), true);
    const [reach] = argsOf(h, (bin, args) => args.includes('-e')); assert.deepEqual(reach.args.slice(0, 4), ['container', 'exec', '--env', `PLOINKY_ROUTER_HOST_PORT=${h.manifest.publications[0].hostPort}`]);
    assert.ok(reach.args.includes(h.manifest.box.id)); assert.ok(reach.args.at(-1).includes(`${h.manifest.fixtureEndpoint.installerIP}:${h.manifest.fixtureEndpoint.port}/${h.manifest.runId}/pkg.git/info/refs`));
    h.state.reach = `200 ${'d'.repeat(40)}\trefs/heads/main\n`; assert.equal(await h.fixture.reachableFromBox('pkg', commit), false);
    h.state.reach = 'ERR\n'; assert.equal(await h.fixture.reachableFromBox('agent', commit), false);
    await assert.rejects(h.fixture.reachableFromBox('other', commit), error => error.code === 'fixture-reach-input'); await assert.rejects(h.fixture.reachableFromBox('pkg', 'short'), error => error.code === 'fixture-reach-input');
});

test('cleanup requires quiescent writers and removes only the exact owned server and files', async () => {
    const h = build(); await h.fixture.prepare(); await h.fixture.startServer();
    await assert.rejects(h.fixture.cleanup({ writersQuiescent: false }), error => error.code === 'fixture-cleanup-not-quiescent'); assert.equal(fs.existsSync(path.join(h.evidence, 'fixture')), true);
    assert.deepEqual(await h.fixture.cleanup({ writersQuiescent: true }), { server: 'removed', files: 'removed' });
    const removal = argsOf(h, (bin, args) => args[0] === 'stop' || args[0] === 'rm'); assert.deepEqual(removal.map(row => row.args), [['stop', '--time', '5', H('server')], ['rm', H('server')]]);
    assert.equal(removal.some(row => row.args.includes('-f') || row.args.includes('--force')), false); assert.equal(fs.existsSync(path.join(h.evidence, 'fixture')), false); assert.deepEqual(h.fixture.state().container, null);
    const replaced = build(); await replaced.fixture.prepare(); await replaced.fixture.startServer(); replaced.state.labels = { [OWNER_LABEL]: 'someone-else', [ROLE_LABEL]: 'update-cache-git-fixture' };
    await assert.rejects(replaced.fixture.cleanup({ writersQuiescent: true }), error => error.code === 'fixture-server-replaced');
    assert.equal(argsOf(replaced, (bin, args) => args[0] === 'stop' || args[0] === 'rm').length, 0); assert.equal(fs.existsSync(path.join(replaced.evidence, 'fixture')), true);
    const gone = build(); await gone.fixture.prepare(); await gone.fixture.startServer(); gone.state.containerGone = true;
    assert.deepEqual(await gone.fixture.cleanup({ writersQuiescent: true }), { server: 'absent', files: 'removed' });
});

test('changed marker, replaced directory or unprepared state refuses file removal and publication', async () => {
    const h = build(); await h.fixture.prepare(); fs.writeFileSync(path.join(h.evidence, 'fixture/.owner'), 'not-the-token');
    await assert.rejects(h.fixture.cleanup({ writersQuiescent: true }), error => error.code === 'fixture-ownership-changed'); assert.equal(fs.existsSync(path.join(h.evidence, 'fixture')), true);
    await assert.rejects(h.fixture.publishPackage('A', 'x'), error => error.code === 'fixture-ownership-changed');
    const swapped = build(); await swapped.fixture.prepare(); const root = path.join(swapped.evidence, 'fixture'); fs.renameSync(root, `${root}-moved`); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.owner'), '07'.repeat(24));
    await assert.rejects(swapped.fixture.cleanup({ writersQuiescent: true }), error => error.code === 'fixture-ownership-changed'); assert.equal(fs.existsSync(path.join(root, '.owner')), true);
    const fresh = build(); await assert.rejects(fresh.fixture.publishPackage('A', 'x'), error => error.code === 'fixture-not-prepared'); await assert.rejects(fresh.fixture.startServer(), error => error.code === 'fixture-not-prepared');
    assert.throws(() => createGitFixture({ manifest: fresh.manifest, deps: fresh.fake.deps, probeAgentImage: 'docker.io/library/node:latest' }), error => error.code === 'fixture-inputs');
});
