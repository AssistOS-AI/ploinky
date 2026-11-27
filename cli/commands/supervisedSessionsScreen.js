import {
    rememberRoleConversations, attachRole, createSupervisedPair, registerSupervisedPair, findLiveRow, killRoles, pairItems, pairRoleItems, runningTerminals,
    RELAY_EXIT_REASONS, relayStatus, supervisionTabs,
} from '../utils/supervisionFlow.mjs';
import { SUPERVISION_ROLE_LABELS } from '../utils/supervisionRoles.mjs';
import {
    findSession, readStore, removeSession, updateSession, upsertSession, writeStore,
} from '../utils/supervisedSessions.mjs';
import { DETACH_KEY, RELAY_KEY_LABELS, SWITCH_KEY } from '../utils/webttyCliClient.mjs';

// The supervised tab of `ploinky cs`: a list of pairs, one pair's two sessions,
// and registration of each pair with server-owned control and monitoring.
// The command owns the event loop; this module owns one screen at a time.
const MAX_PAIRS = 8;
const ENTRY_LEVEL = 'pairs';
const SESSION_KEYS = `${RELAY_KEY_LABELS.switch} switch · ${RELAY_KEY_LABELS.detach} detach`;

const nextLevel = (role, kind) => `${role}-${kind}`;

