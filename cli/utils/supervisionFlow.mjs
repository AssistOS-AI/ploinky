import { randomUUID } from 'node:crypto';
import { newSessionId } from './supervisedSessions.mjs';
import {
    SUPERVISION_ROLE_LABELS, SUPERVISION_ROLES, supervisionSystemPrompt,
} from './supervisionRoles.mjs';
import { prepareSupervisedFolder } from './supervisionWorkspace.mjs';

// Helpers for the supervised half of `ploinky cs`. The command owns the screens
// and terminal attachment; this module owns what a pair is, what a pair looks like in a
// list, and how its two terminals are opened, attached and closed.
export const SUPERVISION_TABS = Object.freeze(['Coding sessions', 'Supervised sessions']);

// A relay that ends this way ends the command; anything else returns to the menu
// because the terminal keeps running.
export const RELAY_EXIT_REASONS = Object.freeze(['signal', 'input_closed']);

export function relayStatus(reason) {
    return {
        detached: 'Detached: the session keeps running.',
        exited: 'The session ended.',
        ended: 'The session ended.',
        view_ended: 'This view was closed from another window; the session keeps running.',
        switch: 'Switched role: the other session is still running.',
    }[reason] || '';
}

export function relativeAge(timestamp, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
}

// The two tabs of the menu, drawn above every screen.
export function supervisionTabs(mode) {
    return { tabs: [...SUPERVISION_TABS], activeTab: mode === 'supervised' ? 1 : 0 };
}

// Running WebTTY terminals of the whole workspace; a terminal that exited or was
// killed is gone.
export async function runningTerminals(client) {
    const listed = await client.json('GET', '/webtty/live-sessions');
    const sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
    return sessions.filter(row => row?.source === 'webtty' && row.status !== 'exited');
}

export function findLiveRow(rows, id) {
    return (Array.isArray(rows) ? rows : []).find(row => row?.id === id) || null;
}

// A pair is running while either of its terminals still exists.
export function pairState(session, live = []) {
    const supervisor = findLiveRow(live, session.supervisor.terminalId);
    const worker = findLiveRow(live, session.worker.terminalId);
    return { supervisor, worker, running: Boolean(supervisor || worker) };
}

export function pairItems({ sessions = [], live = [], now = Date.now() } = {}) {
    return [
        { kind: 'new', label: '+ New supervised session' },
        ...sessions.map((session) => {
            const state = pairState(session, live);
            return {
                kind: 'pair',
                session,
                ...state,
                label: `${state.running ? '● ' : '  '}${session.label || session.folder}`,
                detail: `${state.running ? 'running' : 'ended'} · ${session.supervisor.codingAgent} → ${session.worker.codingAgent} · `
                    + relativeAge(session.updatedAt || session.createdAt, now),
            };
        }),
    ];
}

function roleDetail(row, now) {
    if (!row) return 'ended';
    const viewers = row.viewerCount ? ` · ${row.viewerCount} view${row.viewerCount === 1 ? '' : 's'}` : '';
    return `${row.status}${viewers} · ${relativeAge(row.lastActivityAt, now)}`;
}

function roleItem(role, record, row, now) {
    return {
        kind: 'role',
        role,
        record,
        row,
        label: `${row ? '● ' : '  '}${SUPERVISION_ROLE_LABELS[role]} · ${record.codingAgent}`,
        detail: roleDetail(row, now),
    };
}

// The screen a pair opens: its two sessions, in role order.
export function pairRoleItems(session, live = [], now = Date.now()) {
    const state = pairState(session, live);
    return [
        roleItem('supervisor', session.supervisor, state.supervisor, now),
        roleItem('worker', session.worker, state.worker, now),
    ];
}

export function registerSupervisedPair(client, session) {
    return client.json('POST', '/webtty/supervised-pairs', {
        id: session.id, supervisor: session.supervisor.terminalId, worker: session.worker.terminalId,
        controlId: session.supervisor.controlId, interruptInput: session.worker.interruptInput || null,
    });
}

