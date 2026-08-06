import fs from 'fs';
import path from 'path';
import net from 'net';
import { PLOINKY_DIR, ROUTING_FILE } from './config.js';
import * as reposSvc from './repos.js';
import { collectAgentRuntimeStates } from '../sandbox/agentRuntimeState.js';
import { findAgent } from './utils.js';
import { gatherSsoStatus, listAuthProviders } from './security/sso.js';

const REPOS_DIR = path.join(PLOINKY_DIR, 'repos');
const PREDEFINED_REPOS = reposSvc.getPredefinedRepos();

const ANSI = {
    reset: '\u001B[0m',
    bold: '\u001B[1m',
    dim: '\u001B[2m',
    red: '\u001B[31m',
    green: '\u001B[32m',
    yellow: '\u001B[33m',
    blue: '\u001B[34m',
    magenta: '\u001B[35m',
    cyan: '\u001B[36m',
    gray: '\u001B[90m'
};

const supportsColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function colorize(text, ...styles) {
    if (!supportsColor || styles.length === 0) return text;
    return `${styles.join('')}${text}${ANSI.reset}`;
}

const styles = {
    header: (text) => colorize(text, ANSI.bold, ANSI.cyan),
    label: (text) => colorize(text, ANSI.dim),
    name: (text) => colorize(text, ANSI.cyan),
    success: (text) => colorize(text, ANSI.green),
    warn: (text) => colorize(text, ANSI.yellow),
    danger: (text) => colorize(text, ANSI.red),
    info: (text) => colorize(text, ANSI.blue),
    accent: (text) => colorize(text, ANSI.magenta),
    muted: (text) => colorize(text, ANSI.gray),
    bold: (text) => colorize(text, ANSI.bold)
};

const bulletSymbol = supportsColor ? `${ANSI.gray}\u2022${ANSI.reset}` : '-';

function formatBadge(text, formatter = (value) => value) {
    return formatter(`[${text}]`);
}

function kindBadge(kind) {
    const formatter = ({
        skills: styles.accent,
        agents: styles.info,
        mixed: styles.warn,
        unknown: styles.muted
    })[kind] || styles.muted;
    return formatBadge(kind, formatter);
}

export function findAgentManifest(agentName) {
    const { manifestPath } = findAgent(agentName);
    return manifestPath;
}

export function formatAgentRuntimeStatus(entry = {}) {
    const status = String(entry.state?.status || 'stopped').trim().toLowerCase() || 'stopped';
    const statusFormatter = ({
        running: styles.success,
        completed: styles.success,
        failed: styles.danger,
        exited: styles.danger,
        paused: styles.warn,
        restarting: styles.warn,
        created: styles.info,
        cancelled: styles.warn,
    })[status] || styles.warn;
    const runtime = entry.runtime === 'podman'
        ? 'container'
        : (String(entry.runtime || 'container').trim().toLowerCase() || 'container');
    const role = String(entry.role || 'service').trim().toLowerCase() === 'provider-task'
        ? 'provider-task'
        : 'service';
    const instance = String(entry.effectiveInstance || entry.containerName || '-').trim() || '-';
    const pidInfo = entry.state?.pid ? ` ${styles.muted(`pid ${Number(entry.state.pid) || 0}`)}` : '';
    const lines = [
        `  ${bulletSymbol} ${styles.name(instance)} ${statusFormatter(`[${status}]`)} ${styles.muted(`[${runtime}]`)} ${styles.muted(`[${role}]`)}${pidInfo}`,
        `     ${styles.label('agent')}: ${styles.accent(String(entry.agentName || '-'))}`
            + `  ${styles.label('repo')}: ${styles.accent(String(entry.repoName || '-'))}`,
    ];
    if (role === 'provider-task') {
        lines.push(
            `     ${styles.label('provider')}: ${String(entry.provider || '-')}`
                + `  ${styles.label('task')}: ${String(entry.taskId || '-')}`,
        );
    } else if (entry.containerImage) {
        lines.push(`     ${styles.label('image')}: ${String(entry.containerImage)}`);
    }
    const details = [
        ['generation', entry.enableGeneration],
        ['release', entry.releaseGeneration],
        ['owner', entry.ownerKey],
        ['process', entry.processIdentity],
        ['workdir', entry.workdir || entry.projectPath],
        ['home', entry.homeKey],
        ['readiness', entry.readiness],
        ['log', entry.logPath],
    ];
    for (const [label, value] of details) {
        if (typeof value === 'string' && value.trim()) {
            lines.push(`     ${styles.label(label)}: ${value}`);
        }
    }
    return lines.join('\n');
}

