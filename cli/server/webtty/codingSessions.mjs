import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceDirectory } from '../../../core-services/webtty/cwd.mjs';
import { codingSessionDeclaration } from '../../utils/codingSessionProviders.mjs';
import { readStore, writeStore, storePath, upsertSession } from '../../utils/supervisedSessions.mjs';
import { createSupervisedPair, attachRole, rememberRoleConversations } from '../../utils/supervisionFlow.mjs';
import { findHomeProfileProvider } from './homeProfileProvider.mjs';

const fail = (message, code = 'CODING_SESSIONS_INVALID') => Object.assign(new Error(message), { code });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
const plan = value => value && Object.keys(value).sort().join(',') === 'codingAgent,robotId'
    && identifier(value.robotId) && identifier(value.codingAgent);
const shapes = {
    kill: ['id'], overview: [], robots: [], agents: ['robot'], sessions: ['robot', 'codingAgent'],
    launch: ['robot', 'codingAgent', 'resume'], pairs: [],
    'create-pair': ['supervisor', 'worker'], 'open-role': ['id', 'role'],
};
export function validateCodingSessionRequest(body) {
    if (!body || !Object.hasOwn(shapes, body.action) || typeof body.dir !== 'string'
        || body.dir.length > 4096 || /[\u0000-\u001f\u007f\\]/u.test(body.dir)
        || body.dir.startsWith('/') || body.dir.split('/').some(part => part === '.' || part === '..')) return false;
    if (Object.keys(body).sort().join(',') !== ['action', 'dir', ...shapes[body.action]].sort().join(',')) return false;
    if ('robot' in body && !identifier(body.robot)) return false;
    if ('codingAgent' in body && !identifier(body.codingAgent)) return false;
    if ('resume' in body && body.resume !== null && !identifier(body.resume)) return false;
    if (body.action === 'create-pair' && (!plan(body.supervisor) || !plan(body.worker))) return false;
    if (body.action === 'kill' && (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(body.id))) return false;
    if (body.action === 'open-role' && (!identifier(body.id) || !['supervisor', 'worker'].includes(body.role))) return false;
    return true;
}

// A read-only readiness probe. It does not list histories, create terminals or
// start providers; normal signed provider admission verifies the actual service.
export async function codingSessionReadiness(manager, req, routePlan) {
    await manager.validatedLease(req);
    if (!routePlan.lease.isCurrent() || routePlan.lease.commit() !== true) throw fail('Routing changed.', 'WEBTTY_GENERATION_CHANGED');
    if (!manager.availability().ok) return { ok: true, ready: false, message: 'Waiting for terminal services…' };
    const candidates = Object.entries(routePlan.snapshot.manifests || {}).filter(([key, manifest]) =>
        codingSessionDeclaration(manifest, key) && findHomeProfileProvider(routePlan.snapshot, key));
    if (candidates.length !== 1) return { ok: true, ready: false, message: 'Waiting for the coding-session provider…' };
    try {
        await manager.homeProfiles.callCodingSession({ req, routePlan, providerName: candidates[0][0], operation: 'robots', body: {} });
        return { ok: true, ready: true };
    } catch (error) {
        if (['WEBTTY_AUTH_INVALID', 'WEBTTY_ADMIN_REQUIRED', 'WEBTTY_AUTH_SESSION_REQUIRED'].includes(error.code)) throw error;
        return { ok: true, ready: false, message: 'Waiting for coding-session services…' };
    }
}

// Both browser and CLI use the same pair store and launch/resume implementation. This endpoint
// is admitted by the administrator-only WebTTY handler, including browser mutation proof.
export function browserCodingSessions(manager, req, routePlan, body) {
    if (['overview', 'robots', 'agents', 'sessions'].includes(body?.action)) return execute(manager, req, routePlan, body);
    const pending = (manager.codingSessionQueue || Promise.resolve()).then(() => execute(manager, req, routePlan, body));
    manager.codingSessionQueue = pending.catch(() => {});
    return pending;
}

