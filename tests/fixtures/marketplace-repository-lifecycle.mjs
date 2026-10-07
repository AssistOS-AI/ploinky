import { setupProcessLifecycle } from '../../cli/server/utils/processLifecycle.js';

const [mode, requestedCode = '0'] = process.argv.slice(2);
const state = { fixture: { sessions: new Map([['active', {}]]) } };
const server = {
    address: () => ({ port: 18080 }),
    close(callback) { console.log('SERVER_CLOSE'); callback(); },
    unref() {},
};
const lifecycle = setupProcessLifecycle(server, state, {
    clear() { console.log(`SESSIONS_CLEARED:${state.fixture.sessions.size}`); },
}, {
    beforeClose: [async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        console.log('LEGACY_CLEANUP_FINISHED');
        if (mode === 'legacy-reject') throw new Error('legacy fixture rejection');
    }, async () => { console.log('SECOND_CLEANUP_FINISHED'); }],
    requiredBeforeClose: mode === 'legacy-reject' ? [] : [async () => {
        console.log('REQUIRED_CLEANUP_ENTERED');
        if (mode === 'hang') return new Promise(() => {});
        if (mode === 'reject') throw new Error('PRIVATE_REQUIRED_FAILURE_DETAILS');
        if (mode === 'invalid') return undefined;
        return mode === 'success' ? { ok: true }
            : { ok: false, code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' };
    }],
});
lifecycle.gracefulShutdown('fixture', Number(requestedCode));