// Installs the role skills and opens both terminals without submitting input. A half-opened pair is closed again, so a failure never leaves a
// stray terminal behind.
export async function createSupervisedPair({
    api,
    client,
    openTerminal,
    directory,
    folder,
    supervisor,
    worker,
    prepareFolder = prepareSupervisedFolder,
    now = () => Date.now(),
} = {}) {
    const plans = { supervisor, worker };
    prepareFolder(folder);
    const createdAt = now();
    const record = {
        id: newSessionId(),
        folder,
        label: '',
        createdAt,
        updatedAt: createdAt,
        phase: 'running',
        supervisor: {},
        worker: {},
    };
    // Snapshot before either role can create a conversation. Absence of this evidence in old
    // records requires explicit history selection, never an implicit fresh conversation.
    const baselines = {};
    const bindings = {};
    for (const role of SUPERVISION_ROLES) {
        const plan = plans[role];
        const history = await api('history', { robot: plan.robotId, codingAgent: plan.codingAgent, directory });
        baselines[role] = (history.sessions || []).map(entry => entry.id);
        bindings[role] = history.sessionBindingSupported ? randomUUID() : null;
    }
    const opened = [];
    const control = await api('control-create', {});
    try {
        for (const role of SUPERVISION_ROLES) {
            const plan = plans[role];
            const launched = await api('launch', {
                robot: plan.robotId,
                codingAgent: plan.codingAgent,
                directory,
                resume: null,
                systemPrompt: supervisionSystemPrompt(role, bindings[role]),
                ...(role === 'supervisor' ? { controlId: control.id } : {}),
            });
            const terminal = await openTerminal(launched);
            opened.push(terminal);
            record[role] = {
                robotId: plan.robotId,
                robotName: plan.robotName || plan.robotId,
                codingAgent: plan.codingAgent,
                nativeSessionId: launched.nativeSessionId || null,
                historyBefore: baselines[role],
                sessionBinding: bindings[role],
                terminalId: terminal.sessionId,
                interruptInput: launched.interruptInput || null,
                ...(role === 'supervisor' ? { controlId: control.id } : {}),
            };
        }
        await registerSupervisedPair(client, record);
        return record;
    } catch (error) {
        for (const terminal of opened) {
            await client.json('DELETE', `/webtty/sessions/${encodeURIComponent(terminal.sessionId)}`).catch(() => {});
        }
        await api('control-close', { id: control.id }).catch(() => {});
        throw error;
    }
}

// Resolve each role from its own persisted launch binding, including while its terminal is alive.
export async function rememberRoleConversations({ api, session, directory }) {
    const patch = {};
    for (const role of SUPERVISION_ROLES) {
        const record = session[role];
        if (!record.sessionBinding || record.nativeSessionId) continue;
        const history = await api('history', { robot: record.robotId, codingAgent: record.codingAgent, directory });
        const matches = (history.sessions || []).filter(entry => entry.sessionBinding === record.sessionBinding);
        const other = session[role === 'supervisor' ? 'worker' : 'supervisor'];
        if (matches.length !== 1 || matches[0].id === other.nativeSessionId) continue;
        patch[role] = { ...record, nativeSessionId: matches[0].id };
    }
    if (patch.supervisor && patch.worker && patch.supervisor.nativeSessionId === patch.worker.nativeSessionId
        && patch.supervisor.robotId === patch.worker.robotId && patch.supervisor.codingAgent === patch.worker.codingAgent) return {};
    return patch;
}

function resumeError(message) {
    return Object.assign(new Error(message), { code: 'CODING_SESSIONS_RESUME_UNAVAILABLE' });
}