export function listRepos() {
    const installed = new Set(reposSvc.getInstalledRepos(REPOS_DIR));
    const allRepos = { ...PREDEFINED_REPOS };

    for (const repo of installed) {
        if (!allRepos[repo]) {
            allRepos[repo] = { url: 'local', description: '' };
        }
    }

    console.log('Available repositories:');
    for (const [name, info] of Object.entries(allRepos)) {
        const isInstalled = installed.has(name);
        const kind = info.kind || reposSvc.classifyRepoKind(name);
        const badges = [kindBadge(kind)];
        if (isInstalled) badges.push('[installed]');
        const url = info.url === 'local' ? '(local)' : info.url;
        console.log(`- ${name}: ${url} ${badges.join(' ')}`);
    }
    console.log("\nTip: install repos with 'install repo <url> [name]'. Agent repos are included in agent listings when installed.");
}

export function listCurrentAgents() {
    const runtimes = collectAgentRuntimeStates();
    if (!runtimes.length) {
        console.log(styles.warn('No enabled or running agent runtimes detected.'));
        return;
    }
    console.log(styles.header('Agent runtimes:'));
    for (const entry of runtimes) {
        console.log(formatAgentRuntimeStatus(entry));
        console.log();
    }
}

export function collectAgentsSummary({ includeInactive = true } = {}) {
    const repoList = includeInactive
        ? reposSvc.getInstalledRepos(REPOS_DIR)
        : reposSvc.getActiveRepos(REPOS_DIR);

    const summary = [];
    if (!repoList || repoList.length === 0) return summary;

    for (const repo of repoList) {
        const repoPath = path.join(REPOS_DIR, repo);
        const installed = fs.existsSync(repoPath);

        if (installed && reposSvc.classifyRepoKind(repo) === 'skills') {
            continue;
        }

        const record = { repo, installed, agents: [] };

        if (installed) {
            let dirs = [];
            try {
                dirs = fs.readdirSync(repoPath);
            } catch (_) {
                dirs = [];
            }

            for (const name of dirs) {
                const agentDir = path.join(repoPath, name);
                const manifestPath = path.join(agentDir, 'manifest.json');
                try {
                    if (!fs.statSync(agentDir).isDirectory() || !fs.existsSync(manifestPath)) continue;
                } catch (_) {
                    continue;
                }

                let about = '-';
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                    if (manifest && typeof manifest.about === 'string') {
                        about = manifest.about;
                    }
                } catch (_) {}

                record.agents.push({
                    repo,
                    name,
                    about,
                    manifestPath
                });
            }
        }

        summary.push(record);
    }

    return summary;
}

export function listAgents() {
    const summary = collectAgentsSummary();
    if (!summary.length) {
        const installedSkills = reposSvc.getInstalledRepos(REPOS_DIR)
            .filter(r => reposSvc.classifyRepoKind(r) === 'skills');
        if (installedSkills.length) {
            console.log(`No agent repos installed. Skills-only repos installed: ${installedSkills.join(', ')}.`);
            console.log("Use 'install repo <url> [name]' to install an agents repo, or 'list repos' to see all available.");
        } else {
            console.log('No repos installed. Use: install repo <url> [name]');
        }
        return;
    }

    for (const { repo, installed, agents } of summary) {
        console.log(`\n[Repo] ${repo}${installed ? '' : ' (not installed)'}:`);
        if (!installed) {
            console.log(`  (install with: install repo <url> ${repo})`);
            continue;
        }
        if (!agents.length) {
            console.log('  (no agents found)');
            continue;
        }
        for (const agent of agents) {
            console.log(`  - ${agent.name}: ${agent.about || '-'}`);
        }
    }
    console.log("\nTip: install agent repositories with 'install repo <url> [name]' to include them in listings.");
}

