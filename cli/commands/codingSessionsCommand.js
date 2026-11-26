import fs from 'node:fs';
import path from 'node:path';

import { listCodingSessionProviders } from '../utils/codingSessionProviders.mjs';
import { ListMenu } from '../utils/codingSessionsMenu.mjs';
import { createSupervisionCourier } from '../utils/supervisionCourier.mjs';
import { RELAY_EXIT_REASONS, relayStatus, supervisionTabs } from '../utils/supervisionFlow.mjs';
import { storePath } from '../utils/supervisedSessions.mjs';
import {
    LocalRouterClient, RELAY_KEY_LABELS, RouterRequestError, TerminalRelay, terminalDimensions,
} from '../utils/webttyCliClient.mjs';
import { createSupervisedScreen } from './supervisedSessionsScreen.js';

// `ploinky cs` (`ploinky coding-sessions`): a menu of the coding sessions an
// enabled agent provides in the caller's folder. The person picks a robot (the
// default robot is preselected), then one of its coding agents, then a session:
// a running one to attach, an earlier conversation to resume, or a new one.
// Shift+Tab switches to supervised sessions, where one coding agent supervises
// another through two files in the folder.
// The Router owns every terminal, so sessions are also listed in Live
// Sessions. Leaving a terminal in any way detaches it and it keeps running;
// Ctrl+] detaches back to the menu. Exiting the agent, or a kill from the menu
// or Live Sessions, ends it.

const PAIR_REFRESH_MS = 5_000;

export function codingSessionsError(message, code = 'PLOINKY_CODING_SESSIONS_FAILED') {
    return Object.assign(new Error(message), { code });
}

function selectProvider(providers) {
    if (!providers.length) {
        throw codingSessionsError('No enabled agent in this workspace provides coding sessions. Start the workspace that '
            + 'includes one (for example `ploinky start explorer`) and retry.', 'PLOINKY_CODING_SESSIONS_PROVIDER_MISSING');
    }
    if (providers.length > 1) {
        throw codingSessionsError(`Several enabled agents provide coding sessions: `
            + `${providers.map(provider => `${provider.repo}/${provider.agent}`).join(', ')}.`, 'PLOINKY_CODING_SESSIONS_PROVIDER_AMBIGUOUS');
    }
    return providers[0];
}

// The folder is the host launch folder, passed into the Box by the host command.
export function workspaceRelativeDirectory(workspaceRoot, directory, { realpath = fs.realpathSync } = {}) {
    const root = realpath(workspaceRoot);
    const selected = realpath(directory);
    const relative = path.relative(root, selected);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw codingSessionsError(`${selected} is outside the workspace ${root}.`, 'PLOINKY_CODING_SESSIONS_DIRECTORY');
    }
    return relative.split(path.sep).join('/');
}

export function describeFailure(error, provider) {
    if (!(error instanceof RouterRequestError)) {
        if (['ECONNREFUSED', 'ECONNRESET', 'ROUTER_TIMEOUT'].includes(error?.code)) {
            return 'The Ploinky Router is not reachable. Start the workspace (`ploinky start`) and retry.';
        }
        return error?.message || String(error);
    }
    if ([502, 503, 504].includes(error.status)) {
        return `${provider.agent} is not running or not ready (${error.message}). Start the workspace and retry.`;
    }
    return error.message;
}

// `<robot>.<environment>.<coding agent>[.r-<id>|.n-<id>]`: the profile names the
// robot, the coding agent and, when known, the native conversation.
export function parseSessionProfile(profileId) {
    const parts = typeof profileId === 'string' ? profileId.split('.') : [];
    if (parts.length < 3 || parts.length > 4) return null;
    const conversation = parts[3]?.match(/^[rn]-([A-Za-z0-9_-]+)$/u);
    if (parts.length === 4 && !conversation) return null;
    return { robotId: parts[0], codingAgent: parts[2], nativeSessionId: conversation?.[1] || null };
}

export function codingSessionApi(client, provider) {
    return (route, body) => client.json('POST', `${provider.api}/${route}`, body);
}

