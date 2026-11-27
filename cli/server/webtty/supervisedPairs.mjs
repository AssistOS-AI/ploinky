import fs from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { createSupervisionCourier } from '../../utils/supervisionCourier.mjs';
import { createWorkerControlRelay } from '../../utils/workerControlRelay.mjs';
import { findHomeProfileProvider } from './homeProfileProvider.mjs';

const fail = code => Object.assign(new Error(code), { code });
export function workerOutput(session, now = Date.now()) {
    if (!session || session.closed || session.closing) return { running: false, lastOutputAt: null, silentForSeconds: null, recentOutput: '' };
    const text = stripVTControlCharacters(session.recentOutput || '').replace(/[^\S\n\t ]|[\u0000-\u0008\u000b-\u001f\u007f]/gu, '');
    const bytes = Buffer.from(text.split('\n').slice(-100).join('\n'));
    let offset = Math.max(0, bytes.length - 16384);
    while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
    const recentOutput = bytes.subarray(offset).toString('utf8');
    return { running: true, lastOutputAt: session.lastOutputAt ?? null,
        silentForSeconds: session.lastOutputAt == null ? null : Math.max(0, Math.floor((now - session.lastOutputAt) / 1000)),
        recentOutput, truncated: recentOutput !== text };
}

// Never follow a project-controlled results symlink into Router state, or read an unbounded log.
export function readPairResults(folder, identity) {
    let fd;
    let directory;
    try {
        directory = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const pinned = fs.fstatSync(directory, { bigint: true });
        if (!identity || String(pinned.dev) !== String(identity.dev) || String(pinned.ino) !== String(identity.ino)) throw new Error('Supervised directory moved');
        fd = fs.openSync(`/proc/self/fd/${directory}/results.md`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('results.md must be a regular file of at most 1 MiB');
        const bytes = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
        return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8');
    } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); if (directory !== undefined) fs.closeSync(directory); }
}

