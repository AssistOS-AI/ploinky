// Real-Router world (adapted from the S3a wire verifier's harness): one live
// world per call. Real RoutingServer and real
// AgentServer from the byte-matched export; a fake SSO provider module, a
// `podman` shim standing in for the container runtime (inspect + exec of the
// export's own RuntimeHttpRelay.mjs in stdio mode), and fictional provider /
// coordinator HTTP servers that record every request they receive.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Starts a world and registers its teardown on `t`. Returns its handles.
export async function startRealRouterWorld(t, { staticAgent = '' } = {}) {
    const EXPORT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const MASTER = 'a7'.repeat(32);
    const NODE = process.execPath;

    const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w-')));
    const savedEnv = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_MASTER_KEY', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MEDIA_HOST_PORT'].map((k) => [k, process.env[k]]));
    process.env.PLOINKY_WORKSPACE_ROOT = ROOT;
    process.env.PLOINKY_MASTER_KEY = MASTER;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

    const imp = (rel) => import(pathToFileURL(path.join(EXPORT, rel)).href);
    const edge = await imp('cli/sandbox/edgeGeneration.js');
    const mk = await imp('cli/utils/security/masterKey.js');
    const assertionLib = await imp('Agent/lib/agentAssertion.mjs');
    const reqHash = await imp('Agent/lib/requestHash.mjs');
    const signed = await imp('Agent/lib/requestSignedTokens.mjs');
    const jwtVerify = await imp('Agent/lib/jwtVerify.mjs');
    const grantLib = await imp('cli/server/mcp-proxy/userDelegationGrant.js');
    const originLib = await imp('cli/server/executionProvider/originToken.mjs');

    async function freePort() {
        const s = net.createServer();
        await new Promise((r) => s.listen(0, '127.0.0.1', r));
        const { port } = s.address();
        await new Promise((r) => s.close(r));
        return port;
    }

    const P = {
        explorer: 'agent:fixtures/explorer',
        unrelated: 'agent:fixtures/unrelated',
        mailer: 'agent:fixtures/mailer',
        provider: 'agent:fixtures/provider',
    };
    const hash = (v) => `sha256:${crypto.createHash('sha256').update(v).digest('hex')}`;
    const rootHost = 'root.synthetic.test';
    const siblingHost = 'sibling.synthetic.test';
    const OWNER_SURFACES = ['agent-mcp', 'blob-transfer', 'browser-auth', 'marketplace-ui', 'user-admin', 'webchat', 'webtty', 'workspace-assets'];

    const ports = {
        pub: await freePort(), priv: await freePort(), agent: await freePort(),
        prov: await freePort(), coord: await freePort(),
    };
    process.env.PLOINKY_ROUTER_HOST_PORT = String(ports.pub);

    const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
    const paths = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: ROOT }).paths;

    function explorerManifest(extra = {}) {
        return {
            enable: ['fixtures/provider'],
            executionProvider: {
                version: 1,
                port: ports.prov,
                taskReferences: { path: '/explorer/task-refs' },
                coordinatorRoutes: [{ path: `/base-agent-additional-server/explorer/${ports.coord}/api/coord/*`, callers: [P.mailer] }],
            },
            ...extra,
        };
    }
    const MANIFESTS = {
        explorer: explorerManifest(),
        bizanso: {
            enable: ['fixtures/mailer'],
            routerAccess: { agentPorts: true, httpRoutes: [
                { path: '/base-agent-additional-server/bizanso/8787/', access: 'public' },
                { path: '/base-agent-additional-server/bizanso/8787/app/*', access: 'authenticated' },
            ] },
        },
        provider: { routerAccess: { httpRoutes: [{ path: '/public/*', access: 'authenticated' }] } },
        mailer: {},
        unrelated: { routerAccess: { httpRoutes: [{ path: '/public/*', access: 'authenticated' }] } },
        identity: { ssoProvider: true },
    };
    const routing = { routes: {} };
    const agents = { _config: { sso: { enabled: true, providerAgent: 'fixtures/identity' } } };
    for (const [index, name] of Object.keys(MANIFESTS).entries()) {
        const hostPath = path.join(ROOT, 'fixtures', name);
        fs.mkdirSync(hostPath, { recursive: true });
        write(path.join(hostPath, 'manifest.json'), MANIFESTS[name]);
        routing.routes[name] = { repo: 'fixtures', agent: name, container: `${name}-container`, hostPath, hostPort: 43101 + index };
        agents[`${name}-container`] = {
            type: 'agent', repoName: 'fixtures', agentName: name, instanceId: `${name}-instance`,
            enableGeneration: `${name}-enable`, runtime: 'podman', containerId: hash(name).slice(7),
            auth: { mode: 'sso' },
        };
    }
    routing.routes.unrelated.hostPort = ports.agent;
    if (staticAgent) routing.static = { agent: staticAgent, port: 8080 };
    agents['explorer-container'].config = { ports: [{ containerPort: ports.coord, hostPort: routing.routes.explorer.hostPort, hostIp: '127.0.0.1', protocol: 'tcp' }] };
    // Fake SSO provider module (two synthetic users chosen by the callback code).
    fs.mkdirSync(path.join(ROOT, 'fixtures', 'identity', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'fixtures', 'identity', 'runtime', 'index.mjs'), `
    const USERS = {
      alice: { id: 'user-alice', username: 'alice', email: 'alice@synthetic.test', roles: ['user'] },
      bob: { id: 'user-bob', username: 'bob', email: 'bob@synthetic.test', roles: ['user'] },
      gina: { id: 'user-gina', username: 'gina', email: 'gina@synthetic.test', roles: ['guest'] },
    };
export function resolveProviderConfig() { return { label: 'fake' }; }
export function createProvider() {
      return {
        async sso_begin_login() { return { authorizationUrl: 'https://idp.synthetic.test/authorize?x=1', providerState: 'ps' }; },
        async sso_handle_callback({ query }) {
          const user = USERS[query.code];
          if (!user) { const e = new Error('bad code'); e.statusCode = 400; throw e; }
          return { user, providerSession: { tokens: { accessToken: 'SENTINELSSOACCESS' + query.code }, expiresAt: Date.now() + 3600e3 } };
        },
        async sso_refresh_session({ providerSession }) {
          const code = String(providerSession?.tokens?.accessToken || '').replace('SENTINELSSOACCESS', '');
          return { user: USERS[code], providerSession };
        },
        async sso_logout() { return {}; },
      };
    }
    `);
    write(paths.routingFile, routing);
    write(paths.agentsFile, agents);
    write(paths.desiredFile, {
        hosts: {
            [rootHost]: { agent: 'fixtures/explorer', routerSurfaces: OWNER_SURFACES, rootApplication: { agent: 'fixtures/bizanso', port: 8787 }, dnsManagement: 'external' },
            [siblingHost]: { agent: 'fixtures/explorer', routerSurfaces: OWNER_SURFACES },
        },
        cloudflare: { accountId: 'fixture-account', zoneId: 'fixture-zone', tunnelName: 'fixture-tunnel', apiTokenSecret: 'publication/fixture-api', deleteTunnelOnTeardown: true },
    });
    fs.mkdirSync(path.join(ROOT, '.ploinky', 'data', 'router-security'), { recursive: true });
    write(path.join(ROOT, '.ploinky', 'data', 'router-security', 'policy-state.json'), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [
            { agent: 'unrelated', tool: 'start_job', access: 'authenticated', enabled: true },
            { agent: 'unrelated', tool: 'agent_job', access: 'internal', enabled: true },
            { agent: 'unrelated', tool: 'hidden_job', access: 'authenticated', enabled: false },
            { agent: 'unrelated', tool: 'undeclared_job', access: 'authenticated', enabled: true },
            { agent: 'unrelated', tool: 'plain_tool', access: 'authenticated', enabled: true },
        ],
    });
    const applyGeneration = (reason = 'verifier') => edge.applyEdgeRoutingGeneration({ workspaceRoot: ROOT, publicationState: 'ready', reason });
    applyGeneration();
    const activeGeneration = () => edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: ROOT });

    // Control-socket identities the Router's relay manager lstat()s before it
    // opens the (darwin) exec transport.
    const controlRoot = path.join(ROOT, '.ploinky', 'run', 'health-probes');
    const socketServers = [];
    for (const name of Object.keys(MANIFESTS)) {
        const dir = path.join(controlRoot, `${name}-container`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
        const cwd = process.cwd();
        process.chdir(dir);
        const s = net.createServer((c) => c.destroy());
        await new Promise((r) => s.listen('runtime-relay.sock', r));
        process.chdir(cwd);
        fs.chmodSync(path.join(dir, 'runtime-relay.sock'), 0o600);
        socketServers.push(s);
    }

    // podman shim
    const binDir = path.join(ROOT, 'bin');
    fs.mkdirSync(binDir);
    const podmanLog = path.join(ROOT, 'podman-calls.log');
    const podmanMap = {};
    for (const name of Object.keys(MANIFESTS)) {
        podmanMap[hash(name).slice(7)] = { name: `${name}-container`, instanceId: `${name}-instance`, enableGeneration: `${name}-enable`, principal: `agent:fixtures/${name}`, source: path.join(controlRoot, `${name}-container`) };
    }
    write(path.join(ROOT, 'podman-map.json'), podmanMap);
    fs.writeFileSync(path.join(binDir, 'podman'), `#!${NODE}
    const fs = require('fs'); const { spawn } = require('child_process');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(podmanLog)}, JSON.stringify(args) + '\\n');
    const map = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'podman-map.json'))}, 'utf8'));
    if (args[0] === 'ps' && args[1] === '--format' && args[2] === '{{.Names}}' && args.length === 3) {
      process.stdout.write(Object.values(map).map((m) => m.name).join('\\n') + '\\n');
      process.exit(0);
    }
    if (args[0] === 'inspect' && map[args[1]]) {
      const m = map[args[1]];
      process.stdout.write(JSON.stringify([{ Id: args[1], Name: '/' + m.name, State: { Running: true, Status: 'running' },
        HostConfig: { NetworkMode: 'bridge' },
        Config: { Labels: { 'io.assistos.ploinky.managed': '1', 'io.assistos.ploinky.resource': 'agent',
          'io.assistos.ploinky.instance-id': m.instanceId, 'io.assistos.ploinky.enable-generation': m.enableGeneration } },
        Mounts: [{ Destination: '/run/ploinky-health-probes', Source: m.source, RW: true, Type: 'bind' }] }]));
      process.exit(0);
    }
    if (args[0] === 'exec' && args[1] === '-i' && map[args[2]] && args[3] === 'node' && args[4] === '/Agent/server/RuntimeHttpRelay.mjs' && args[5] === 'stdio' && args.length === 6) {
      const m = map[args[2]];
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, PLOINKY_AGENT_ID: m.principal };
      const child = spawn(${JSON.stringify(NODE)}, [${JSON.stringify(path.join(EXPORT, 'Agent/server/RuntimeHttpRelay.mjs'))}, 'stdio'], { stdio: 'inherit', env });
      child.on('exit', (code, sig) => process.exit(code === null ? 1 : code));
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      return;
    }
    process.stderr.write('podman shim: unsupported ' + JSON.stringify(args) + '\\n');
    process.exit(125);
    `, { mode: 0o755 });

    // Fictional provider and coordinator servers.
    const received = { prov: [], coord: [] };
    function recorder(kind) {
        return http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks);
                received[kind].push({ method: req.method, url: req.url, headers: req.headers, body: body.toString('utf8'), bodyRaw: body, at: Date.now() });
                const out = Buffer.from(JSON.stringify({ fictional: kind, seen: received[kind].length }));
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': out.length });
                res.end(out);
            });
        });
    }
    const provServer = recorder('prov');
    const coordServer = recorder('coord');
    await new Promise((r) => provServer.listen(ports.prov, '127.0.0.1', r));
    await new Promise((r) => coordServer.listen(ports.coord, '127.0.0.1', r));

    // Real AgentServer for `unrelated` with task-reference tools.
    const agentDir = path.join(ROOT, 'agent-unrelated');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'tool.mjs'), `
    import fs from 'node:fs'; import path from 'node:path';
    const chunks = []; process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const input = payload.input || {}; const meta = payload.metadata || {};
      const tool = process.argv[2]; const provider = process.argv[3];
      fs.writeFileSync(path.join(${JSON.stringify(agentDir)}, 'seen-' + (input.label || 'x') + '.json'), JSON.stringify({
        tool, input, taskRefOrigin: meta.taskRefOrigin || '', metaKeys: Object.keys(meta), invocationToken: meta.invocationToken || '',
        authInfoHeader: meta.requestInfo?.headers?.['x-ploinky-auth-info'] || '',
      }));
      if (provider === '-') { process.stdout.write('plain ok'); return; }
      process.stdout.write(JSON.stringify({ taskRef: { version: 1, provider, id: 'T'.repeat(22) }, state: 'accepted', originRequestId: input.originRequestId }));
    });
    `);
    const trTool = (name, provider) => ({
        name, description: 'fictional', command: NODE, args: [path.join(agentDir, 'tool.mjs'), name, provider], cwd: agentDir,
        ...(provider === '-' ? {} : { taskReference: { version: 1, provider } }),
        inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    });
    fs.writeFileSync(path.join(agentDir, 'mcp-config.json'), JSON.stringify({ tools: [
        trTool('start_job', 'explorer'), trTool('agent_job', 'explorer'), trTool('hidden_job', 'explorer'),
        trTool('undeclared_job', 'mailer'), trTool('plain_tool', '-'),
    ] }));
    const agentLog = path.join(ROOT, 'agent-unrelated.out');
    const agentOut = fs.openSync(agentLog, 'a');
    function cleanEnv(keep = []) {
        const env = { ...process.env };
        for (const k of Object.keys(env)) if ((k.startsWith('PLOINKY_') && !keep.includes(k)) || k === 'PORT') delete env[k];
        return env;
    }
    const agentChild = spawn(NODE, [path.join(EXPORT, 'Agent/server/AgentServer.mjs')], {
        cwd: agentDir,
        env: {
            ...cleanEnv(['PLOINKY_AGENTLIB_DIR']), HOME: agentDir, PORT: String(ports.agent), PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_CONFIG: path.join(agentDir, 'mcp-config.json'),
            PLOINKY_AGENT_SECRET: mk.deriveAgentRequestSecret(P.unrelated, { encoding: 'buffer' }).toString('hex'),
            PLOINKY_AGENT_ID: P.unrelated, AGENT_NAME: P.unrelated, PLOINKY_AGENT_TOOL_DEBUG_LOGS: '1',
        },
        stdio: ['ignore', agentOut, agentOut],
    });

    // Real RoutingServer.
    const stub = path.join(ROOT, 'cf-stub.mjs');
    fs.writeFileSync(stub, "export function createCloudflaredRouterIntegration(){return{getStatus:()=>({state:'test-disabled'}),stop:async()=>{},markPrivateListenerReady(){},markPublicListenerReady(){}};}\n");
    const hooks = path.join(ROOT, 'cf-hooks.mjs');
    fs.writeFileSync(hooks, `const stub=${JSON.stringify(pathToFileURL(stub).href)};const target=${JSON.stringify(pathToFileURL(path.join(EXPORT, 'ploinky-box/cloudflared/index.mjs')).href)};
export async function resolve(s,c,n){const r=await n(s,c);return r.url===target?{url:stub,shortCircuit:true}:r;}\n`);
    const listenLog = path.join(ROOT, 'router-listens.log');
    const register = path.join(ROOT, 'register.mjs');
    fs.writeFileSync(register, `import net from 'node:net'; import fs from 'node:fs'; import { register } from 'node:module';
    register(${JSON.stringify(pathToFileURL(hooks).href)});
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
      if (typeof args[0] === 'number') {
        const cb = args.find((v) => typeof v === 'function');
        const port = args[0] === 8080 ? ${ports.pub} : 0;
        if (cb) this.once('listening', cb);
        this.once('listening', () => fs.appendFileSync(${JSON.stringify(listenLog)}, JSON.stringify({ asked: args[0], got: this.address() }) + '\\n'));
        return listen.call(this, port, '127.0.0.1');
      }
      if (args[0] && typeof args[0] === 'object' && args[0].port === 8081) {
        args[0] = { ...args[0], port: ${ports.priv} };
        this.once('listening', () => fs.appendFileSync(${JSON.stringify(listenLog)}, JSON.stringify({ asked: 8081, got: this.address() }) + '\\n'));
      }
      return listen.apply(this, args);
    };
    `);
    const routerLog = path.join(ROOT, 'router.out');
    const routerOut = fs.openSync(routerLog, 'a');
    const routerHome = path.join(ROOT, 'router-home');
    fs.mkdirSync(routerHome);
    const routerChild = spawn(NODE, ['--import', register, path.join(EXPORT, 'cli/server/RoutingServer.js')], {
        cwd: ROOT,
        env: {
            ...cleanEnv(['PLOINKY_AGENTLIB_DIR']), HOME: routerHome, PATH: `${binDir}:${process.env.PATH}`,
            PLOINKY_WORKSPACE_ROOT: ROOT, PLOINKY_ROUTER_HOST_PORT: String(ports.pub), PLOINKY_MEDIA_HOST_PORT: '17891',
            PLOINKY_MASTER_KEY: MASTER, PLOINKY_ROUTER_HEALTH_SOCKET: path.join(ROOT, 'h.sock'),
            PLOINKY_DEBUG: '1', DEBUG: '1',
        },
        stdio: ['ignore', routerOut, routerOut],
        detached: true,
    });

    async function waitFor(fn, ms, what) {
        const end = Date.now() + ms;
        for (;;) {
            try { if (await fn()) return; } catch {}
            if (Date.now() > end) throw new Error(`timeout: ${what}`);
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    await waitFor(async () => (await fetch(`http://127.0.0.1:${ports.agent}/health`)).ok, 10000, 'AgentServer');
    await waitFor(() => /Ploinky server running/.test(fs.readFileSync(routerLog, 'utf8')) || routerChild.exitCode !== null, 20000, 'router');
    if (routerChild.exitCode !== null) throw new Error('router exited: ' + fs.readFileSync(routerLog, 'utf8'));

    async function shutdown() {
        for (const c of [routerChild, agentChild]) {
            if (c.exitCode === null && c.signalCode === null) {
                const e = once(c, 'exit');
                try { c === routerChild ? process.kill(-c.pid, 'SIGKILL') : c.kill('SIGKILL'); } catch { c.kill('SIGKILL'); }
                await e;
            }
        }
        provServer.close(); coordServer.close();
        for (const s of socketServers) s.close();
    }

    // Raw HTTP client.
    function request({ port = ports.pub, method = 'GET', target, host, headers = {}, body, bodyDelayHook }) {
        if (body === null) body = undefined;
        return new Promise((resolve, reject) => {
            const h = { host: host || `127.0.0.1:${port}`, ...headers };
            if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
            const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: h, agent: false }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
            });
            req.setTimeout(15000, () => req.destroy(new Error(`timeout ${method} ${target}`)));
            req.on('error', reject);
            if (bodyDelayHook && body !== undefined) {
                req.flushHeaders();
                Promise.resolve(bodyDelayHook()).then(() => req.end(body));
            } else req.end(body);
        });
    }

    function setCookies(res) {
        const raw = res.headers['set-cookie'] || [];
        return raw.map((c) => c.split(';')[0]).filter((c) => c.split('=')[1] !== '');
    }


    // Real SSO login through the Router: /auth/login -> fake IdP -> /auth/callback.
    async function login(code, host = rootHost) {
        const a = await request({ target: '/auth/login?returnTo=/', host });
        if (a.status !== 303) throw new Error(`login ${a.status} ${a.body}`);
        const state = new URL(a.headers.location).searchParams.get('state');
        const binding = setCookies(a);
        const b = await request({ target: `/auth/callback?code=${code}&state=${state}`, host, headers: { cookie: binding.join('; ') } });
        if (b.status !== 302) throw new Error(`callback ${b.status} ${b.body}`);
        const cookies = setCookies(b);
        const jar = Object.fromEntries(cookies.map((c) => [c.split('=')[0], c.slice(c.indexOf('=') + 1)]));
        return { code, host, cookies, jar, cookie: cookies.join('; '), csrf: jar.ploinky_browser_csrf };
    }

    t.after(async () => {
        await shutdown();
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 });
    });
    return { EXPORT, MASTER, ROOT, edge, mk, assertionLib, reqHash, signed, jwtVerify, grantLib, originLib, P, hash, rootHost, siblingHost, ports, paths, routing, agents, applyGeneration, activeGeneration, received, agentLog, routerLog, agentDir, shutdown, request, setCookies, login, waitFor };
}
