import { setupProcessLifecycle } from '../../cli/server/utils/processLifecycle.js';
import fsPromises from 'node:fs/promises';
import { runMarketplaceRepositoryWorker, shutdownMarketplaceRepositoryWorkers } from '../../cli/server/marketplaceRepositoryWorker.mjs';

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
        if (mode === 'late-first-request') {
            // The control that restores admission must fail before any real
            // process observation/spawn. A closed export never reaches this.
            const opendir = fsPromises.opendir;
            fsPromises.opendir = async () => { console.log('UNEXPECTED_CENSUS'); throw new Error('fixture forbids process observation'); };
            try {
                await runMarketplaceRepositoryWorker({ operation: { action: 'install_repo', url: './unused' },
                    rawBodyBytes: 20, cwd: process.cwd(), workspaceRoot: process.cwd() });
                console.log('LATE_REQUEST_ADMITTED');
            } catch (error) { console.log(`LATE_REQUEST_REJECTED:${error.code}`); }
            finally { fsPromises.opendir = opendir; }
        }
        console.log('LEGACY_CLEANUP_FINISHED');
        if (mode === 'legacy-reject') throw new Error('legacy fixture rejection');
    }, async () => { console.log('SECOND_CLEANUP_FINISHED'); }],
    requiredBeforeClose: mode === 'legacy-reject' ? [] : [async () => {
        console.log('REQUIRED_CLEANUP_ENTERED');
        if (mode === 'late-first-request') return shutdownMarketplaceRepositoryWorkers();
        if (mode === 'hang') return new Promise(() => {});
        if (mode === 'reject') throw new Error('PRIVATE_REQUIRED_FAILURE_DETAILS');
        if (mode === 'invalid') return undefined;
        return mode === 'success' ? { ok: true }
            : { ok: false, code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' };
    }],
});
lifecycle.gracefulShutdown('fixture', Number(requestedCode));
