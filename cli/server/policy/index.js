import { getSession, isLocalAdminUser } from '../auth/localService.js';

import { PolicyStateRepository } from './PolicyStateRepository.js';
import { FileSystemPolicyStateStore } from './FileSystemPolicyStateStore.js';
import { PolicyAuditLog } from './PolicyAuditLog.js';
import { FileSystemPolicyAuditSink } from './FileSystemPolicyAuditSink.js';
import { HttpRouteWhitelist } from './HttpRouteWhitelist.js';
import { McpToolPolicy } from './McpToolPolicy.js';
import { Caller } from './Caller.js';
import { HttpShareAuthorizer } from './HttpShareAuthorizer.js';
import { PolicyCommandRegistry } from './PolicyCommandRegistry.js';
import { PolicyCommandInvoker } from './PolicyCommandInvoker.js';
import {
    HttpWhitelistAddCommand,
    HttpWhitelistRemoveCommand,
    HttpWhitelistCheckCommand,
    HttpWhitelistListCommand,
} from './commands/httpWhitelistCommands.js';
import {
    McpPolicySetCommand,
    McpPolicyGetCommand,
    McpPolicyListCommand,
} from './commands/mcpPolicyCommands.js';

/**
 * Composition root for the router access-control policy layer (DS013/DS014).
 * Instantiates the singletons once and wires the 7 commands into the registry +
 * invoker. Nothing outside `policy/` constructs these classes — `RoutingServer`,
 * `mcp-proxy/index.js`, and `routerHandlers.js` import `policy` and call methods.
 */

// The composition root is the single place the persistence strategy is chosen.
// Swapping to a database = construct a different PolicyStateStore / PolicyAuditSink
// here; nothing else in policy/ changes.
const repository = new PolicyStateRepository({ store: new FileSystemPolicyStateStore() });
const auditLog = new PolicyAuditLog({ sink: new FileSystemPolicyAuditSink() });
const httpWhitelist = new HttpRouteWhitelist({ repository });
const mcpToolPolicy = new McpToolPolicy({ repository });
const shareAuthorizer = new HttpShareAuthorizer();

const registry = new PolicyCommandRegistry()
    .register(new HttpWhitelistAddCommand({ repository, authorizer: shareAuthorizer }))
    .register(new HttpWhitelistRemoveCommand({ repository, authorizer: shareAuthorizer }))
    .register(new HttpWhitelistCheckCommand({ whitelist: httpWhitelist }))
    .register(new HttpWhitelistListCommand({ repository }))
    .register(new McpPolicySetCommand({ repository }))
    .register(new McpPolicyGetCommand({ repository }))
    .register(new McpPolicyListCommand({ repository }));

const commandInvoker = new PolicyCommandInvoker({ registry, auditLog, getSession, isAdminUser: isLocalAdminUser });

export const policy = {
    repository,
    auditLog,
    httpWhitelist,
    mcpToolPolicy,
    shareAuthorizer,
    commandInvoker,
    resolveCaller: (req) => Caller.fromRequest(req),
};

export default policy;
