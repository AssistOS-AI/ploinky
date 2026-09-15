#!/usr/bin/env node
/** Read pinned source without importing handlers or contacting any service. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const omit = new Set(['.git', 'node_modules', 'tests', 'test', 'evalsSuite', 'docs', 'IDE-plugins', 'public', 'static-files', 'vendor', 'web-components']);
const sourceExtensions = /\.(mjs|js|py|sh)$/;
const roles = (anonymous, selfRegistered, user, admin) => ({ anonymous, selfRegistered, user, admin });
const workspaceRole = roles('deny', 'deny', 'allow-subject-to-resource-policy', 'allow-subject-to-resource-policy');
const adminRole = roles('deny', 'deny', 'deny', 'allow');
const authenticatedRole = roles('deny', 'allow-own-account', 'allow-own-account', 'allow');
const publicRole = roles('allow', 'allow', 'allow', 'allow');
const serviceRole = roles('deny-without-service-proof', 'deny-without-service-proof', 'deny-without-service-proof', 'deny-without-service-proof');
const lineAt = (s, index) => s.slice(0, index).split('\n').length;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function walk(root) {
    const out = [];
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (omit.has(ent.name)) continue;
        const p = path.join(root, ent.name);
        if (ent.isDirectory()) out.push(...walk(p));
        else if (ent.isFile() && sourceExtensions.test(ent.name)) out.push(p);
    }
    return out;
}
function location(root, file, text, needle) {
    const at = text.indexOf(needle);
    return `${path.relative(root, file)}:${at < 0 ? 1 : lineAt(text, at)}`;
}
function expectedTool(agent, name) {
    if (agent === 'workspaceMonitorAgent') return adminRole;
    if (agent === 'emailAgent') return ['email_config_get', 'email_config_set', 'email_provider_status', 'email_send_test'].includes(name) ? adminRole : serviceRole;
    if (agent === 'userPersistoAgent') {
        if (['userpersisto_authorize_capability', 'userpersisto_billing_stripe_webhook_process'].includes(name)) return serviceRole;
        if (/^userpersisto_(profile_|passkey_|totp_|credits_(balance|reserve|commit|release|ledger)$|billing_(checkout_create|subscription_get)$)/.test(name)) return authenticatedRole;
        return adminRole;
    }
    if (agent === 'webmeetAgent' && /^webmeet_room_(create|delete|archive|restore|update)/.test(name)) return adminRole;
    if (agent === 'dpuAgent' && /^dpu_(agent_policy_get|agent_policy_set|audit_list|audit_get|audit_search)$/.test(name)) return adminRole;
    if (agent === 'roboTeamAgent' && /^(robot_create|robot_delete|robot_skillset_)/.test(name)) return adminRole;
    return workspaceRole;
}
function authorizationBasis(agent, name) {
    if (agent === 'userPersistoAgent') return 'userPersistoAgent/tools/registry.mjs: requireActiveActor, capability checks and own-user binding; callback/capability internal boundaries require separate verification';
    if (agent === 'emailAgent') return 'emailAgent/tools/invocation-context.mjs: admin role or verified agent invocation';
    if (agent === 'workspaceMonitorAgent') return 'workspaceMonitorAgent/tools/workspace_monitor_tool.mjs:31 and lib/admin.mjs:5; intended persisted admin role (legacy username shortcut is a candidate vulnerability)';
    if (agent === 'webmeetAgent') return 'webmeetAgent/tools/webmeet_tool.mjs and lib/store/accessPolicy.mjs: room visibility, guest scope, participant identity, admin room lifecycle; non-guest rooms are workspace-shared';
    if (agent === 'dpuAgent') return 'dpuAgent/tools/dpu_tool.mjs -> lib/dpu-store.mjs and lib/dpu-store-internal/identity-acl.mjs: verified invocation, owner/grants, private roots';
    if (agent === 'explorer') return 'explorer/manifest.json:44 requires explorer.access; tool-handlers.mjs validates workspace path and private-data-boundary.mjs';
    if (agent === 'gitAgent') return 'gitAgent/tools/git_tool.mjs:333 verified invocation; workspace Git operations and user-bound GitHub auth; no external Git probes authorized';
    if (agent === 'tasksAgent') return 'tasksAgent/tools/tasks_tool.mjs: workspace-scoped backlog/history files; no handler-level user ACL; expected selfRegistered workspace exclusion needs Router gate';
    return 'Intended passwordless workspace access requires granted user/admin role; manifest/Router caller policy and tool-specific authorization must enforce this. Authentication alone does not establish workspace access.';
}

export function buildAgentInventory({ preflight, workspace, explorerSource, ploinkySource, runtimeSummary }) {
    const catalog = [];
    const inventory = [];
    const unsupported = [];
    const seenRepos = new Set();
    const repoSources = {};
    for (const repo of preflight.repositories) {
        if (repo.name === 'smoke-harness' || seenRepos.has(repo.name)) continue;
        seenRepos.add(repo.name);
        const root = repo.name === 'ploinky' ? ploinkySource : repo.name === 'AchillesIDE' ? explorerSource : path.join(workspace, repo.path);
        if (!fs.existsSync(root)) throw new Error(`Missing source for ${repo.name}`);
        const actual = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        // Ploinky may contain this suite on top of its deployment baseline; runtime code remains pinned separately.
        if (repo.name !== 'ploinky' && actual !== repo.commit) throw new Error(`Revision mismatch for ${repo.name}`);
        repoSources[repo.name] = { root, revision: repo.commit };
        const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'manifest.json')));
        if (!dirs.length) unsupported.push({ repo: repo.name, revision: repo.commit, reason: 'No first-level Ploinky agent manifest; library, vendor or image-build dependency, not an independently registered agent.' });
        for (const dir of dirs) {
            // Tests/fixtures and nested dependencies cannot add deployed agents without a repository manifest entry.
            if (dir.name === 'tests' || dir.name.startsWith('.')) continue;
            const agent = dir.name;
            const agentRoot = path.join(root, agent);
            const mf = path.join(agentRoot, 'manifest.json');
            const manifestText = fs.readFileSync(mf, 'utf8');
            const manifest = JSON.parse(manifestText);
            const configFile = path.join(agentRoot, 'mcp-config.json');
            const configText = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
            const config = configText ? JSON.parse(configText) : {};
            const toolList = config.tools || [];
            if (!Array.isArray(toolList)) throw new Error(`Non-array tool declaration: ${repo.name}/${agent}`);
            const runtime = runtimeSummary.runtimes.find((r) => r.repo === repo.name && r.agent === agent);
            const enabled = runtime?.enabled === true;
            const files = walk(agentRoot).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
            const common = { repo: repo.name, agent, revision: repo.commit, enabled };
            const add = (record) => inventory.push({ ...common, ...record, ...(!enabled ? { gap: `Disabled/on-demand runtime. ${record.gap || ''}` } : {}), id: `${repo.name}/${agent}:${record.method}:${record.path}${record.tool ? `#${record.tool}` : ''}:${record.transport}`, coverage: record.coverage || 'inventoried-not-exercised' });
            const ports = new Set();
            for (const policy of manifest.routerAccess?.httpRoutes || []) {
                const match = policy.path.match(/\/base-agent-additional-server\/[^/]+\/(\d+)/);
                if (match) ports.add(Number(match[1]));
                const access = policy.access === 'public' ? publicRole : policy.access === 'guest' ? roles('requires-scoped-guest-or-public-protocol', 'allow-subject-to-handler-policy', 'allow-subject-to-handler-policy', 'allow-subject-to-handler-policy') : workspaceRole;
                add({ method: (policy.publicProtocol?.methods || ['*']).join('|'), path: policy.path.startsWith('/base-agent-additional-server/') ? policy.path : `/${agent}${policy.path}`, transport: 'manifest-policy-family', source: `${repo.name}/${agent}/manifest.json:${lineAt(manifestText, manifestText.indexOf(JSON.stringify(policy.path)))}`, expected: access, authorizationBasis: 'Executable manifest route policy; this wildcard denotes an open route family, not an enumerated endpoint.', gap: 'Wildcard requires concrete handler/static/backend reconciliation; no authorization pass may be inferred from policy alone.' });
            }
            for (const profile of Object.values(manifest.profiles || {})) for (const port of profile.openPorts || []) ports.add(Number(String(port).split(':').at(-1)));
            const source = `ploinky/Agent/server/AgentServer.mjs`;
            for (const [method, suffix, line, transport, need] of [
                ['GET', '/health', 1248, 'http', 'Read-only protocol health; some custom agent servers replace this common handler.'],
                ['GET', '/agent-card', 1251, 'discovery', manifest.endpoints?.['agent-card'] ? '' : 'No configured agent-card; expected endpoint absence is not an authorization result.'],
                ['GET', '/task', 1264, 'http', 'Requires existing test-owned asynchronous task; verifies request proof but task-owner isolation also needs a live cross-user control.'],
                ['GET', '/getTaskStatus', 1264, 'http', 'Alias of /task; requires existing test-owned asynchronous task.'],
                ['POST', '/task/cancel', 1287, 'http', 'Requires live test-owned task and side-effect check.'],
                ['GET', '/mcp', 1316, 'sse', 'Requires initialized MCP session and cross-principal session isolation.'],
                ['DELETE', '/mcp', 1316, 'mcp-session', 'Only close a test-owned initialized MCP session.'],
                ['POST', '/mcp', 1334, 'mcp-discovery', toolList.length ? '' : 'No static mcp-config; protocol may expose defaults or image-owned tools. Reconcile live discovery.'],
                ['POST', '/v1/chat/completions', 1384, 'http+sse', 'Inference can contact external providers; inventory only, no completion request in local-only suite.'],
                ['GET', '/v1/models', 1409, 'discovery', 'Model metadata may be default-generated; require an actual JSON response positive control.'],
                ['GET|HEAD', '/*', 1415, 'static-family', 'Dynamic file namespace; check allowlisted representative assets and test-owned private paths.'],
            ]) add({ method, path: `/${agent}${suffix}`, transport, source: `${source}:${line}`, expected: workspaceRole, authorizationBasis: authorizationBasis(agent), gap: enabled ? need || undefined : 'Disabled/on-demand agent; do not enable it merely to test. Registry visibility only; no functional positive control.', commonHandler: true });
            for (const tool of toolList) {
                const match = new RegExp(`"name"\\s*:\\s*"${tool.name}"`).exec(configText);
                const index = match?.index ?? -1;
                if (!tool.name || index < 0) throw new Error(`Tool declaration requires review: ${repo.name}/${agent}`);
                const handlerSources = files.filter(({ text }) => text.includes(`'${tool.name}'`) || text.includes(`"${tool.name}"`) || text.includes(`${tool.name}:`)).map(({ file, text }) => `${repo.name}/${location(root, file, text, tool.name)}`).slice(0, 8);
                const command = String(tool.command || '').replace(/^\/code\//, '');
                const commandFile = path.join(agentRoot, command);
                if (fs.existsSync(commandFile)) handlerSources.unshift(`${repo.name}/${path.relative(root, commandFile)}:1`);
                for (const argument of tool.args || []) {
                    if (typeof argument !== 'string' || !sourceExtensions.test(argument)) continue;
                    const candidate = path.join(agentRoot, argument.replace(/^\/code\//, ''));
                    if (fs.existsSync(candidate)) handlerSources.unshift(`${repo.name}/${path.relative(root, candidate)}:1`);
                }
                add({ method: 'POST', path: `/${agent}/mcp`, tool: tool.name, transport: 'mcp-tools/call', source: `${repo.name}/${agent}/mcp-config.json:${lineAt(configText, index)}`, handlerSources: [...new Set(handlerSources)], expected: tool.tags?.includes('internal') ? serviceRole : tool.tags?.includes('admin') ? adminRole : expectedTool(agent, tool.name), policyTags: tool.tags || [], authorizationBasis: authorizationBasis(agent, tool.name), inputArguments: Object.keys(tool.inputSchema?.properties || tool.inputSchema || {}), gap: !enabled ? 'Disabled/on-demand runtime; tool declared but invocation not exercised.' : handlerSources.length ? 'Declared dispatcher and source references located; live coverage must identify this exact tool and argument boundary.' : 'Command is image-owned or generated; actual handler source unresolved. Do not count declaration as verified implementation.' });
            }
            catalog.push({ ...common, manifestSource: `${repo.name}/${agent}/manifest.json:1`, routerAccess: manifest.routerAccess || {}, tools: toolList.map((t) => t.name), additionalPorts: [...ports].sort((a, b) => a - b), endpointDeclarations: Object.keys(manifest.endpoints || {}), runtimeState: runtime?.state || 'disabled-or-on-demand', gap: enabled ? undefined : 'Manifest exists in deployed repository but not present in recorded running graph.' });
        }
    }
    for (const r of runtimeSummary.runtimes) if (!catalog.some((a) => a.repo === r.repo && a.agent === r.agent)) throw new Error(`Runtime missing from manifest inventory: ${r.repo}/${r.agent}`);
    return { catalog, inventory, unsupported, repoSources };
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!/^--[a-z-]+$/.test(argv[i]) || !argv[i + 1]) throw new Error('Expected named argument pairs.');
        args[argv[i].slice(2)] = argv[i + 1];
    }
    for (const key of ['preflight', 'workspace', 'explorer-source', 'ploinky-source', 'runtime-summary', 'out']) if (!args[key]) throw new Error(`Missing --${key}`);
    return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const args = parseArgs(process.argv.slice(2));
    const result = buildAgentInventory({ preflight: readJson(args.preflight), workspace: args.workspace, explorerSource: args['explorer-source'], ploinkySource: args['ploinky-source'], runtimeSummary: readJson(args['runtime-summary']) });
    const customModule = await import('./inventory-http.mjs');
    result.inventory.push(...customModule.customHttpInventory(result.catalog, result.repoSources));
    const output = `// Regenerate with inventory-generate.mjs. No credentials or absolute host paths are embedded.\nexport const inventoryBaseline = ${JSON.stringify({ repositories: readJson(args.preflight).repositories.map(({ name, commit }) => ({ name, commit })), recordedRuntimeCount: readJson(args['runtime-summary']).runtimes.length }, null, 2)};\n\nexport const agentCatalog = ${JSON.stringify(result.catalog, null, 2)};\n\nexport const agentInventory = [\n${result.inventory.map((r) => '  ' + JSON.stringify(r)).join(',\n')}\n];\n\nexport const nonAgentRepositories = ${JSON.stringify(result.unsupported, null, 2)};\n`;
    fs.writeFileSync(args.out, output);
    process.stdout.write(JSON.stringify({ agents: result.catalog.length, enabled: result.catalog.filter((a) => a.enabled).length, endpointsAndTools: result.inventory.length, tools: result.inventory.filter((r) => r.tool).length }) + '\n');
}
