import fs from 'fs';
import path from 'path';
import net from 'net';
import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT, ROUTING_FILE } from './config.js';
import * as reposSvc from './repos.js';
import { collectAgentRuntimeStates } from '../sandbox/agentRuntimeState.js';
import { getAgentsRegistry } from '../sandbox/docker/containerRegistry.js';
import { applyCurrentNoWaitReadiness } from './noWaitReadiness.js';
import { findAgent } from './utils.js';
import { gatherSsoStatus, listAuthProviders } from './security/sso.js';
import { inspectWorkspaceAgentLibSource } from '../../ploinky-box/agentlib-source.mjs';
import {
    AGENTLIB_ATTESTATION_SCHEMA_VERSION,
    AGENTLIB_ATTESTED_ENTRYPOINTS,
    AGENTLIB_ENV,
} from '../../agentlib/contract.mjs';
import { sourceIdHash } from '../../agentlib/fingerprint.mjs';
import { buildAgentLibAttestation } from '../../agentlib/runtime.mjs';

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

const supportsColor = !process.env.NO_COLOR
    && (Boolean(process.stdout.isTTY) || process.env.PLOINKY_COLOR === '1');

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

function isSha256(value) {
    return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function agentLibProofMatchesGrant(grant, attestation) {
    return Boolean(grant
        && attestation?.schemaVersion === AGENTLIB_ATTESTATION_SCHEMA_VERSION
        && isSha256(grant.fingerprint)
        && isSha256(grant.sourceIdHash)
        && attestation.deploymentFingerprint === grant.fingerprint
        && attestation.sourceIdHash === grant.sourceIdHash
        && attestation.sourceRootRealpath === grant.runtimePath
        && isSha256(attestation.packageJsonHash)
        && AGENTLIB_ATTESTED_ENTRYPOINTS.every(
            (subpath) => isSha256(attestation.entrypoints?.[subpath]),
        ));
}

/**
 * Render AgentLib admission detail for one runtime.
 *
 * Healthy proof is intentionally silent in ordinary status output. Missing or
 * divergent proof remains operator-visible, while --verbose/debug restores the
 * complete diagnostic record used before this output was made concise.
 */
export function formatAgentLibRuntimeProof(entry, { verbose = false } = {}) {
    const lines = [];
    const grant = entry?.agentLib;
    const attestation = entry?.agentLibAttestation;
    const running = Boolean(entry?.state?.running);
    const matchesGrant = agentLibProofMatchesGrant(grant, attestation);

    if (!verbose) {
        if (!running) return lines;
        if (!attestation) {
            lines.push(`     ${styles.label('AgentLib proof')}: ${styles.warn('missing — restart required')}`);
        } else if (!matchesGrant) {
            lines.push(`     ${styles.label('AgentLib proof')}: ${styles.danger('mismatch — restart required')}`);
        }
        return lines;
    }

    if (grant) {
        lines.push(`     ${styles.label('AgentLib selection')}: ${String(grant.fingerprint || '-').slice(0, 12)}`
            + `  ${styles.label('source id')}: ${String(grant.sourceIdHash || '-').slice(0, 12)}`);
    }
    if (running && attestation) {
        lines.push(`     ${styles.label('AgentLib resolved root')}: ${attestation.sourceRootRealpath || '-'}`);
        lines.push(`     ${styles.label('AgentLib proof')}: ${matchesGrant ? styles.success('admitted') : styles.danger('mismatch — restart required')}`);
        for (const [subpath, hash] of Object.entries(attestation.entrypoints || {})) {
            lines.push(`       ${subpath}: ${String(hash).slice(0, 12)}`);
        }
    } else if (running) {
        lines.push(`     ${styles.label('AgentLib proof')}: ${styles.warn('missing — restart required')}`);
    }
    return lines;
}

export function listCurrentAgents({ verbose = false } = {}) {
    const registry = getAgentsRegistry() || {};
    const runtimes = collectAgentRuntimeStates({ registry })
        .map((entry) => applyCurrentNoWaitReadiness(entry, registry));
    if (!runtimes.length) {
        console.log(styles.warn('No enabled or running agent runtimes detected.'));
        return;
    }
    console.log(styles.header('Agent runtimes:'));
    for (const entry of runtimes) {
        const binds = entry.config?.binds?.length || 0;
        const envs = entry.config?.env?.length || 0;
        const ports = (entry.config?.ports || [])
            .map(p => `${p.containerPort}->${p.hostPort || ''}`)
            .filter(Boolean)
            .join(', ');
        const status = (entry.state?.status || '-').toLowerCase();
        const statusFormatter = ({
            running: styles.success,
            exited: styles.danger,
            failed: styles.danger,
            unknown: styles.danger,
            starting: styles.warn,
            paused: styles.warn,
            restarting: styles.warn,
            created: styles.info
        })[status] || styles.warn;
        const pidInfo = entry.state?.pid ? ` ${styles.muted(`pid ${entry.state.pid}`)}` : '';
        const runtime = entry.runtime || 'container';
        console.log(`  ${bulletSymbol} ${styles.name(entry.containerName)} ${statusFormatter(`[${status}]`)} ${styles.muted(`[${runtime}]`)}${pidInfo}`);
        console.log(`     ${styles.label('agent')}: ${styles.accent(entry.agentName || '-')}` +
            `  ${styles.label('repo')}: ${styles.accent(entry.repoName || '-')}`);
        console.log(`     ${styles.label('image')}: ${entry.containerImage || '-'}`);
        console.log(`     ${styles.label('created')}: ${entry.createdAt || '-'}`);
        console.log(`     ${styles.label('cwd')}: ${entry.projectPath || '-'}`);
        const resourceParts = [
            `${styles.label('binds')}: ${binds}`,
            `${styles.label('env')}: ${envs}`
        ];
        if (ports) {
            resourceParts.push(`${styles.label('ports')}: ${ports}`);
        }
        console.log(`     ${resourceParts.join('  ')}`);
        for (const line of formatAgentLibRuntimeProof(entry, { verbose })) console.log(line);
        console.log('');
    }
}

export { applyCurrentNoWaitReadiness } from './noWaitReadiness.js';

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

/**
 * Report the selected achillesAgentLib source without mutating anything.
 *
 * A local checkout can change independently of Ploinky, so the bytes on disk
 * are hashed here and compared against the active selection: a difference is a
 * `restart required` state, not something status repairs.
 */
function printAgentLibStatus({ verbose = false } = {}) {
    let info;
    try {
        info = inspectWorkspaceAgentLibSource({ workspaceRoot: PLOINKY_WORKSPACE_ROOT });
    } catch (error) {
        console.log(`AgentLib: ${styles.warn(`unavailable (${error?.message || error})`)}`);
        return;
    }
    const where = info.sourceRelativePath || '(not selected)';
    console.log(`AgentLib source: ${info.mode} ${where}`);
    if (info.contentFingerprint) {
        const revision = info.commit
            ? `${info.commit.slice(0, 12)}${info.dirty ? ' (dirty)' : ''}${info.branch ? ` on ${info.branch}` : ''}`
            : 'no git revision';
        console.log(`AgentLib content:  ${info.contentFingerprint.slice(0, 12)} — ${revision}`);
    }
    if (info.active) {
        console.log(`AgentLib active:   ${info.active.contentFingerprint.slice(0, 12)}`
            + `${info.active.resolvedCommit ? ` @ ${info.active.resolvedCommit.slice(0, 12)}` : ''}`);
        console.log(`AgentLib identity: ${sourceIdHash(info.active.sourceId).slice(0, 12)}`
            + `  source ${info.active.sourceRelativePath}`
            + `${info.active.requestedRef ? `  requested ${info.active.requestedRef}` : ''}`);
    }
    if (info.drifted) {
        console.log(styles.warn('AgentLib: restart required — the local source no longer matches the active selection.'));
    }
    // Core proves which bytes it actually loaded, rather than reporting the
    // descriptor it was handed.
    try {
        const attestation = buildAgentLibAttestation();
        if (verbose) {
            console.log(`AgentLib core:     ${attestation.sourceRootRealpath}`);
            console.log(`AgentLib runtime:  ${String(process.env[AGENTLIB_ENV.fingerprint] || '').slice(0, 12)}`
                + `  source-id ${String(process.env[AGENTLIB_ENV.sourceId] || '').slice(0, 12)}`);
            for (const [entry, hash] of Object.entries(attestation.entrypoints)) {
                console.log(`  ${entry}: ${hash.slice(0, 12)}`);
            }
        }
    } catch (error) {
        console.log(`AgentLib core: ${styles.warn(`not attested (${error?.message || error})`)}`);
    }
    if (info.detail) console.log(`AgentLib detail: ${info.detail}`);
}

export async function statusWorkspace({ verbose = false } = {}) {
    console.log(styles.header('Workspace status:'));
    printAgentLibStatus({ verbose });
    const ssoStatus = gatherSsoStatus();
    printSsoStatusSummary(ssoStatus);

    const routerPort = ssoStatus.routerPort;
    const routerListening = await isPortListening(routerPort);
    printRouterStatus(routerPort, routerListening);

    listReposForStatus();
    listCurrentAgents({ verbose });
}
