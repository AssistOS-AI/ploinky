import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AcceptanceError, need, LIMITS } from './manifest_codex.mjs';
import { runOwnedCommand, buildCommandEnvironment } from './host_command_codex.mjs';
import { boxExecArgs } from './engine_codex.mjs';
import { runSuffix, fixtureNames } from './owned_ids_codex.mjs';

// The strictly owned Git source for the cache phases: two bare repositories (the dependency package and the probe
// agent) served over dumb HTTP by one run-owned rootless BusyBox container on the selected engine, outside the Box.
// Ownership is proved by a private marker, the recorded inode and the exact container ID plus labels; cleanup removes
// only what these proofs still match and refuses everything else.
export const OWNER_LABEL = 'io.assistos.ploinky-test.owner';
export const ROLE_LABEL = 'io.assistos.ploinky-test.role';
const ROLE = 'update-cache-git-fixture';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export { runSuffix, fixtureNames };

export function createGitFixture({ manifest, deps, probeAgentImage, env = buildCommandEnvironment(process.env), io = fs, gitBin = '/usr/bin/git', random = randomBytes }) {
    need(manifest && deps && typeof probeAgentImage === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,300}@sha256:[a-f0-9]{64}$/.test(probeAgentImage), 'fixture-inputs');
    const names = fixtureNames(manifest.runId), endpoint = manifest.fixtureEndpoint, engine = manifest.engine.path;
    const root = path.join(manifest.evidence.root, 'fixture'), serveRoot = path.join(root, 'serve'), served = path.join(serveRoot, names.relative), work = path.join(root, 'work'), marker = path.join(root, '.owner');
    const url = repo => `http://${endpoint.installerIP}:${endpoint.port}/${names.relative}/${repo}.git`;
    const state = { token: null, rootStat: null, container: null, commits: {}, started: false, prepared: false };
    const run = (operation, kind, argv, extra = {}) => runOwnedCommand({ operation, kind, argv, cwd: extra.cwd ?? manifest.evidence.root, env, deadlineMs: extra.deadlineMs ?? (kind === 'git' ? 30000 : 120000), ...extra }, deps);
    const git = (cwd, args, extra = {}) => run('fixture-git', 'git', [gitBin, '-C', cwd, ...args], { cwd, ...extra });
    const text = result => result.stdout.toString('utf8').trim();
    const identity = { name: null, email: null };

    function assertOwnedRoot() {
        need(state.prepared && state.token, 'fixture-not-prepared');
        const stat = io.lstatSync(root);
        need(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === state.rootStat.dev && stat.ino === state.rootStat.ino && stat.uid === state.rootStat.uid, 'fixture-ownership-changed');
        const bytes = io.readFileSync(marker); need(bytes.toString('utf8') === state.token, 'fixture-ownership-changed');
    }

    return Object.freeze({
        names, url, packageUrl: `git+${url('pkg')}#refs/heads/main`, agentUrl: url('agent'), state: () => ({ prepared: state.prepared, started: state.started, container: state.container, commits: { ...state.commits } }),
        async prepare() {
            need(!state.prepared, 'fixture-prepared');
            io.mkdirSync(root, { mode: 0o700 });                       // exclusive: an existing directory is never adopted
            const stat = io.lstatSync(root); need(stat.isDirectory() && !stat.isSymbolicLink(), 'fixture-ownership-changed');
            state.token = random(24).toString('hex'); state.rootStat = { dev: stat.dev, ino: stat.ino, uid: stat.uid }; state.prepared = true;
            io.writeFileSync(marker, state.token, { flag: 'wx', mode: 0o600 });
            for (const directory of [serveRoot, served, work, path.join(root, 'empty-hooks')]) io.mkdirSync(directory, { mode: 0o700 });
            identity.name = text(await git(manifest.candidate.root, ['config', 'user.name'])); identity.email = text(await git(manifest.candidate.root, ['config', 'user.email']));
            need(identity.name && identity.email && !/[\r\n\0]/.test(identity.name + identity.email), 'fixture-identity');
            for (const repo of ['pkg', 'agent']) {
                await git(served, ['init', '--quiet', '--bare', '--initial-branch=main', `${repo}.git`]);
                await git(work, ['clone', '--quiet', path.join(served, `${repo}.git`), repo]);
                for (const [key, value] of [['user.name', identity.name], ['user.email', identity.email], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(root, 'empty-hooks')]]) await git(path.join(work, repo), ['config', key, value]);
            }
        },
        async publishPackage(label, markerText) {
            assertOwnedRoot(); need(/^[A-Z]$/.test(label) && /^[A-Za-z0-9 ._:-]{1,64}$/.test(markerText), 'fixture-marker');
            const dir = path.join(work, 'pkg');
            io.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: names.packageName, version: '1.0.0', main: 'index.js' }, null, 2)}\n`);
            io.writeFileSync(path.join(dir, 'index.js'), `module.exports = { marker: ${JSON.stringify(markerText)} };\n`);
            await git(dir, ['add', '.']); await git(dir, ['commit', '--quiet', '-m', `Publish ${label}`]); await git(dir, ['push', '--quiet', 'origin', 'HEAD:main']);
            await git(path.join(served, 'pkg.git'), ['update-server-info']);
            const commit = text(await git(dir, ['rev-parse', 'HEAD'])); need(/^[a-f0-9]{40}$/.test(commit), 'fixture-commit');
            const markerSha256 = sha(io.readFileSync(path.join(dir, 'index.js')));
            state.commits[label] = { commit, markerSha256, marker: markerText }; return state.commits[label];
        },
        async publishAgent() {
            assertOwnedRoot(); const dir = path.join(work, 'agent'), agentDir = path.join(dir, names.agentName); io.mkdirSync(agentDir, { recursive: true });
            io.writeFileSync(path.join(agentDir, 'manifest.json'), `${JSON.stringify({ container: probeAgentImage, agent: 'node /code/probe.mjs', readiness: { protocol: 'tcp' } }, null, 2)}\n`);
            io.writeFileSync(path.join(agentDir, 'package.json'), `${JSON.stringify({ name: `uc-probe-agent-${names.suffix}`, version: '1.0.0', private: true, type: 'module', dependencies: { [names.packageName]: `git+${url('pkg')}#refs/heads/main` } }, null, 2)}\n`);
            io.writeFileSync(path.join(agentDir, 'probe.mjs'), [
                "import http from 'node:http';", "import { createRequire } from 'node:module';", 'const require = createRequire(import.meta.url);',
                `const marker = require(${JSON.stringify(names.packageName)}).marker;`, "console.log('UC_MARKER ' + marker);",
                "http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end(marker); }).listen(Number(process.env.PORT || 7000), '0.0.0.0');", ''].join('\n'));
            await git(dir, ['add', '.']); await git(dir, ['commit', '--quiet', '-m', 'Publish owned probe agent']); await git(dir, ['push', '--quiet', 'origin', 'HEAD:main']);
            await git(path.join(served, 'agent.git'), ['update-server-info']);
            return text(await git(dir, ['rev-parse', 'HEAD']));
        },
        async startServer() {
            assertOwnedRoot(); need(!state.started && state.container === null, 'fixture-server-started');
            const created = await run('fixture-server-run', 'mutation', [engine, 'run', '--detach', '--init', '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                `--network=${endpoint.networkMode}`, '--name', names.container, '--label', `${OWNER_LABEL}=${manifest.runId}`, '--label', `${ROLE_LABEL}=${ROLE}`,
                '--publish', `${endpoint.bindIP}:${endpoint.port}:${endpoint.internalPort}/tcp`, '--volume', `${serveRoot}:/srv:ro`, endpoint.imageId,
                'httpd', '-f', '-v', '-p', String(endpoint.internalPort), '-h', '/srv'], { deadlineMs: 120000, maxStdoutBytes: 4096 });
            const id = text(created); need(hex64(id), 'fixture-server-id'); state.container = id; state.started = true;   // recorded before any further fallible step
            const inspected = await run('fixture-server-inspect', 'read', [engine, 'container', 'inspect', '--format', '{{json .Id}}\n{{json .Image}}\n{{json .Config.Labels}}\n{{json .HostConfig.PortBindings}}\n{{json .HostConfig.NetworkMode}}', id], { maxStdoutBytes: 65536 });
            const [rawId, rawImage, rawLabels, rawPorts, rawNetwork] = text(inspected).split('\n').map(line => JSON.parse(line));
            const bindings = rawPorts?.[`${endpoint.internalPort}/tcp`];
            need(rawId === id && String(rawImage).replace(/^sha256:/, '') === endpoint.imageId && rawLabels?.[OWNER_LABEL] === manifest.runId && rawLabels?.[ROLE_LABEL] === ROLE
                && Object.keys(rawPorts ?? {}).length === 1 && Array.isArray(bindings) && bindings.length === 1 && bindings[0].HostIp === endpoint.bindIP && String(bindings[0].HostPort) === String(endpoint.port) && typeof rawNetwork === 'string', 'fixture-server-contract');
            return id;
        },
        // The nested installer path: the Box itself fetches the served refs, never the host.
        async reachableFromBox(repo, expectedCommit) {
            need(['pkg', 'agent'].includes(repo) && /^[a-f0-9]{40}$/.test(expectedCommit), 'fixture-reach-input');
            const script = `fetch(${JSON.stringify(`${url(repo)}/info/refs`)}).then(async r=>{const t=await r.text();console.log(r.status+' '+(t.length<65536?t:'').trim())}).catch(()=>{console.log('ERR');process.exit(1)})`;
            const result = await run('fixture-box-reach', 'read', boxExecArgs({ engineBin: engine, boxId: manifest.box.id, workspace: manifest.workspace.path, routerHostPort: manifest.publications[0].hostPort,
                mediaHostPort: manifest.publications[1].hostPort, argv: ['/usr/local/bin/node', '-e', script] }), { maxStdoutBytes: 65536 });
            return new RegExp(`^200 ${expectedCommit}\\s+refs/heads/main`).test(text(result));
        },
        async cleanup({ writersQuiescent }) {
            need(writersQuiescent === true, 'fixture-cleanup-not-quiescent');
            const result = { server: 'absent', files: 'absent' };
            if (state.container) {
                const inspected = await run('fixture-server-reinspect', 'read', [engine, 'container', 'inspect', '--format', '{{json .Id}}\n{{json .Config.Labels}}', state.container], { maxStdoutBytes: 65536, allowedExitCodes: [0, 125] });
                if (inspected.code === 0) {
                    const [rawId, rawLabels] = text(inspected).split('\n').map(line => JSON.parse(line));
                    need(rawId === state.container && rawLabels?.[OWNER_LABEL] === manifest.runId && rawLabels?.[ROLE_LABEL] === ROLE, 'fixture-server-replaced');
                    await run('fixture-server-stop', 'mutation', [engine, 'stop', '--time', '5', state.container], { deadlineMs: 60000, maxStdoutBytes: 4096 });
                    await run('fixture-server-remove', 'mutation', [engine, 'rm', state.container], { deadlineMs: 60000, maxStdoutBytes: 4096 });
                    result.server = 'removed';
                }
                state.container = null; state.started = false;
            }
            if (state.prepared) {
                assertOwnedRoot(); io.rmSync(root, { recursive: true }); state.prepared = false; result.files = 'removed';
            }
            return result;
        },
    });
}