// The running terminals of this provider for the robot's coding agent in the folder.
export async function listLiveSessions(client, provider, { robotId, codingAgent, directory }) {
    const listed = await client.json('GET', '/webtty/live-sessions');
    return (Array.isArray(listed?.sessions) ? listed.sessions : []).filter((row) => {
        if (row?.source !== 'webtty' || row.status === 'exited' || row.profileProvider !== provider.agent) return false;
        const profile = parseSessionProfile(row.profileId);
        return profile?.robotId === robotId && profile.codingAgent === codingAgent && row.cwd === directory;
    }).map(row => ({ ...row, nativeSessionId: parseSessionProfile(row.profileId).nativeSessionId }));
}

function unavailableTerminalMessage(detail, directory, rows) {
    const where = directory || 'the workspace root';
    const reasons = new Set(rows.map(row => row.unavailable).filter(Boolean));
    if (reasons.has('quarantined')) {
        return `${detail} is quarantined because an earlier terminal on it could not be proven cleaned up. `
            + 'Restart the workspace (`ploinky restart`) to recover it, then retry.';
    }
    if (reasons.has('home-unreachable')) return `${detail} cannot see the robot home folder.`;
    if (reasons.has('home-read-only')) return `${detail} can only read the robot home folder.`;
    return rows.length
        ? `${detail} cannot open a writable terminal in ${where}.`
        : `${detail} cannot reach ${where}; run this from a project folder in the workspace.`;
}

// Opens the launched profile as a new terminal that outlives this view.
export async function openSessionTerminal(client, provider, launched, { directory, output }) {
    if (typeof launched?.profile !== 'string' || !launched.profile) {
        throw codingSessionsError(`${provider.agent} did not return a terminal profile.`);
    }
    const discovery = (await client.json('POST', '/webtty/target-discoveries', {
        dir: directory,
        profile: { provider: provider.agent, id: launched.profile },
    }))?.discovery;
    const detail = `${provider.repo}/${provider.agent}`;
    const rows = Array.isArray(discovery?.targets)
        ? discovery.targets.filter(target => target.kind === 'agent' && target.detail === detail) : [];
    const writable = rows.filter(target => target.access === 'rw' && typeof target.launch === 'string');
    if (writable.length !== 1) {
        if (discovery?.id) await client.json('DELETE', `/webtty/target-discoveries/${discovery.id}`).catch(() => {});
        throw codingSessionsError(unavailableTerminalMessage(detail, directory, rows));
    }
    const created = await client.json('POST', '/webtty/sessions', {
        launch: writable[0].launch,
        ...terminalDimensions(output),
        closePolicy: 'keep',
    });
    return { sessionId: created.session.id, viewId: created.view.id };
}

// Attaches a new view to a running terminal; the view then takes its size.
export async function attachSessionTerminal(client, row, { output }) {
    const token = await client.json('POST', `/webtty/live-sessions/${encodeURIComponent(row.id)}/attach-tokens`, {});
    const attached = await client.json('POST', '/webtty/attachments', { attach: token.attach, ...terminalDimensions(output) });
    return { sessionId: attached.session.id, viewId: attached.view.id };
}

function ago(timestamp, now) {
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
}

// The session list: a new session first, then the running terminals, then the
// earlier conversations that no running terminal holds.
export function sessionItems({ live, history, now = Date.now() }) {
    const titles = new Map(history.map(session => [session.id, session.title]));
    const running = new Set(live.map(row => row.nativeSessionId).filter(Boolean));
    return [
        { kind: 'new', label: '+ New session' },
        ...live.map(row => ({
            kind: 'live', row,
            label: `● ${titles.get(row.nativeSessionId) || (row.nativeSessionId ? row.nativeSessionId : 'new session')}`,
            detail: `${row.status}${row.viewerCount ? ` · ${row.viewerCount} view${row.viewerCount === 1 ? '' : 's'}` : ''} · ${ago(row.lastActivityAt, now)}`,
        })),
        ...history.filter(session => !running.has(session.id)).map(session => ({
            kind: 'history', session, label: `  ${session.title || session.id}`, detail: ago(session.updatedAt, now), dim: false,
        })),
    ];
}

