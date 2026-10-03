import crypto from 'node:crypto';

export const ROUTER_SUPERVISOR_ID_ENV = 'PLOINKY_ROUTER_SUPERVISOR_ID';

const SUPERVISOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isRouterSupervisorId(value) {
    return typeof value === 'string' && SUPERVISOR_ID.test(value);
}

/**
 * One id per Watchdog process. Every Router child of that Watchdog carries
 * it, so a Router can tell a replacement within the same supervision
 * lifetime from the first Router of a new one (for example after a Box
 * shutdown). Process ids are never used: a fresh Box pid namespace reuses
 * them across lifetimes.
 */
export function createRouterSupervisorId() {
    return crypto.randomUUID();
}

export function routerSupervisorEnvironment(baseEnv = {}, supervisorId) {
    if (!isRouterSupervisorId(supervisorId)) {
        throw new TypeError('Router supervisor environment requires one exact supervisor id');
    }
    return { ...baseEnv, [ROUTER_SUPERVISOR_ID_ENV]: supervisorId };
}

export function readRouterSupervisorId(env = process.env) {
    const value = env?.[ROUTER_SUPERVISOR_ID_ENV];
    return isRouterSupervisorId(value) ? value : null;
}
