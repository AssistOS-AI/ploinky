import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR } from '../utils/config.js';
import { debugLog, parseParametersString } from '../utils/utils.js';
import { resolvePersistedRouterPort } from '../sandbox/routerPort.js';
import { createAgentClient as createBrowserClient } from '../../Agent/client/MCPBrowserClient.js';
import { mintSessionJwt } from '../server/auth/localService.js';

const LOCAL_AUTH_COOKIE_NAME = 'ploinky_jwt';

export function buildLocalCliSessionHeaders() {
    try {
        const token = mintSessionJwt({
            id: 'local:admin',
            username: 'admin',
            name: 'Local CLI',
            email: '',
            roles: ['user', 'admin'],
        }, 1, { channel: 'cli' });
        return { cookie: `${LOCAL_AUTH_COOKIE_NAME}=${token}` };
    } catch (_) {
        return {};
    }
}

class ClientCommands {
    constructor() {
        this.configPath = path.join(PLOINKY_DIR, 'cloud.json');
        this.loadConfig();
        this._toolCache = null;
    }

    getToolAgentName(tool) {
        const routerInfo = tool && tool.annotations && typeof tool.annotations === 'object'
            ? tool.annotations.router
            : null;
        if (routerInfo && typeof routerInfo.agent === 'string') {
            return routerInfo.agent;
        }
        if (tool && typeof tool.agent === 'string') {
            return tool.agent;
        }
        return null;
    }

    getResourceAgentName(resource) {
        const routerInfo = resource && resource.annotations && typeof resource.annotations === 'object'
            ? resource.annotations.router
            : null;
        if (routerInfo && typeof routerInfo.agent === 'string') {
            return routerInfo.agent;
        }
        if (resource && typeof resource.agent === 'string') {
            return resource.agent;
        }
        return null;
    }

    loadConfig() {
        if (fs.existsSync(this.configPath)) {
            const configData = fs.readFileSync(this.configPath, 'utf8');
            this.config = JSON.parse(configData);
        } else {
            this.config = {};
        }
    }

    getRouterPort() {
        return resolvePersistedRouterPort();
    }

    async withRouterClient(fn) {
        const baseUrl = `http://127.0.0.1:${this.getRouterPort()}/mcp`;
        const client = createBrowserClient(baseUrl, {
            requestHeaders: buildLocalCliSessionHeaders(),
        });
        try {
            return await fn(client);
        } finally {
            await client.close().catch(() => { });
        }
    }

    // Removed legacy PloinkyClient-based call; using local RoutingServer instead.

    formatToolLine(tool) {
        const agent = this.getToolAgentName(tool) || 'unknown';
        const name = tool && tool.name ? String(tool.name) : '(unnamed)';
        const title = tool && tool.title && tool.title !== name ? ` (${tool.title})` : '';
        const description = tool && tool.description ? ` - ${tool.description}` : '';
        return `- [${agent}] ${name}${title}${description}`;
    }

    formatResourceLine(resource) {
        const agent = this.getResourceAgentName(resource) || 'unknown';
        const uri = resource && resource.uri ? String(resource.uri) : '(no-uri)';
        const name = resource && resource.name && resource.name !== uri ? ` (${resource.name})` : '';
        const description = resource && resource.description ? ` - ${resource.description}` : '';
        return `- [${agent}] ${uri}${name}${description}`;
    }

    printAggregatedList(items, formatter) {
        const hasItems = Array.isArray(items) && items.length > 0;

        if (hasItems) {
            for (const item of items) {
                console.log(formatter(item));
            }
        }

        if (!hasItems) {
            console.log('No entries found.');
        }
    }

    async listTools() {
        try {
            const tools = await this.withRouterClient(async (client) => client.listTools());
            this._toolCache = Array.isArray(tools) ? tools : [];
            this.printAggregatedList(this._toolCache, this.formatToolLine.bind(this));
        } catch (err) {
            const message = err && err.message ? err.message : String(err || '');
            console.log(`Failed to retrieve tool list: ${message}`);
        }
    }

    async listResources() {
        try {
            const resources = await this.withRouterClient(async (client) => client.listResources());
            const list = Array.isArray(resources) ? resources : [];
            this.printAggregatedList(list, this.formatResourceLine.bind(this));
        } catch (err) {
            const message = err && err.message ? err.message : String(err || '');
            console.log(`Failed to retrieve resource list: ${message}`);
        }
    }

