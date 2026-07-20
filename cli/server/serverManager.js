import fs from 'fs';
import path from 'path';
import net from 'net';
import { RUNNING_DIR, SERVERS_CONFIG_FILE } from '../utils/config.js';
import { appendLog } from '../server/utils/logger.js';

function getRandomPort(min = 10000, max = 60000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function isPortAvailable(port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close();
            resolve(true);
        });
        server.listen(port, '127.0.0.1');
    });
}

export async function findAvailablePort(min = 10000, max = 60000, maxAttempts = 50) {
    for (let i = 0; i < maxAttempts; i++) {
        const port = getRandomPort(min, max);
        if (await isPortAvailable(port)) {
            return port;
        }
    }
    throw new Error('Could not find available port after ' + maxAttempts + ' attempts');
}

export function loadServersConfig() {
    try {
        if (fs.existsSync(SERVERS_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(SERVERS_CONFIG_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn('Error loading servers config:', e.message);
    }
    return {
        webchat: { port: null, command: null },
        dashboard: { port: null }
    };
}

export function saveServersConfig(config) {
    try {
        fs.mkdirSync(path.dirname(SERVERS_CONFIG_FILE), { recursive: true });
        fs.writeFileSync(SERVERS_CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Error saving servers config:', e.message);
    }
}

export async function ensureServerConfig(serverName, options = {}) {
    const config = loadServersConfig();
    const server = config[serverName] || {};

    if (!server.port || options.forceNewPort) {
        server.port = await findAvailablePort();
    } else {
        const available = await isPortAvailable(server.port);
        if (!available && !options.keepExistingPort) {
            server.port = await findAvailablePort();
        }
    }

    if (options.command !== undefined) server.command = options.command;
    if (options.agent !== undefined) server.agent = options.agent;

    config[serverName] = server;
    saveServersConfig(config);

    return server;
}

export function getServerConfig(serverName) {
    const config = loadServersConfig();
    return config[serverName] || null;
}

export function updateServerConfig(serverName, updates) {
    const config = loadServersConfig();
    if (!config[serverName]) {
        config[serverName] = {};
    }
    Object.assign(config[serverName], updates);
    saveServersConfig(config);
    return config[serverName];
}

export function isServerRunning(pidFile) {
    try {
        const pidPath = path.join(RUNNING_DIR, pidFile);
        if (fs.existsSync(pidPath)) {
            const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
            if (pid && !Number.isNaN(pid)) {
                try {
                    process.kill(pid, 0);
                    return { running: true, pid };
                } catch {
                    return { running: false, pid };
                }
            }
        }
    } catch (_) {}
    return { running: false, pid: null };
}

export function stopServer(pidFile, serverName) {
    try {
        const pidPath = path.join(RUNNING_DIR, pidFile);
        if (fs.existsSync(pidPath)) {
            const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
            if (pid && !Number.isNaN(pid)) {
                try {
                    process.kill(pid, 'SIGTERM');
                    appendLog('process_signal', {
                        action: 'stop_server',
                        serverName,
                        pid,
                        signal: 'SIGTERM',
                        source: 'serverManager.stopServer'
                    });
                    console.log(`Stopped ${serverName} (pid ${pid}).`);
                } catch (err) {
                    appendLog('process_signal_failed', {
                        action: 'stop_server',
                        serverName,
                        pid,
                        signal: 'SIGTERM',
                        error: err?.message || String(err)
                    });
                    console.log(`Failed to stop ${serverName} (pid ${pid}).`);
                }
            }
            try {
                fs.unlinkSync(pidPath);
            } catch (_) {}
        }
    } catch (_) {}
}

export function getAllServerStatuses() {
    const config = loadServersConfig();
    const statuses = {};

    const servers = [
        { name: 'webchat', pidFile: 'webchat.pid', displayName: 'WebChat' },
        { name: 'dashboard', pidFile: 'dashboard.pid', displayName: 'Dashboard' }
    ];

    for (const server of servers) {
        const cfg = config[server.name] || {};
        const status = isServerRunning(server.pidFile);
        statuses[server.name] = {
            displayName: server.displayName,
            running: status.running,
            pid: status.pid,
            port: cfg.port,
            command: cfg.command,
            agent: cfg.agent
        };
    }

    return statuses;
}
