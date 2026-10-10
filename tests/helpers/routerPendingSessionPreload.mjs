// Second preload, imported after routerTemplatePreload.mjs. A session cookie
// of ploinky_sso=pending makes validateSession wait until the parent sends
// {type:'release'} over the IPC channel; it announces the wait with
// {type:'validate-started'}. Other cookies keep the base stub behaviour.
import net from 'node:net';
import { pathToFileURL } from 'node:url';

// The private listener set binds a fixed 8081 with the object form of listen(),
// which the base preload leaves alone. Use an ephemeral port so this router can
// run beside other real-router tests.
const previousListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
    if (args[0] && typeof args[0] === 'object' && args[0].port === 8081) {
        args[0] = { ...args[0], port: 0 };
    }
    return previousListen.apply(this, args);
};

const sharedUrl = pathToFileURL(`${process.env.PLOINKY_TEST_REPO_ROOT}/cli/server/authHandlers/shared.js`).href;
const { authService } = await import(sharedUrl);
const baseValidate = authService.validateSession;
let releaseWaiters = [];
process.on('message', (message) => {
    if (message?.type !== 'release') return;
    const waiters = releaseWaiters;
    releaseWaiters = [];
    for (const resolve of waiters) resolve();
});
authService.validateSession = async (id) => {
    if (id !== 'pending') return baseValidate(id);
    const released = new Promise((resolve) => { releaseWaiters.push(resolve); });
    process.send({ type: 'validate-started' });
    await released;
    return baseValidate('allowed');
};