    async getAgentStatus(agentName) {
        if (!agentName) {
            console.log('Usage: client status <agentName>');
            console.log('Example: client status myAgent');
            return;
        }
        try {
            await this.withRouterClient(async (client) => {
                const meta = { router: { agent: agentName } };
                let ok = true;
                let message = 'MCP ping succeeded.';

                try {
                    await client.ping(meta);
                } catch (err) {
                    const reason = err?.message ? err.message : String(err || 'Unknown error');
                    message = `MCP ping failed: ${reason}`;
                    ok = false;
                }

                console.log(`${agentName}: ok=${ok}`);
                if (message) {
                    console.log(message.trim());
                }
            });
        } catch (err) {
            const message = err && err.message ? err.message : String(err || '');
            console.log(`Failed to retrieve status for '${agentName}': ${message}`);
        }
    }

    async findToolAgent(toolName) {
        if (!this._toolCache) {
            try {
                const tools = await this.withRouterClient(async (client) => client.listTools());
                this._toolCache = Array.isArray(tools) ? tools : [];
            } catch (_) {
                this._toolCache = [];
            }
        }
        const matchingTools = this._toolCache.filter(t => t.name === toolName);
        if (matchingTools.length === 0) {
            return { agent: null, error: 'not_found' };
        }
        if (matchingTools.length > 1) {
            const agents = Array.from(new Set(matchingTools
                .map(tool => this.getToolAgentName(tool))
                .filter(Boolean)));
            return { agent: null, error: 'ambiguous', agents };
        }
        const tool = matchingTools[0];
        const agent = this.getToolAgentName(tool);
        if (!agent) {
            return { agent: null, error: 'not_found' };
        }
        return { agent, error: null };
    }

    async callTool(toolName, payloadObj = {}, targetAgent = null) {
        if (!toolName) {
            console.error('Missing tool name. Usage: client tool <toolName> [--agent <agent>] [-p <params>] [-key value ...]');
            return;
        }

        let agent = targetAgent;
        if (!agent) {
            const findResult = await this.findToolAgent(toolName);
            if (findResult.error === 'not_found') {
                console.error(`Tool '${toolName}' not found on any active agent.`);
                return;
            }
            if (findResult.error === 'ambiguous') {
                const errPayload = {
                    error: 'ambiguous tool',
                    message: `Tool '${toolName}' was found on multiple agents. Please specify one with --agent.`,
                    agents: findResult.agents
                };
                console.log(JSON.stringify(errPayload, null, 2));
                return;
            }
            agent = findResult.agent;
            debugLog(`--> Found tool '${toolName}' on agent '${agent}'. Calling...`);
        }

        try {
            await this.withRouterClient(async (client) => {
                const result = await client.callTool(toolName, payloadObj, { agent });
                console.log(JSON.stringify(result, null, 2));
            });
        } catch (err) {
            const message = err && err.message ? err.message : String(err || '');
            console.log(`Failed to call tool: ${message}`);
        }
    }

    async getTaskStatus(agentName, taskId) {
        if (!agentName || !taskId) {
            console.log('Usage: client task-status <agent> <task-id>');
            console.log('Example: client task-status myAgent task-123');
            return;
        }

        console.log('Not standardized. If supported by your agent, call its status method via:');
        console.log("  client call <path-or-agent> 'task.status' <taskId>");
    }

