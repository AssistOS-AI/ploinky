import fs from 'node:fs';
import path from 'node:path';

// Direct WebChat handler tests bypass Router authorization, so they supply the
// target binding that authorization attaches to a page or runtime request. The
// helper deliberately imports no product module: product modules read the
// workspace root when first imported, and tests set it before importing them.
export function installWebchatBindingFixture(workspaceRoot, {
    routeKey = 'generic-test-agent',
    hostPath = '',
    repo = 'fixtures',
    agent = routeKey,
    container = `${routeKey}-container`,
    manifest = null,
} = {}) {
    const ploinkyDir = path.join(workspaceRoot, '.ploinky');
    const targetPath = hostPath || path.join(ploinkyDir, 'webchat-binding-fixture', routeKey);
    fs.mkdirSync(targetPath, { recursive: true });
    if (manifest) fs.writeFileSync(path.join(targetPath, 'manifest.json'), JSON.stringify(manifest));
    const routingFile = path.join(ploinkyDir, 'routing.json');
    let routing = {};
    try { routing = JSON.parse(fs.readFileSync(routingFile, 'utf8')) || {}; } catch (_) { routing = {}; }
    routing.routes = {
        ...(routing.routes || {}),
        [routeKey]: { ...(routing.routes?.[routeKey] || {}), hostPath: targetPath, repo, agent, ...(container ? { container } : {}) },
    };
    fs.mkdirSync(ploinkyDir, { recursive: true });
    fs.writeFileSync(routingFile, JSON.stringify(routing, null, 2));
    const binding = (selector = '') => ({
        scope: 'control',
        host: '127.0.0.1',
        selector,
        target: routeKey,
        declaration: '',
        ownerRouteKey: routeKey,
        generation: 'webchat-binding-fixture',
        targetRoute: { routeKey, hostPath: targetPath, container: container || '', alias: '', repo, agent, cliTarget: routeKey },
    });
    return {
        routeKey,
        hostPath: targetPath,
        // Attaches the binding Router authorization would attach for this URL.
        bind(req) {
            const selector = String(new URL(req.url || '/', 'http://localhost').searchParams.get('agent') || '').trim();
            if (selector && selector !== routeKey) return req;
            req.edgeAuthContext = { routeKey, mode: 'sso', webchatBinding: binding(selector) };
            return req;
        },
        appConfig(extra = {}) {
            return {
                agentName: routeKey,
                getFactoryForCommands: (commands) => ({ agentName: commands.agentName, ttyFactory: extra.ttyFactory || {} }),
                ...extra,
            };
        },
    };
}