export async function resolveSupervisedResume({ api, session, role, directory, chooseResume }) {
    const record = session[role];
    const counterpart = session[role === 'supervisor' ? 'worker' : 'supervisor'];
    if (!record.sessionBinding && record.robotId === counterpart.robotId
        && record.codingAgent === counterpart.codingAgent && !counterpart.nativeSessionId) {
        throw resumeError('This older pair has no verified conversation ownership. Refusing to select from the shared history.');
    }
    if (record.nativeSessionId && !record.sessionBinding) {
        const other = session[role === 'supervisor' ? 'worker' : 'supervisor'];
        if (record.robotId === other.robotId && record.codingAgent === other.codingAgent
            && record.nativeSessionId === other.nativeSessionId) throw resumeError('Both roles reference the same native conversation. Refusing to resume.');
        return record.nativeSessionId;
    }
    const other = session[role === 'supervisor' ? 'worker' : 'supervisor'];
    const shared = other.robotId === record.robotId && other.codingAgent === record.codingAgent;
    const history = await api('history', { robot: record.robotId, codingAgent: record.codingAgent, directory });
    if (record.sessionBinding) {
        const matches = (history.sessions || []).filter(entry => entry.sessionBinding === record.sessionBinding);
        if (matches.length === 0) {
            if (record.nativeSessionId && shared && record.nativeSessionId === other.nativeSessionId) {
                throw resumeError('Both roles reference the same native conversation. Refusing to resume.');
            }
            // Vibe can exit before its first message without saving a conversation.
            // Keep an already associated native ID; otherwise start this role afresh.
            return record.nativeSessionId || null;
        }
        if (matches.length !== 1 || (shared && matches[0].id === other.nativeSessionId)) {
            throw resumeError('The original conversation for this role cannot be identified uniquely yet. No replacement session was created.');
        }
        if (record.nativeSessionId && record.nativeSessionId !== matches[0].id) {
            throw resumeError('The saved conversation does not match this role. Refusing to resume.');
        }
        return matches[0].id;
    }
    const baseline = Array.isArray(record.historyBefore) ? new Set(record.historyBefore) : null;
    const available = (history.sessions || []).filter(entry => typeof entry.id === 'string'
        && /^[A-Za-z0-9_-]{1,96}$/u.test(entry.id) && !(shared && entry.id === other.nativeSessionId));
    const fresh = available.filter(entry => !baseline || !baseline.has(entry.id));
    // The person may have used the native agent's own resume menu during the original launch.
    // Keep old conversations selectable in that case, but never infer ownership from them.
    const candidates = fresh.length ? fresh : available;
    if (!candidates.length) return null;
    // Another unmapped role can create a conversation in the same catalog at any time.
    // A single row is not ownership evidence in that case, nor for legacy records.
    if (baseline && fresh.length === 1 && (!shared || other.nativeSessionId)) return candidates[0].id;
    const selected = await chooseResume?.(candidates, role);
    if (!selected || !candidates.some(entry => entry.id === selected)) throw resumeError('Choose the original conversation to resume; no replacement session was created.');
    return selected;
}

// Attaches to a running role, or resumes its native conversation in a new
// terminal when that terminal is gone.
export async function attachRole({
    client,
    api,
    attachTerminal,
    openTerminal,
    session,
    role,
    directory,
    output,
    live = [],
    chooseResume,
} = {}) {
    prepareSupervisedFolder(session.folder);
    const record = session[role];
    const row = findLiveRow(live, record.terminalId);
    if (row) return { terminal: await attachTerminal(client, row, { output }), record };
    const resume = await resolveSupervisedResume({ api, session, role, directory, chooseResume });
    const control = role === 'supervisor' ? await api('control-create', {}) : null;
    if (control && record.controlId) await api('control-close', { id: record.controlId }).catch(() => {});
    try {
        const launched = await api('launch', {
            robot: record.robotId,
            codingAgent: record.codingAgent,
            directory,
            resume,
            systemPrompt: supervisionSystemPrompt(role, record.sessionBinding),
            ...(control ? { controlId: control.id } : {}),
        });
        const terminal = await openTerminal(launched);
        return {
            terminal,
            record: {
                ...record,
                terminalId: terminal.sessionId,
                interruptInput: launched.interruptInput || null,
                ...(control ? { controlId: control.id } : {}),
                nativeSessionId: resume || launched.nativeSessionId || null,
            },
        };
    } catch (error) {
        if (control) await api('control-close', { id: control.id }).catch(() => {});
        throw error;
    }
}

export function rolesToKill(role) {
    return role === 'both' ? [...SUPERVISION_ROLES] : [role];
}

export async function killRoles(client, session, role) {
    const killed = [];
    for (const name of rolesToKill(role)) {
        const id = session[name]?.terminalId;
        if (!id) continue;
        await client.json('DELETE', `/webtty/sessions/${encodeURIComponent(id)}`).catch(error => {
            if (error?.status !== 404) throw error;
        });
        killed.push(name);
    }
    return killed;
}