export function createSupervisedScreen({
    menu, client, api, directory, folder, folderPath,
    openTerminal, attachTerminal, createRelay,
    input, output, errorOutput, storeFile, now,
    refreshMs,
    labels = SUPERVISION_ROLE_LABELS,
}) {
    const courierStatus = new Map();
    const read = () => readStore(storeFile());
    const mutate = (change) => {
        const next = change(read());
        writeStore(storeFile(), next);
        return next;
    };
    const failure = error => error?.message || String(error);

    // Reconcile UI records with server-owned supervision. Leaving the CLI never revokes it.
    async function sync() {
        const live = await runningTerminals(client);
        for (let session of read().sessions.filter(value => value.folder === folderPath && value.phase === 'running').slice(0, MAX_PAIRS)) {
            try {
                const patch = await rememberRoleConversations({ api, session, directory });
                if (Object.keys(patch).length) {
                    mutate(store => updateSession(store, session.id, () => patch, now));
                    session = { ...session, ...patch };
                }
            } catch (error) { courierStatus.set(session.id, `Conversation identification unavailable: ${failure(error)}`); }
            if (!session.supervisor.controlId || !findLiveRow(live, session.supervisor.terminalId)
                || !findLiveRow(live, session.worker.terminalId)) continue;
            try {
                const result = await registerSupervisedPair(client, session);
                courierStatus.set(session.id, result.status || 'Server supervision active');
            } catch (error) { courierStatus.set(session.id, `Server supervision unavailable: ${failure(error)}`); }
        }
    }

    async function chooseResume(candidates, role) {
        const choice = await menu.select({ title: [`Resume ${labels[role]}`, 'Select its original conversation'],
            items: candidates.map(entry => ({ label: entry.title || entry.id, detail: entry.id })),
            help: '↑/↓ select · Enter resume · Backspace cancel' });
        menu.close();
        return choice.action === 'enter' ? candidates[choice.index]?.id : null;
    }

    // Ctrl+\ attaches the other role of the same pair; every other way out
    // returns to the pair menu and leaves both terminals running.
    async function attach(pairId, initialRole) {
        let role = initialRole;
        let session = findSession(read(), pairId);
        if (!session) throw new Error('That supervised session is no longer saved.');
        const remember = async (name, record) => {
            if (record.terminalId === session[name].terminalId) return;
            mutate(store => updateSession(store, pairId, () => ({ [name]: record, phase: 'running' }), now));
            await sync();
        };
        const first = await attachRole({
            client, api, attachTerminal, openTerminal,
            session, role, directory, output, chooseResume, live: await runningTerminals(client),
        });
        await remember(role, first.record);
        let terminal = first.terminal;
        while (true) {
            const result = await createRelay({ client, ...terminal, input, output,
                keys: { detach: DETACH_KEY, switch: SWITCH_KEY }, stripReports: true }).run();
            await sync();
            if (result.reason !== 'switch') return result;
            const other = role === 'supervisor' ? 'worker' : 'supervisor';
            session = findSession(read(), pairId);
            if (!session) return { reason: 'ended' };
            const switched = await attachRole({
                client, api, attachTerminal, openTerminal,
                session, role: other, directory, output, chooseResume, live: await runningTerminals(client),
            });
            await remember(other, switched.record);
            role = other;
            terminal = switched.terminal;
        }
    }

    function showExistingPair(state, sessions, live) {
        const existing = sessions.find(session => session.folder === folderPath
            && (findLiveRow(live, session.worker.terminalId) || findLiveRow(live, session.supervisor.terminalId)));
        if (!existing) return false;
        state.supervised = existing.id;
        state.remembered.roles = 0;
        state.level = 'pair';
        state.status = 'A pair is still running here. Stop its running roles with k before creating another.';
        return true;
    }

    async function pairsScreen(state, { tabs, status }) {
        const header = { title: [`Supervised sessions — ${folder}`, 'Choose a session'], ...tabs };
        let items;
        let live;
        try {
            items = await menu.busy(header, async () => {
                await sync();
                live = await runningTerminals(client);
                return pairItems({ sessions: read().sessions.filter(session => session.folder === folderPath), live, now: now() });
            });
        } catch (error) {
            throw new Error(failure(error));
        }
        const choice = await menu.select({ ...header, items, status,
            help: '↑/↓ select · Enter open · n new · d forget · r refresh · Shift+Tab coding · q quit' },
        { selected: state.remembered.pairs, actions: { n: 'new', d: 'delete', delete: 'delete', r: 'refresh' } });
        state.remembered.pairs = choice.index;
        state.status = '';
        if (choice.action === 'tab') return { mode: 'coding' };
        if (choice.action === 'quit') return { quit: true };
        if (choice.action === 'refresh') return {};
        const item = items[choice.index];
        if (choice.action === 'delete') {
            if (item?.kind !== 'pair') { state.status = 'Only a saved session can be forgotten.'; return {}; }
            if (!await menu.confirm({ ...header, items, selected: choice.index },
                `Forget ${item.session.label || item.session.folder}? Its terminals stay open.`)) return {};
            await client.json('POST', '/webtty/supervised-pairs', { remove: item.session.id });
            if (item.session.supervisor.controlId) await api('control-close', { id: item.session.supervisor.controlId }).catch(() => {});
            mutate(store => removeSession(store, item.session.id));
            await sync();
            state.status = 'Session forgotten.';
            return {};
        }
        if (choice.action === 'new' || item?.kind !== 'pair') {
            if (showExistingPair(state, read().sessions, live)) return {};
            state.draft = { supervisor: {}, worker: {} };
            state.level = nextLevel('supervisor', 'robot');
            return {};
        }
        state.supervised = item.session.id;
        state.remembered.roles = 0;
        state.level = 'pair';
        return {};
    }

    async function robotScreen(state, role, { tabs, status }) {
        const header = { ...tabs, title: [`Supervised sessions — ${folder}`,
            `Choose a robot for the ${labels[role].toLowerCase()}`] };
        let robots;
        try { robots = (await menu.busy(header, () => api('robots', {}))).robots || []; }
        catch (error) { state.status = failure(error); state.level = ENTRY_LEVEL; return {}; }
        if (!robots.length) {
            state.status = 'No robot exists yet: create one in RoboTeam.';
            state.level = ENTRY_LEVEL;
            return {};
        }
        const items = robots.map(entry => ({ label: entry.name, detail: entry.default ? 'default' : entry.id, entry }));
        const previous = robots.findIndex(entry => entry.id === state.remembered[`${role}Robot`]);
        const selected = previous >= 0 ? previous : Math.max(0, robots.findIndex(entry => entry.default));
        const choice = await menu.select({ ...header, items, status,
            help: '↑/↓ select · Enter choose · Backspace back · Shift+Tab coding · q quit' }, { selected });
        state.status = '';
        if (choice.action === 'tab') return { mode: 'coding' };
        if (choice.action === 'quit') return { quit: true };
        if (choice.action === 'back') {
            state.level = role === 'supervisor' ? ENTRY_LEVEL : nextLevel('supervisor', 'robot');
            return {};
        }
        const entry = items[choice.index].entry;
        state.remembered[`${role}Robot`] = entry.id;
        state.draft[role] = { robotId: entry.id, robotName: entry.name };
        state.level = nextLevel(role, 'agent');
        return {};
    }

    async function agentScreen(state, role, { tabs, status }) {
        const header = { ...tabs, title: [`Supervised sessions — ${folder}`,
            `${labels[role]} robot ${state.draft[role].robotName} › choose a coding agent`, ...(status ? [status] : [])] };
        let listed;
        try { listed = await menu.busy(header, () => api('agents', { robot: state.draft[role].robotId })); }
        catch (error) { state.status = failure(error); state.level = nextLevel(role, 'robot'); return {}; }
        const names = listed.codingAgents || [];
        if (!names.length) {
            state.status = `Robot ${state.draft[role].robotName} has no coding agent enabled.`;
            state.level = nextLevel(role, 'robot');
            return {};
        }
        const items = names.map(name => ({ label: name, detail: name === listed.active ? 'active' : '' }));
        const preferred = names.includes(state.remembered[`${role}Agent`]) ? state.remembered[`${role}Agent`] : listed.active;
        const choice = await menu.select({ ...header, items, status,
            help: '↑/↓ select · Enter choose · Backspace robots · Shift+Tab coding · q quit' },
        { selected: Math.max(0, names.indexOf(preferred)) });
        state.status = '';
        if (choice.action === 'tab') return { mode: 'coding' };
        if (choice.action === 'quit') return { quit: true };
        if (choice.action === 'back') { state.level = nextLevel(role, 'robot'); return {}; }
        state.remembered[`${role}Agent`] = names[choice.index];
        state.draft[role] = { ...state.draft[role], codingAgent: names[choice.index] };
        if (role === 'supervisor') { state.level = nextLevel('worker', 'robot'); return {}; }
        let record;
        try {
            const live = await runningTerminals(client);
            if (showExistingPair(state, read().sessions, live)) return {};
            mutate(store => ({ ...store, sessions: store.sessions.map(session => session.folder === folderPath
                ? { ...session, phase: 'ended' } : session) }));
            await sync();
            record = await menu.busy({ ...header, status: 'Starting both sessions…' }, () => createSupervisedPair({
                api, client, openTerminal, directory, folder: folderPath,
                supervisor: state.draft.supervisor, worker: state.draft.worker,
                now,
            }));
        } catch (error) {
            state.status = `Could not start the pair: ${failure(error)}`;
            state.level = nextLevel('worker', 'agent');
            return {};
        }
        mutate(store => upsertSession(store, record));
        await sync();
        state.supervised = record.id;
        state.remembered.roles = 0;
        state.draft = { supervisor: {}, worker: {} };
        state.level = 'pair';
        menu.close();
        errorOutput.write(`\r\nSupervisor and Worker started. ${SESSION_KEYS}.\r\n`);
        try {
            const result = await attach(record.id, 'supervisor');
            if (RELAY_EXIT_REASONS.includes(result.reason)) return { quit: true };
            state.status = relayStatus(result.reason);
        } catch (error) { state.status = `Attach failed: ${failure(error)}`; }
        return {};
    }

    async function pairScreen(state, { tabs, status }) {
        const record = findSession(read(), state.supervised);
        if (!record) { state.level = ENTRY_LEVEL; state.status = 'That session is no longer saved.'; return {}; }
        const header = { ...tabs, title: [`Supervised sessions — ${folder}`, `${record.label || record.folder} › choose a session`, ...(status ? [status] : [])] };
        const load = async () => ({
            items: pairRoleItems(record, await runningTerminals(client), now()),
            status: [state.status, courierStatus.get(record.id) || ''].filter(Boolean).join(' · '),
        });
        let items;
        try { items = (await menu.busy(header, load)).items; }
        catch (error) { state.status = failure(error); state.level = ENTRY_LEVEL; return {}; }
        const note = courierStatus.get(record.id) || '';
        const view = { ...header, items, status: [status, note].filter(Boolean).join(' · '),
            help: '↑/↓ select · Enter attach · k kill · Backspace sessions · Shift+Tab coding · q quit · '
                + `in a session: ${SESSION_KEYS}` };
        const choice = await menu.select(view, { selected: state.remembered.roles,
            actions: { k: 'kill', delete: 'kill' }, refreshMs, load });
        state.status = '';
        state.remembered.roles = choice.index;
        if (choice.action === 'tab') return { mode: 'coding' };
        if (choice.action === 'quit') return { quit: true };
        if (choice.action === 'back') { state.level = ENTRY_LEVEL; return {}; }
        const item = items[choice.index];
        if (item?.kind !== 'role') { state.status = 'Choose a session to attach.'; return {}; }
        if (choice.action === 'kill') {
            if (!item.row) { state.status = 'Only a running session can be killed.'; return {}; }
            if (!await menu.confirm({ ...view, selected: choice.index },
                `Kill ${item.label}? Its conversation stays resumable.`)) return {};
            try {
                await killRoles(client, record, item.role);
                if (!items.some(other => other.role !== item.role && other.row)) {
                    mutate(store => updateSession(store, record.id, () => ({ phase: 'ended' }), now));
                    await sync();
                }
                state.status = `Killed ${labels[item.role]}.`;
            } catch (error) { state.status = `Kill failed: ${failure(error)}`; }
            return {};
        }
        let result;
        try {
            result = await menu.busy({ ...view, selected: choice.index, status: `Attaching to the ${labels[item.role].toLowerCase()}…` },
                async () => {
                    menu.close();
                    errorOutput.write(`\r\n${record.label || record.folder}: Supervisor ${record.supervisor.codingAgent} and `
                        + `Worker ${record.worker.codingAgent}. ${SESSION_KEYS}.\r\n`);
                    return attach(record.id, item.role);
                });
        } catch (error) { state.status = `Attach failed: ${failure(error)}`; return {}; }
        if (RELAY_EXIT_REASONS.includes(result.reason)) return { quit: true };
        state.status = relayStatus(result.reason);
        state.level = 'pair';
        return {};
    }

    // One screen of the supervised tab. `mode: 'coding'` asks the command to
    // switch tabs, `quit` ends it, and nothing else leaves the supervised tab.
    async function screen(state) {
        const tabs = supervisionTabs('supervised');
        const context = { tabs, status: state.status };
        if (state.level === ENTRY_LEVEL) return pairsScreen(state, context);
        if (state.level === 'supervisor-robot' || state.level === 'worker-robot') {
            return robotScreen(state, state.level === 'supervisor-robot' ? 'supervisor' : 'worker', context);
        }
        if (state.level === 'supervisor-agent' || state.level === 'worker-agent') {
            return agentScreen(state, state.level === 'supervisor-agent' ? 'supervisor' : 'worker', context);
        }
        return pairScreen(state, context);
    }

    return {
        screen,
        sync,
        stop() {}, // Terminal control and monitoring belong to the server.
        statusFor: id => courierStatus.get(id) || '',
        courierCount: () => 0,
    };
}