export async function runCodingSessionsCommand({
    env = process.env,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    routerPort,
    mintSessionToken,
    listProviders = listCodingSessionProviders,
    createClient = options => new LocalRouterClient(options),
    createRelay = options => new TerminalRelay(options),
    createMenu = options => new ListMenu(options),
    createCourier = createSupervisionCourier,
    settleSupervision = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    supervisionSettleMs = 2_000,
    pairRefreshMs = PAIR_REFRESH_MS,
    now = () => Date.now(),
} = {}) {
    const workspaceRoot = env.PLOINKY_WORKSPACE_ROOT;
    const provider = selectProvider(listProviders(workspaceRoot));
    if (!input.isTTY || !output.isTTY) {
        throw codingSessionsError('Coding sessions need an interactive terminal.', 'PLOINKY_CODING_SESSIONS_TTY');
    }
    const directory = workspaceRelativeDirectory(workspaceRoot, env.PLOINKY_SKILL_SCOPE || process.cwd());
    if (!mintSessionToken) {
        const { mintSessionJwt } = await import('../server/auth/localService.js');
        mintSessionToken = sid => mintSessionJwt({
            id: 'local:admin', username: 'admin', name: 'Local CLI', email: '', roles: ['user', 'admin'],
        }, 1, { channel: 'cli', sid });
    }
    if (!routerPort) routerPort = (await import('../sandbox/routerPort.js')).resolvePersistedRouterPort();
    const client = createClient({ port: routerPort, mintSessionToken });
    const api = codingSessionApi(client, provider);
    const menu = createMenu({ input, output });
    const folder = directory || 'workspace root';
    // The absolute folder the agents and the courier both see.
    const folderPath = directory ? path.join(workspaceRoot, ...directory.split('/')) : workspaceRoot;
    const keyHelp = `${RELAY_KEY_LABELS.detach} detach`;
    const failure = error => describeFailure(error, provider);

    let mode = 'coding';
    let level = 'robots';
    let robot = null;
    let codingAgent = null;
    let status = '';
    const remembered = { robots: null, agents: null, sessions: 0 };
    const openTerminal = launched => openSessionTerminal(client, provider, launched, { directory, output });
    const supervised = createSupervisedScreen({
        menu, client, api, directory, folder, folderPath,
        openTerminal,
        attachTerminal: attachSessionTerminal,
        createRelay,
        createCourier,
        input,
        output,
        errorOutput,
        storeFile: () => storePath(workspaceRoot),
        now,
        settle: settleSupervision,
        settleMs: supervisionSettleMs,
        refreshMs: pairRefreshMs,
    });
    const supervisedState = {
        level: 'pairs',
        status: '',
        draft: { supervisor: {}, worker: {} },
        remembered: { pairs: 0, roles: 0 },
        supervised: '',
    };

    try {
        while (true) {
            if (mode === 'supervised') {
                const outcome = await supervised.screen(supervisedState);
                if (outcome.mode) {
                    mode = outcome.mode;
                    level = 'robots';
                }
                if (outcome.quit) return 0;
                continue;
            }
            if (level === 'robots') {
                const header = { ...supervisionTabs(mode), title: [`Coding sessions — ${folder}`, 'Choose a robot'] };
                let robots;
                try { robots = (await menu.busy(header, () => api('robots', {}))).robots || []; }
                catch (error) { throw codingSessionsError(failure(error)); }
                if (!robots.length) throw codingSessionsError('No robot exists yet: create one in RoboTeam.');
                const items = robots.map(entry => ({ label: entry.name, detail: entry.default ? 'default' : entry.id, entry }));
                const previous = robots.findIndex(entry => entry.id === remembered.robots);
                const selected = previous >= 0 ? previous : Math.max(0, robots.findIndex(entry => entry.default));
                const choice = await menu.select({ ...header, items, status,
                    help: '↑/↓ select · Enter choose · Shift+Tab supervised · q quit' }, { selected });
                status = '';
                if (choice.action === 'tab') { mode = 'supervised'; continue; }
                if (choice.action !== 'enter') return 0;
                robot = items[choice.index].entry;
                remembered.robots = robot.id;
                level = 'agents';
                continue;
            }
            if (level === 'agents') {
                const header = { ...supervisionTabs(mode), title: [`Coding sessions — ${folder}`,
                    `Robot ${robot.name} › choose a coding agent`] };
                let listed;
                try { listed = await menu.busy(header, () => api('agents', { robot: robot.id })); }
                catch (error) { status = failure(error); level = 'robots'; continue; }
                const names = listed.codingAgents || [];
                if (!names.length) { status = `Robot ${robot.name} has no coding agent enabled.`; level = 'robots'; continue; }
                const items = names.map(name => ({ label: name, detail: name === listed.active ? 'active' : '' }));
                const preferred = remembered.agents && names.includes(remembered.agents) ? remembered.agents : listed.active;
                const choice = await menu.select({ ...header, items, status,
                    help: '↑/↓ select · Enter choose · Backspace robots · Shift+Tab supervised · q quit' },
                { selected: Math.max(0, names.indexOf(preferred)) });
                status = '';
                if (choice.action === 'tab') { mode = 'supervised'; continue; }
                if (choice.action === 'quit') return 0;
                if (choice.action === 'back') { level = 'robots'; continue; }
                codingAgent = names[choice.index];
                remembered.agents = codingAgent;
                remembered.sessions = 0;
                level = 'sessions';
                continue;
            }
            const header = { ...supervisionTabs(mode), title: [`Coding sessions — ${folder}`, `Robot ${robot.name} › ${codingAgent}`] };
            let items;
            try {
                const [live, history] = await menu.busy(header, () => Promise.all([
                    listLiveSessions(client, provider, { robotId: robot.id, codingAgent, directory }),
                    api('history', { robot: robot.id, codingAgent, directory }).then(result => result.sessions || []),
                ]));
                items = sessionItems({ live, history, now: now() });
            } catch (error) { status = failure(error); level = 'agents'; continue; }
            const view = { ...header, items, status,
                help: `↑/↓ select · Enter open · n new · k kill · r refresh · Backspace agents · Shift+Tab supervised · `
                    + `q quit · in a session: ${keyHelp}` };
            const choice = await menu.select(view, { selected: remembered.sessions, actions: { n: 'new', k: 'kill', delete: 'kill', r: 'refresh' } });
            status = '';
            remembered.sessions = choice.index;
            if (choice.action === 'tab') { mode = 'supervised'; continue; }
            if (choice.action === 'quit') return 0;
            if (choice.action === 'back') { level = 'agents'; continue; }
            if (choice.action === 'refresh') continue;
            const item = choice.action === 'new' ? items[0] : items[choice.index];
            if (choice.action === 'kill') {
                if (item.kind !== 'live') { status = 'Only a running session can be killed.'; continue; }
                if (!await menu.confirm({ ...view, selected: choice.index }, `Kill ${item.label.slice(2)}? Its conversation stays resumable.`)) continue;
                try { await client.json('DELETE', `/webtty/sessions/${encodeURIComponent(item.row.id)}`); status = 'Session killed.'; }
                catch (error) { status = failure(error); }
                continue;
            }
            let terminal;
            try {
                terminal = await menu.busy({ ...header, status: item.kind === 'live' ? 'Attaching…' : 'Starting…' }, async () => {
                    if (item.kind === 'live') return attachSessionTerminal(client, item.row, { output });
                    const launched = await api('launch', { robot: robot.id, codingAgent, directory,
                        resume: item.kind === 'history' ? item.session.id : null });
                    return openSessionTerminal(client, provider, launched, { directory, output });
                });
            } catch (error) { status = failure(error); continue; }
            menu.close();
            errorOutput.write(`\r\n${codingAgent} for robot ${robot.name} in ${folder}. ${keyHelp}; `
                + 'it is also in Explorer > Live Sessions.\r\n');
            const result = await createRelay({ client, ...terminal, input, output }).run();
            if (RELAY_EXIT_REASONS.includes(result.reason)) return 0;
            status = result.error || relayStatus(result.reason);
        }
    } finally {
        menu.close();
        supervised.stop();
    }
}
