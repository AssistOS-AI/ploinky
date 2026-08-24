import fs from 'fs';
import path from 'path';
import { requireAdminControlRequest } from '../adminControlSecurity.js';
import { ROUTING_FILE, PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { getAllServerStatuses } from '../serverManager.js';
import { workspaceMetricsMonitor } from '../workspaceMetrics.js';
import { cleanupWhenResponseCloses } from '../streamLifecycle.js';

const appName = 'status';

function collectServerStatuses() {
    try {
        return getAllServerStatuses();
    } catch (_) {
        return {};
    }
}

function collectStaticInfo() {
    try {
        const routing = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) || {};
        const staticAgent = routing?.static?.agent || null;
        const shortAgentName = typeof staticAgent === 'string' && staticAgent.includes('/')
            ? staticAgent.split('/').pop()
            : staticAgent;
        const routes = routing?.routes && typeof routing.routes === 'object' ? routing.routes : {};
        const routeEntry = routes[staticAgent] || routes[shortAgentName] || Object.values(routes).find((route) => {
            const routeRef = route?.repo && route?.agent ? `${route.repo}/${route.agent}` : '';
            return routeRef === staticAgent;
        }) || {};
        const hostPath = routing?.static?.hostPath || routeEntry.hostPath || null;
        let repo = null;
        if (hostPath) {
            // Extract repo name from path like /path/to/.ploinky/repos/repoName/agentName
            const pathParts = hostPath.split(path.sep);
            const reposIndex = pathParts.indexOf('repos');
            if (reposIndex !== -1 && reposIndex < pathParts.length - 1) {
                repo = pathParts[reposIndex + 1];
            } else {
                // Fallback: get parent directory name
                repo = path.basename(path.dirname(hostPath));
            }
        }
        return {
            agent: staticAgent,
            hostPath,
            port: routing?.port || null,
            repo: repo
        };
    } catch (_) {
        return { agent: null, hostPath: null, port: null, repo: null };
    }
}

export function streamWorkspaceMetrics(res, {
    decorate = (snapshot) => snapshot,
    isAuthorized = () => true,
    monitor = workspaceMetricsMonitor,
} = {}) {
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
    });
    let unsubscribe = () => {};
    const stop = () => {
        unsubscribe();
        if (!res.writableEnded) res.end();
    };
    unsubscribe = monitor.subscribe((snapshot) => {
        if (!isAuthorized()) {
            queueMicrotask(stop);
            return;
        }
        if (!res.writableEnded) res.write(`${JSON.stringify(decorate(snapshot))}\n`);
    });
    cleanupWhenResponseCloses(res, unsubscribe);
}

function handleStatus(req, res) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.substring(`/${appName}`.length) || '/';

    if (!requireAdminControlRequest(req, res)) return;

    if (pathname === '/data') {
        const requestBase = {
            workspace: path.basename(PLOINKY_WORKSPACE_ROOT),
            servers: collectServerStatuses(),
            static: collectStaticInfo(),
        };
        const decorate = (snapshot) => ({ ...requestBase, ...snapshot });
        if (parsedUrl.searchParams.get('follow') === '1') {
            streamWorkspaceMetrics(res, { decorate });
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(decorate(workspaceMetricsMonitor.latest || { ok: true, runtimes: [], total: {} })));
        return;
    }

    res.writeHead(404);
    res.end('Not Found in App');
}

export { handleStatus };
