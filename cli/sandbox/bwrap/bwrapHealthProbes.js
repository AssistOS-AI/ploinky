import { execSync } from 'child_process';
import { debugLog } from '../../utils/utils.js';

/**
 * Run a health check against a bwrap agent's HTTP endpoint.
 * Since bwrap agents share the host network, we can curl localhost directly.
 */
function runBwrapHealthCheck(agentName, port, { timeout = 5000 } = {}) {
    if (!port) {
        debugLog(`[bwrap-health] ${agentName}: no port configured, skipping health check`);
        return { success: true, reason: 'no port' };
    }

    try {
        execSync(`curl -sf http://127.0.0.1:${port}/health`, {
            timeout,
            stdio: 'pipe'
        });
        return { success: true };
    } catch (e) {
        const reason = e.killed ? 'timeout' : `HTTP health check failed (port ${port})`;
        debugLog(`[bwrap-health] ${agentName}: ${reason}`);
        return { success: false, reason };
    }
}

export { runBwrapHealthCheck };