export function listRoutes() {
    try {
        const routingPath = ROUTING_FILE;
        if (!fs.existsSync(routingPath)) {
            console.log('No routing configuration found (.ploinky/routing.json missing).');
            console.log("Tip: run 'start <staticAgent> <port>' to generate it.");
            return;
        }
        let routing = {};
        try {
            routing = JSON.parse(fs.readFileSync(routingPath, 'utf8')) || {};
        } catch (e) {
            console.log('Invalid routing.json (cannot parse).');
            return;
        }

        const port = routing.port || '-';
        const staticCfg = routing.static || {};
        const routes = routing.routes || {};

        console.log('Routing configuration (.ploinky/routing.json):');
        console.log(`- Port: ${port}`);
        if (staticCfg.agent) {
            console.log(`- Static agent: ${staticCfg.agent}`);
        }
        if (Object.keys(routes).length) {
            console.log('- Routes:');
            for (const [route, config] of Object.entries(routes)) {
                const hostPort = config.hostPort !== undefined ? config.hostPort : '-';
                const method = config.method || '-';
                const agent = config.agent || '-';
                console.log(
                    `  ${route} -> agent=${agent} method=${method} hostPort=${hostPort}`
                );
            }
        } else {
            console.log('- No dynamic routes defined.');
        }
    } catch (e) {
        console.error('Failed to read routing configuration:', e.message);
    }
}

function isPortListening(port, host = '127.0.0.1', timeoutMs = 500) {
    return new Promise((resolve) => {
        if (!Number.isFinite(port) || port <= 0) {
            resolve(false);
            return;
        }
        const socket = net.createConnection({ port, host });
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_) {}
            resolve(result);
        };
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
        socket.setTimeout(timeoutMs, () => done(false));
    });
}

function collectRepoStatusRows() {
    const installedList = reposSvc.getInstalledRepos(REPOS_DIR);
    const installed = new Set(installedList);
    const allNames = new Set(installedList);
    return Array.from(allNames)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({
            name,
            installed: installed.has(name),
            predefined: PREDEFINED_REPOS[name] !== undefined
        }));
}

function listReposForStatus() {
    const rows = collectRepoStatusRows();
    if (!rows.length) {
        console.log(`- ${styles.label('Repos')}: ${styles.warn('none installed')}`);
        return;
    }
    console.log(`- ${styles.label('Repos')}:`);
    for (const row of rows) {
        const badges = [kindBadge(reposSvc.classifyRepoKind(row.name))];
        if (!row.installed) badges.push(formatBadge('missing', styles.danger));
        else if (!row.predefined) badges.push(formatBadge('local', styles.info));
        console.log(`  ${bulletSymbol} ${styles.name(row.name)} ${badges.join(' ')}`);
    }
}

function printSsoStatusSummary(ssoStatus) {
    const enabled = Boolean(ssoStatus.config.enabled) && Boolean(ssoStatus.config.providerAgent);
    if (!enabled) {
        console.log(`- ${styles.label('SSO')}: ${styles.danger('disabled')}`);
        const installedProviders = (() => {
            try { return listAuthProviders(); } catch (_) { return []; }
        })();
        if (installedProviders.length) {
            const names = installedProviders.map((p) => p.agentRef).join(', ');
            console.log(`  ${bulletSymbol} ${styles.muted(`Installed SSO providers: ${names}`)}`);
        } else {
            console.log(`  ${bulletSymbol} ${styles.muted('No SSO provider agents installed. Install one, then run: sso enable <providerAgent>')}`);
        }
        return;
    }

    console.log(`- ${styles.label('SSO')}: ${styles.success('enabled')}`);
    const providerAgent = ssoStatus.config.providerAgent || '-';
    const providerHost = ssoStatus.providerHostPort
        ? ` ${styles.muted(`(host port ${ssoStatus.providerHostPort})`)}`
        : '';
    console.log(`  ${bulletSymbol} ${styles.label('Provider agent')}: ${styles.accent(providerAgent)}${providerHost}`);
    const providerConfig = ssoStatus.config.providerConfig || {};
    const baseUrl = providerConfig.baseUrl || '(unset)';
    const redirectUri = providerConfig.redirectUri || `http://127.0.0.1:${ssoStatus.routerPort}/auth/callback`;
    console.log(`  ${bulletSymbol} ${styles.label('Base URL')}: ${baseUrl}`);
    console.log(`  ${bulletSymbol} ${styles.label('Redirect URI')}: ${redirectUri}`);
}

function printRouterStatus(routerPort, isListening) {
    const stateText = isListening ? styles.success('listening') : styles.danger('not listening');
    const endpoint = styles.muted(`(127.0.0.1:${routerPort})`);
    console.log(`- ${styles.label('Router')}: ${stateText} ${endpoint}`);
}

export async function statusWorkspace() {
    console.log(styles.header('Workspace status:'));
    const ssoStatus = gatherSsoStatus();
    printSsoStatusSummary(ssoStatus);

    const routerPort = ssoStatus.routerPort;
    const routerListening = await isPortListening(routerPort);
    printRouterStatus(routerPort, routerListening);

    listReposForStatus();
    listCurrentAgents();
}
