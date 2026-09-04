import { getSession, isAdminUser } from '../auth/localService.js';
import { authService } from '../authHandlers/shared.js';
import { localSessionAllowedForRoutePlan } from '../authHandlers/authContext.js';

import { PolicyStateRepository } from './PolicyStateRepository.js';
import { FileSystemPolicyStateStore } from './FileSystemPolicyStateStore.js';
import { PolicyAuditLog } from './PolicyAuditLog.js';
import { FileSystemPolicyAuditSink } from './FileSystemPolicyAuditSink.js';
import { HttpRouteAccessPolicy } from './HttpRouteAccessPolicy.js';
import { McpToolPolicy } from './McpToolPolicy.js';
import { Caller } from './Caller.js';
import { HttpShareAuthorizer } from './HttpShareAuthorizer.js';
import { PolicyCommandRegistry } from './PolicyCommandRegistry.js';
import { PolicyCommandInvoker } from './PolicyCommandInvoker.js';
import {
    HttpRouteSetCommand,
    HttpRouteRemoveCommand,
    HttpRouteCheckCommand,
    HttpRouteListCommand,
} from './commands/httpRouteCommands.js';
import {
    McpPolicySetCommand,
    McpPolicyGetCommand,
    McpPolicyListCommand,
} from './commands/mcpPolicyCommands.js';

/**
 * Composition root for the router access-control policy layer (DS015/DS016).
 * Instantiates the singletons once and wires the 7 commands into the registry +
 * invoker. Nothing outside `policy/` constructs these classes — `RoutingServer`,
 * `mcp-proxy/index.js`, and `routerHandlers.js` import `policy` and call methods.
 */

// The composition root is the single place the persistence strategy is chosen.
// Policy state and audit files are durable Ploinky-owned data. Workspace Monitor
// controls retention through the private log-maintenance operation.
const repository = new PolicyStateRepository({ store: new FileSystemPolicyStateStore() });
const auditLog = new PolicyAuditLog({ sink: new FileSystemPolicyAuditSink() });
const httpRouteAccessPolicy = new HttpRouteAccessPolicy({ repository });
const mcpToolPolicy = new McpToolPolicy({ repository });
const shareAuthorizer = new HttpShareAuthorizer();

const registry = new PolicyCommandRegistry()
    .register(new HttpRouteSetCommand({ repository, authorizer: shareAuthorizer }))
    .register(new HttpRouteRemoveCommand({ repository, authorizer: shareAuthorizer }))
    .register(new HttpRouteCheckCommand({ routeAccessPolicy: httpRouteAccessPolicy }))
    .register(new HttpRouteListCommand({ repository }))
    .register(new McpPolicySetCommand({ repository }))
    .register(new McpPolicyGetCommand({ repository }))
    .register(new McpPolicyListCommand({ repository }));

const commandInvoker = new PolicyCommandInvoker({
    registry, auditLog, getSession, isAdminUser,
    allowLocalSession: localSessionAllowedForRoutePlan,
    getProviderSession: (id) => authService.isConfigured()
        ? authService.validateSession(id, { forceRemote: true })
        : null,
});

export const policy = {
    repository,
    auditLog,
    httpRouteAccessPolicy,
    mcpToolPolicy,
    shareAuthorizer,
    commandInvoker,
    resolveCaller: (req) => Caller.fromRequest(req),
};

export default policy;