    async handleClientCommand(args) {
        const [subcommand, ...options] = args;
        debugLog(`Handling client command: '${subcommand}' with options: [${options.join(', ')}]`);

        switch (subcommand) {
            case 'call':
                console.log('client call is no longer supported. Use "client tool <toolName>" instead.');
                break;
            case 'methods':
                console.log('client methods has been replaced by "client list tools". Showing aggregated tools:');
                await this.listTools();
                break;
            case 'status':
                await this.getAgentStatus(options[0]);
                break;
            case 'list':
                if (!options.length) {
                    console.log('Usage: client list <tools|resources>');
                    break;
                }
                switch ((options[0] || '').toLowerCase()) {
                    case 'tools':
                        await this.listTools();
                        break;
                    case 'resources':
                        await this.listResources();
                        break;
                    default:
                        console.log('Unknown list option. Supported: tools, resources');
                        break;
                }
                break;
            case 'tool': {
                if (!options.length) {
                    console.log('Usage: client tool <toolName> [--agent <agent>] [--parameters <params> | -p <params>] [-key val ...]');
                    console.log('Example: client tool echo -text "Hello"');
                    console.log('Example: client tool plan --agent demo -p steps[]=1,2,3');
                    break;
                }

                const toolName = options[0];
                let idx = 1;
                const coerceValue = (s) => {
                    if (s === undefined || s === null) return s;
                    if (typeof s !== 'string') return s;
                    const trimmed = s.trim();
                    if (!trimmed) return trimmed;
                    const lower = trimmed.toLowerCase();
                    if (lower === 'true') return true;
                    if (lower === 'false') return false;
                    if (lower === 'null') return null;
                    const n = Number(trimmed);
                    return Number.isFinite(n) && String(n) === trimmed ? n : s;
                };

                const mergeFields = (target, source) => {
                    if (!source || typeof source !== 'object') return target;
                    for (const [key, value] of Object.entries(source)) {
                        if (Array.isArray(value)) {
                            if (!Array.isArray(target[key])) {
                                target[key] = [];
                            }
                            target[key].push(...value);
                            continue;
                        }
                        if (value && typeof value === 'object') {
                            if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
                                target[key] = {};
                            }
                            mergeFields(target[key], value);
                            continue;
                        }
                        target[key] = value;
                    }
                    return target;
                };

                const applyField = (target, rawKey, rawValue) => {
                    if (!rawKey) return;
                    const segments = String(rawKey).split('.');
                    let current = target;
                    for (let i = 0; i < segments.length; i++) {
                        let segment = segments[i];
                        const isArrayKey = segment.endsWith('[]');
                        if (isArrayKey) {
                            segment = segment.slice(0, -2);
                        }
                        const isLast = i === segments.length - 1;
                        if (isLast) {
                            if (isArrayKey) {
                                if (!Array.isArray(current[segment])) {
                                    current[segment] = [];
                                }
                                const values = Array.isArray(rawValue) ? rawValue : [rawValue];
                                for (const val of values) {
                                    if (val === undefined) continue;
                                    current[segment].push(val);
                                }
                            } else {
                                current[segment] = rawValue;
                            }
                        } else {
                            if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
                                current[segment] = {};
                            }
                            current = current[segment];
                        }
                    }
                };

                let fields = {};
                let targetAgent = null;

                while (idx < options.length) {
                    const tok = String(options[idx] || '');

                    if (tok === '--parameters' || tok === '-p') {
                        const parametersString = options[idx + 1] || '';
                        if (parametersString) {
                            try {
                                const parsedParams = parseParametersString(parametersString);
                                fields = mergeFields(fields, parsedParams);
                            } catch (e) {
                                console.error(`Error parsing parameters: ${e.message}`);
                                return;
                            }
                        }
                        idx += 2;
                        continue;
                    }

                    if (tok === '--agent' || tok === '-a') {
                        const agentValue = options[idx + 1];
                        if (!agentValue) {
                            console.error('Missing value for --agent');
                            return;
                        }
                        targetAgent = String(agentValue);
                        idx += 2;
                        continue;
                    }

                    if (tok.startsWith('-')) {
                        const key = tok.replace(/^[-]+/, '');
                        const next = options[idx + 1];
                        if (next !== undefined && !String(next).startsWith('-')) {
                            applyField(fields, key, coerceValue(next));
                            idx += 2;
                        } else {
                            applyField(fields, key, true);
                            idx += 1;
                        }
                        continue;
                    }

                    idx += 1;
                }

                await this.callTool(toolName, fields, targetAgent);
                break;
            }
            case 'task':
                console.log('client task has been replaced by client tool. Use: client tool <toolName> [...]');
                break;
            case 'task-status':
                await this.getTaskStatus(options[0], options[1]);
                break;
            default:
                console.log('Client commands:');
                console.log('  client tool <toolName> [--agent <agent>] [-p <params>] [-key val]  - Call an MCP tool');
                console.log('  client list tools                 - List all tools exposed by registered agents');
                console.log('  client list resources             - List all resources exposed by registered agents');
                console.log('  client status <agentName>         - Calls agent via Router with {command:"status"}');
        }
    }
}

export default ClientCommands;