// In-memory, terminal-lifetime delegation. No browser token, login session or arbitrary HTTP target
// is retained. Router shutdown closes WebTTY processes, so grants must not survive that shutdown.
export class SupervisedPairs {
    constructor(manager, { createRelay = createWorkerControlRelay, createMonitor = createSupervisionCourier } = {}) {
        this.manager = manager;
        this.createRelay = createRelay;
        this.createMonitor = createMonitor;
        this.pairs = new Map();
    }
    live(session) {
        return session && this.manager.sessions.get(session.id) === session && !session.closed && !session.closing
            && session.routerEpoch === this.manager.routerEpoch;
    }
    register(req, routePlan, input) {
        const pending = (this.registration || Promise.resolve()).then(() => this.registerPair(req, routePlan, input));
        this.registration = pending.catch(() => {});
        return pending;
    }
    async registerPair(req, routePlan, input) {
        const { id, supervisor: supervisorId, worker: workerId, controlId, interruptInput } = input;
        if (Object.keys(input).sort().join(',') !== 'controlId,id,interruptInput,supervisor,worker'
            || ![id, supervisorId, workerId, controlId].every(value => typeof value === 'string')
            || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !/^[a-f0-9-]{36}$/.test(controlId)
            || !/^[a-zA-Z0-9_-]{32}$/.test(supervisorId) || !/^[a-zA-Z0-9_-]{32}$/.test(workerId)
            || supervisorId === workerId || ![null, '\u001b'].includes(interruptInput)) throw fail('WEBTTY_PROFILE_UNAVAILABLE');
        const supervisor = await this.manager.authorize(req, routePlan, supervisorId, 'input');
        const worker = await this.manager.authorize(req, routePlan, workerId, 'input');
        const lease = this.manager.auth.createLease(req);
        if (!supervisor || !worker) throw fail('WEBTTY_SESSION_NOT_FOUND');
        // Shared administrator terminals do not grant ownership of their background control.
        if (supervisor.owner.principal !== lease.principal || worker.owner.principal !== lease.principal) throw fail('WEBTTY_OWNER_REQUIRED');
        if (!supervisor.profile?.provider || supervisor.profile.provider !== worker.profile?.provider
            || supervisor.cwdRelative !== worker.cwdRelative) throw fail('WEBTTY_PROFILE_UNAVAILABLE');
        const previous = this.pairs.get(id);
        if (previous && previous.owner !== lease.principal) throw fail('WEBTTY_OWNER_REQUIRED');
        if (previous?.supervisor === supervisor && previous.worker === worker && previous.controlId === controlId
            && previous.routePlan.lease.isCurrent()) return { ok: true, status: previous.status };
        if (!previous && this.pairs.size >= 64) throw fail('WEBTTY_UNAVAILABLE');
        for (const pair of this.pairs.values()) {
            if (pair.id !== id && (pair.supervisor === supervisor || pair.worker === worker
                || (pair.folder === supervisor.target.directory.absolutePath && (this.live(pair.supervisor) || this.live(pair.worker))))) {
                throw fail('WEBTTY_PROFILE_UNAVAILABLE');
            }
        }
        const provider = findHomeProfileProvider(routePlan.snapshot, supervisor.profile.provider);
        if (!provider) throw fail('WEBTTY_PROFILE_UNAVAILABLE');
        const pair = { id, supervisor, worker, controlId, owner: lease.principal, routePlan,
            folder: supervisor.target.directory.absolutePath, status: '', relay: null, active: true };
        // Preserve only the admitted identity, not headers, JWTs, cookies or login-session identifiers.
        const identity = { user: Object.fromEntries(['id', 'username', 'name', 'email', 'roles', 'capabilities']
            .filter(key => Object.hasOwn(req.user, key)).map(key => [key, structuredClone(req.user[key])])),
            authMode: req.authMode, authChannel: req.authChannel };
        const check = () => {
            if (!pair.active || !this.live(supervisor) || this.manager.closed) throw fail('WEBTTY_SESSION_NOT_FOUND');
            if (!routePlan.lease.isCurrent() || routePlan.lease.commit() !== true) throw fail('WEBTTY_GENERATION_CHANGED');
        };
        const api = async (operation, body) => {
            check();
            return this.manager.homeProfiles.callControl({ req: identity, routePlan, providerName: supervisor.profile.provider,
                expectedProvider: provider, operation: operation.replace('control-', ''),
                body: { ...body, ...(operation === 'control-poll' ? { profile: supervisor.profile.id } : {}) } });
        };
        const client = { json: async (method, url, body) => {
            check();
            const target = url === `/webtty/sessions/${worker.id}/output` || url === `/webtty/sessions/${worker.id}/input` ? worker : null;
            if (!target) throw fail('WEBTTY_OWNER_REQUIRED');
            if (method === 'GET' && url.endsWith('/output')) return workerOutput(this.live(worker) ? worker : null, this.manager.now());
            if (method !== 'POST' || !url.endsWith('/input') || !this.live(worker)) throw fail('WEBTTY_SESSION_NOT_FOUND');
            await this.manager.input(worker, body.data);
            return { ok: true };
        } };
        const monitor = this.createMonitor({ folder: pair.folder, pairId: id, workerTerminalId: worker.id,
            readResults: folder => readPairResults(folder, supervisor.target.directory.identity), now: this.manager.now,
            notifySupervisor: async text => { check(); await this.manager.input(supervisor, `\u001b[200~${text}\u001b[201~\r`); },
            activity: () => { check(); return this.live(worker) ? worker : null; },
            onStatus: status => { pair.status = status; } });
        pair.monitor = monitor;
        pair.relay = this.createRelay({ api, client, monitor, now: this.manager.now,
            session: { supervisor: { controlId }, worker: { terminalId: worker.id, interruptInput } },
            onStatus: status => { pair.status = status; if (!this.live(supervisor)) this.stop(id); } });
        // Confirm profile ownership before replacing the existing delegation or starting the loop.
        // A validation-only poll cannot consume a queued operation.
        await this.manager.homeProfiles.callControl({ req: identity, routePlan, providerName: supervisor.profile.provider,
            expectedProvider: provider, operation: 'poll', body: { id: controlId, results: [], profile: supervisor.profile.id, validateOnly: true } });
        check();
        if (!this.live(worker)) throw fail('WEBTTY_SESSION_NOT_FOUND');
        // Both PTYs already started during creation. Registration explicitly admits background
        // execution, so a worker that has never had a viewer is not an abandoned launch.
        this.manager.retainDetachedForSupervision(supervisor);
        this.manager.retainDetachedForSupervision(worker);
        this.stop(id);
        this.pairs.set(id, pair);
        pair.relay.start();
        return { ok: true, status: 'Server supervision active' };
    }
    stop(id) { const pair = this.pairs.get(id); if (pair) { pair.active = false; pair.relay.stop(); } this.pairs.delete(id); }
    async remove(req, routePlan, id) {
        await this.registration;
        const pair = this.pairs.get(id);
        if (!pair) return { ok: true };
        const lease = this.manager.auth.createLease(req);
        const valid = await this.manager.auth.validateLease(lease, { req });
        if (!valid.ok || pair.owner !== lease.principal) throw fail('WEBTTY_OWNER_REQUIRED');
        if (routePlan.lease.commit() !== true) throw fail('WEBTTY_GENERATION_CHANGED');
        this.stop(id);
        return { ok: true };
    }
    close() { for (const id of this.pairs.keys()) this.stop(id); }
}