async function execute(manager, req, routePlan, body) {
    if (!validateCodingSessionRequest(body)) throw fail('Invalid coding session request.');
    await manager.validatedLease(req);
    if (!routePlan.lease.isCurrent() || routePlan.lease.commit() !== true) throw fail('Routing changed. Refresh and retry.', 'WEBTTY_GENERATION_CHANGED');
    const directory = resolveWorkspaceDirectory(body.dir, { workspaceRoot: manager.workspaceRoot });
    // Preserve the canonical cwd used by native catalogs, including when the browser selected a symlink.
    const dir = path.relative(directory.workspaceRealPath, directory.absolutePath).split(path.sep).join('/');
    const candidates = Object.entries(routePlan.snapshot.manifests || {})
        .filter(([key, manifest]) => codingSessionDeclaration(manifest, key) && findHomeProfileProvider(routePlan.snapshot, key));
    if (candidates.length !== 1) throw fail('Exactly one enabled coding session provider is required.', 'CODING_SESSIONS_UNAVAILABLE');
    const provider = findHomeProfileProvider(routePlan.snapshot, candidates[0][0]);
    const api = (operation, input) => manager.homeProfiles.callCodingSession({ req, routePlan,
        providerName: candidates[0][0], operation, body: input });
    const live = async () => (await manager.listLiveSessions({ req, routePlan })).sessions.filter(row => row.status !== 'exited');
    const openTerminal = async launched => {
        const discovery = await manager.discoverTargets({ req, routePlan, directory: dir,
            profile: { provider: candidates[0][0], id: launched.profile } });
        const targets = discovery.targets.filter(row => row.kind === 'agent' && row.access === 'rw'
            && row.detail === `${provider.repoName}/${candidates[0][0]}` && row.launch);
        if (targets.length !== 1) {
            await manager.cancelTargetDiscovery({ req, routePlan, id: discovery.id });
            throw fail('No unambiguous writable terminal is available for this folder.', 'CODING_SESSIONS_UNAVAILABLE');
        }
        const created = await manager.create({ req, routePlan, launch: targets[0].launch, cols: 120, rows: 36, closePolicy: 'keep' });
        // An explicit browser launch should survive while the new tab completes its handoff.
        manager.retainDetachedForSupervision(manager.sessions.get(created.id));
        return { sessionId: created.id, viewId: created.view.id };
    };
    const handoff = async id => ({ ok: true, terminalId: id, ...(await manager.createAttachToken({ req, routePlan, id })) });
    if (body.action === 'robots') return api('robots', {});
    if (body.action === 'agents') return api('agents', { robot: body.robot });
    if (body.action === 'overview') {
        const [index, { robots = [] }] = await Promise.all([api('index', { directory: dir }), api('robots', {})]);
        const robotNames = new Map(robots.map(robot => [robot.id, robot.name]));
        const running = (await live()).filter(row => row.cwd === dir && row.profileProvider === candidates[0][0]);
        const sessions = (index.sessions || []).filter(entry => !running.some(row =>
            row.profileId?.startsWith(`${entry.robotId}.default.${entry.codingAgent}.`)
            && ['r', 'n'].some(prefix => row.profileId.endsWith(`.${prefix}-${entry.id}`))));
        return { ok: true, sessions: sessions.map(entry => ({ ...entry, robotName: robotNames.get(entry.robotId) || entry.robotName || entry.robotId })), refreshing: index.refreshing === true, errors: index.errors || [],
            running: running.filter(row => row.profileId?.split('.').length >= 3).map(row => {
                const [robotId, , codingAgent] = row.profileId.split('.');
                const conversation = index.sessions?.find(entry => entry.robotId === robotId && entry.codingAgent === codingAgent
                    && ['r', 'n'].some(prefix => row.profileId.endsWith(`.${prefix}-${entry.id}`)));
                const title = conversation?.title || (row.title !== candidates[0][0] ? row.title : '') || '';
                return { ...row, title, robotId, robotName: robotNames.get(robotId) || index.sessions?.find(entry => entry.robotId === robotId)?.robotName || robotId, codingAgent };
            }) };
    }
    if (body.action === 'sessions') {
        const history = await api('history', { robot: body.robot, codingAgent: body.codingAgent, directory: dir });
        const running = (await live()).filter(row => row.cwd === dir && row.profileProvider === candidates[0][0]
            && row.profileId?.split('.')[0] === body.robot && row.profileId?.split('.')[2] === body.codingAgent);
        return { ok: true, running, sessions: (history.sessions || []).filter(entry => !running.some(row =>
            ['r', 'n'].some(prefix => row.profileId.endsWith(`.${prefix}-${entry.id}`)))) };
    }
    if (body.action === 'kill') {
        const row = (await live()).find(entry => entry.id === body.id && entry.cwd === dir
            && entry.profileProvider === candidates[0][0]);
        if (!row) throw fail('This coding session is no longer running. Refresh the list.');
        const [robot, , codingAgent] = (row.profileId || '').split('.');
        if (!identifier(robot) || !identifier(codingAgent)) throw fail('Invalid coding session profile.');
        // Capture the native catalog before stopping the process, then reconcile any
        // final files written on exit. Failure to read history must not prevent Kill.
        let historySaved = false;
        const capture = async () => {
            try { await api('sync-history', { robot, codingAgent, directory: dir }); historySaved = true; }
            catch { /* Previously indexed conversations remain available. */ }
        };
        await capture();
        await manager.closeAuthorized(req, routePlan, body.id);
        await capture();
        return { ok: true, historySaved };
    }
    if (body.action === 'launch') {
        if (body.resume) {
            const existing = (await live()).filter(row => row.cwd === dir && row.profileProvider === candidates[0][0]
                && row.profileId?.startsWith(`${body.robot}.default.${body.codingAgent}.`)
                && ['r', 'n'].some(prefix => row.profileId.endsWith(`.${prefix}-${body.resume}`)));
            if (existing.length === 1) return handoff(existing[0].id);
            if (existing.length > 1) throw fail('Several terminals use this conversation. Choose a running terminal.');
        }
        const launched = await api('launch', { robot: body.robot, codingAgent: body.codingAgent, directory: dir, resume: body.resume });
        const terminal = await openTerminal(launched);
        return handoff(terminal.sessionId);
    }
    // Fail closed for workspace-controlled state indirection before reading or replacing the shared store.
    const stateRoot = path.join(directory.workspaceRealPath, '.ploinky');
    if (!fs.lstatSync(stateRoot).isDirectory() || fs.realpathSync(stateRoot) !== stateRoot) throw fail('Invalid workspace state directory.');
    const file = storePath(directory.workspaceRealPath);
    try { if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw fail('Invalid coding session store.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const save = record => writeStore(file, upsertSession(readStore(file), record));
    let pairs = readStore(file).sessions.filter(pair => pair.folder === directory.absolutePath);
    const running = await live();
    if (body.action === 'pairs') {
        const { robots = [] } = await api('robots', {});
        const robotNames = new Map(robots.map(robot => [robot.id, robot.name]));
        return { ok: true, pairs: pairs.map(pair => ({ id: pair.id, createdAt: pair.createdAt, updatedAt: pair.updatedAt,
            roles: ['supervisor', 'worker'].map(role => ({ role, robotId: pair[role].robotId, robotName: robotNames.get(pair[role].robotId) || pair[role].robotName || pair[role].robotId,
                codingAgent: pair[role].codingAgent, terminalId: pair[role].terminalId,
                lastActivityAt: running.find(row => row.id === pair[role].terminalId)?.lastActivityAt,
                running: running.some(row => row.id === pair[role].terminalId),
            })),
        })) };
    }
    const client = { json: async (method, url, input) => {
        if (method === 'POST' && url === '/webtty/supervised-pairs') return manager.supervisedPairs.register(req, routePlan, input);
        if (method === 'DELETE' && /^\/webtty\/sessions\/[A-Za-z0-9_-]{32}$/u.test(url)) {
            return manager.closeAuthorized(req, routePlan, url.split('/').at(-1));
        }
        throw fail('Invalid internal terminal operation.');
    } };
    if (body.action === 'create-pair') {
        if (pairs.some(pair => running.some(row => [pair.supervisor.terminalId, pair.worker.terminalId].includes(row.id)))) {
            throw fail('A supervised pair is already running in this folder.', 'CODING_SESSIONS_CONFLICT');
        }
        const record = await createSupervisedPair({ api, client, openTerminal, directory: dir, folder: directory.absolutePath,
            supervisor: body.supervisor, worker: body.worker });
        try { save(record); }
        catch (error) {
            await manager.supervisedPairs.remove(req, routePlan, record.id).catch(() => {});
            for (const role of ['supervisor', 'worker']) await manager.closeAuthorized(req, routePlan, record[role].terminalId).catch(() => {});
            await api('control-close', { id: record.supervisor.controlId }).catch(() => {});
            throw error;
        }
        const supervisor = await handoff(record.supervisor.terminalId);
        const worker = await handoff(record.worker.terminalId);
        return { ...supervisor, worker };
    }
    const pair = pairs.find(value => value.id === body.id);
    if (!pair) throw fail('The supervised session no longer exists.');
    const patch = await rememberRoleConversations({ api, session: pair, directory: dir });
    if (Object.keys(patch).length) { Object.assign(pair, patch); save(pair); }
    const result = await attachRole({ client, api, session: pair, role: body.role, directory: dir, live: running,
        openTerminal, attachTerminal: async (_client, row) => ({ sessionId: row.id }) });
    pair[body.role] = result.record;
    save(pair);
    const current = await live();
    if (['supervisor', 'worker'].every(role => current.some(row => row.id === pair[role].terminalId))) {
        await manager.supervisedPairs.register(req, routePlan, { id: pair.id, supervisor: pair.supervisor.terminalId,
            worker: pair.worker.terminalId, controlId: pair.supervisor.controlId, interruptInput: pair.worker.interruptInput });
    }
    return handoff(result.terminal.sessionId);
}
