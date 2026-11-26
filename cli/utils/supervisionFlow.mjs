import { newSessionId } from './supervisedSessions.mjs';
import {
    SUPERVISION_ROLE_LABELS, SUPERVISION_ROLES, SUPERVISION_SKILL_NAME, supervisionIntro, supervisionRoleText,
    supervisionSkillIntro,
} from './supervisionRoles.mjs';
import { readTaskRevision, prepareSupervisedFolder } from './supervisionWorkspace.mjs';

// Helpers for the supervised half of `ploinky cs`. The command owns the screens
// and the relay; this module owns what a pair is, what a pair looks like in a
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
                label: `${state.running ? '●' : '○'} ${session.label || session.folder}`,
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
        label: `${SUPERVISION_ROLE_LABELS[role]} · ${record.codingAgent}`,
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

export const KILL_ITEMS = Object.freeze([
    { kind: 'kill', role: 'supervisor', label: `Kill ${SUPERVISION_ROLE_LABELS.supervisor}` },
    { kind: 'kill', role: 'worker', label: `Kill ${SUPERVISION_ROLE_LABELS.worker}` },
    { kind: 'kill', role: 'both', label: 'Kill both' },
]);

// Opens both terminals in the chosen folder and starts each role with its own
// instructions. A half-opened pair is closed again, so a failure never leaves a
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
    roleText = supervisionRoleText,
    intro = supervisionIntro,
    skillIntro = supervisionSkillIntro,
    settle = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    settleMs = 1_500,
    now = () => Date.now(),
} = {}) {
    const plans = { supervisor, worker };
    prepareFolder(folder, { roles: [] });
    const createdAt = now();
    const record = {
        id: newSessionId(),
        folder,
        label: '',
        createdAt,
        updatedAt: createdAt,
        deliveredRev: readTaskRevision(folder).rev,
        phase: 'running',
        supervisor: {},
        worker: {},
    };
    const opened = [];
    const skilled = {};
    try {
        for (const role of SUPERVISION_ROLES) {
            const plan = plans[role];
            // The role skill lets an agent whose CLI reads skills start already
            // knowing its job; a provider that cannot install it says so, and the
            // briefing below then carries the protocol instead.
            const launched = await api('launch', {
                robot: plan.robotId,
                codingAgent: plan.codingAgent,
                directory,
                resume: null,
                role,
                skill: { name: `${SUPERVISION_SKILL_NAME}-${role}`, text: `---\nname: ${SUPERVISION_SKILL_NAME}-${role}\ndescription: Instructions for the ${role} in an explicitly requested supervised coding session.\n---\n\n${roleText(role)}` },
            });
            const terminal = await openTerminal(launched);
            opened.push(terminal);
            skilled[role] = launched.skill === true;
            record[role] = {
                robotId: plan.robotId,
                robotName: plan.robotName || plan.robotId,
                codingAgent: plan.codingAgent,
                nativeSessionId: launched.nativeSessionId || null,
                terminalId: terminal.sessionId,
            };
        }
        // The role file is only written for a role whose agent did not take the skill.
        const fallback = SUPERVISION_ROLES.filter(role => !skilled[role]);
        if (fallback.length) prepareFolder(folder, { roles: fallback });
        // A terminal needs a moment before its agent reads typed input.
        await settle(settleMs);
        for (const role of SUPERVISION_ROLES) {
            const peer = role === 'supervisor' ? 'worker' : 'supervisor';
            const compose = skilled[role] ? skillIntro : intro;
            const text = compose(role, { folder, peerAgent: plans[peer].codingAgent });
            await client.json('POST', `/webtty/sessions/${record[role].terminalId}/input`, { data: `${text}\r` });
        }
        return record;
    } catch (error) {
        for (const terminal of opened) {
            await client.json('DELETE', `/webtty/sessions/${encodeURIComponent(terminal.sessionId)}`).catch(() => {});
        }
        throw error;
    }
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
} = {}) {
    const record = session[role];
    const row = findLiveRow(live, record.terminalId);
    if (row) return { terminal: await attachTerminal(client, row, { output }), record };
    const launched = await api('launch', {
        robot: record.robotId,
        codingAgent: record.codingAgent,
        directory,
        resume: record.nativeSessionId || null,
    });
    const terminal = await openTerminal(launched);
    if (!record.nativeSessionId) {
        prepareSupervisedFolder(session.folder, { roles: [role] });
        await new Promise(resolve => setTimeout(resolve, 1500));
        await client.json('POST', `/webtty/sessions/${terminal.sessionId}/input`, {
            data: `${supervisionIntro(role, { folder: session.folder })}\r`,
        });
    }
    return {
        terminal,
        record: {
            ...record,
            terminalId: terminal.sessionId,
            nativeSessionId: launched.nativeSessionId || record.nativeSessionId || null,
        },
    };
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
