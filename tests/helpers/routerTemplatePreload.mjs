// Preload for tests that run the REAL cli/server/RoutingServer.js in a child
// process. It (1) redirects the fixed 8080 listener to a test-chosen loopback
// port and every other numeric listener to an ephemeral loopback port, and
// (2) replaces the SSO session backend with a cookie-driven stub:
//   ploinky_sso=allowed     valid session holding the required capability
//   ploinky_sso=restricted  valid session WITHOUT the required capability
//   anything else           no session (revoked / logged out)
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const publicPort = Number(process.env.PLOINKY_TEST_PUBLIC_PORT);
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
    if (typeof args[0] === 'number') {
        const callback = args.find((value) => typeof value === 'function');
        const port = args[0] === 8080 ? publicPort : 0;
        const server = this;
        if (callback) server.once('listening', callback);
        originalListen.call(server, port, '127.0.0.1');
        return server;
    }
    return originalListen.apply(this, args);
};

const sharedUrl = pathToFileURL(`${process.env.PLOINKY_TEST_REPO_ROOT}/cli/server/authHandlers/shared.js`).href;
const { authService } = await import(sharedUrl);
authService.isConfigured = () => true;
authService.validateSession = async (id) => {
    if (id !== 'allowed' && id !== 'restricted') return null;
    return { user: {
        id: 'provider-user', roles: ['user'], capabilities: id === 'allowed' ? ['app.access'] : [],
    } };
};
authService.refreshSession = async () => {};
authService.getSession = () => null;
authService.getSessionCookieMaxAge = () => 3600;
