import { spawn as spawnDefault } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildAgentWorkerEnvironment } from './agentWorkerEnvironment.mjs';
import { inspectExactAgentTargetAsync } from './agentTerminalWorker.mjs';
import {
    listLinuxProcessesWithArgument,
    listLinuxSessionMembers,
    readLinuxProcessIdentity,
} from './runtimeRecords.mjs';

const HELPER = fileURLToPath(new URL('./homeMountHelper.py', import.meta.url));
const PODMAN = '/usr/bin/podman';
const PYTHON = '/usr/bin/python3';
const PODMAN_HELPER_PREFIX = Object.freeze([PODMAN, 'unshare', PYTHON, '-I', '-S', HELPER]);
const PYTHON_HELPER_PREFIX = Object.freeze([PYTHON, '-I', '-S', HELPER]);
const HELPER_OPERATIONS = Object.freeze(['prepare', 'validate', 'release']);
const HELPER_SIGNALS = Object.freeze(['SIGTERM', 'SIGKILL']);
const NONCE = /^[A-Za-z0-9_-]{32}$/;
const ENCODED_CONFIG = /^[A-Za-z0-9_-]+$/;
const DESTINATION = /^\/run\/ploinky-webtty-home-[A-Za-z0-9_-]{32}$/;
const DIGITS = /^(?:0|[1-9][0-9]*)$/;
const STAGES = ['intent', 'directory', 'prepared', 'attached'];
const ID_KEYS = ['dev', 'ino'];

function fail(message) {
    const error = new Error(message);
    error.code = 'WEBTTY_HOME_PROJECTION_UNPROVEN';
    return error;
}
function exitUnproven(cause) {
    const error = fail('home projection helper exit unproven');
    error.reason = 'helper_exit_unproven';
    if (cause !== undefined) error.cause = cause;
    return error;
}
function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}
function exactKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function validIdentity(value) {
    return exactKeys(value, ID_KEYS) && ID_KEYS.every((key) => typeof value[key] === 'string' && DIGITS.test(value[key]));
}

// Durable helper ownership: the nonce-only form precedes spawn; the complete
// form adds the verified session leader before the first helper command.
export function validateHomeHelperOwnership(value) {
    const complete = exactKeys(value, ['nonce', 'operation', 'pid', 'startToken', 'uid']);
    if ((!complete && !exactKeys(value, ['nonce', 'operation']))
        || typeof value.nonce !== 'string' || !NONCE.test(value.nonce)
        || !HELPER_OPERATIONS.includes(value.operation)
        || (complete && (!Number.isSafeInteger(value.pid) || value.pid <= 1
            || typeof value.startToken !== 'string' || !/^linux-proc:\d+$/.test(value.startToken)
            || !Number.isSafeInteger(value.uid) || value.uid < 0))) {
        throw fail('invalid home projection helper ownership');
    }
    return value;
}

// One member rule for in-process stop and restart recovery: the exact podman
// argv (leader or its re-exec child) or the exact python argv, each carrying
// the nonce at its fixed position. Recovery does not persist the encoded
// configuration, so it accepts any base64url value in that final position.
function helperArgvMatches(argv, nonce, config, prefixes = [PODMAN_HELPER_PREFIX, PYTHON_HELPER_PREFIX]) {
    return Array.isArray(argv) && prefixes.some((prefix) => (
        argv.length === prefix.length + 2
        && prefix.every((value, index) => argv[index] === value)
        && argv[prefix.length] === nonce
        && (config === undefined
            ? typeof argv[prefix.length + 1] === 'string' && ENCODED_CONFIG.test(argv[prefix.length + 1])
            : argv[prefix.length + 1] === config)
    ));
}

export function validateHomeMountReceipt(receipt, { previous } = {}) {
    if (!exactKeys(receipt, ['version', 'stage', 'target', 'source', 'destination', ...(STAGES.indexOf(receipt?.stage) >= 2 ? ['mountId'] : [])])
        || receipt.version !== 1 || !STAGES.includes(receipt.stage)) throw fail('invalid home projection receipt');
    const target = receipt.target;
    if (!exactKeys(target, ['containerId', 'initPid', 'initStart', 'root', 'mountNamespace', 'userNamespace', 'mountOwner'])
        || !/^[a-f0-9]{64}$/.test(target.containerId)
        || !Number.isSafeInteger(target.initPid) || target.initPid <= 1
        || !/^linux-proc:[1-9][0-9]*$/.test(target.initStart)
        || !['root', 'mountNamespace', 'userNamespace', 'mountOwner'].every((key) => validIdentity(target[key]))
        || !validIdentity(receipt.source)) throw fail('invalid home projection identity');
    const directory = receipt.stage !== 'intent';
    if (!exactKeys(receipt.destination, directory ? ['path', 'dev', 'ino'] : ['path'])
        || typeof receipt.destination.path !== 'string' || !DESTINATION.test(receipt.destination.path)
        || (directory && !validIdentity({ dev: receipt.destination.dev, ino: receipt.destination.ino }))
        || (STAGES.indexOf(receipt.stage) >= 2 && (typeof receipt.mountId !== 'string' || !DIGITS.test(receipt.mountId)))) {
        throw fail('invalid home projection destination');
    }
    if (previous) {
        validateHomeMountReceipt(previous);
        if (STAGES.indexOf(receipt.stage) !== STAGES.indexOf(previous.stage) + 1
            || !isDeepStrictEqual(receipt.target, previous.target)
            || !isDeepStrictEqual(receipt.source, previous.source)
            || receipt.destination.path !== previous.destination.path
            || (previous.stage !== 'intent' && (receipt.destination.dev !== previous.destination.dev || receipt.destination.ino !== previous.destination.ino))
            || (previous.mountId && receipt.mountId !== previous.mountId)) throw fail('home projection receipt changed');
    }
    return receipt;
}

function validateInput(target, home, sessionId) {
    const destination = `/run/ploinky-webtty-home-${sessionId}`;
    if (!target || target.runtime !== 'podman' || !/^[a-f0-9]{64}$/.test(target.containerId)
        || !/^[A-Za-z0-9_-]{32}$/.test(sessionId)
        || typeof target.translatedCwd !== 'string' || !path.posix.isAbsolute(target.translatedCwd)
        || path.posix.normalize(target.translatedCwd) !== target.translatedCwd
        || target.translatedCwd === '/' || destination === target.translatedCwd
        || destination.startsWith(`${target.translatedCwd}/`)
        || !home || typeof home.absolutePath !== 'string' || !path.isAbsolute(home.absolutePath)
        || path.normalize(home.absolutePath) !== home.absolutePath || home.absolutePath.includes('\0')
        || !validIdentity(home.identity)) throw fail('invalid home projection request');
}
function checkSource(home) {
    const stat = fs.lstatSync(home.absolutePath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || String(stat.dev) !== home.identity.dev || String(stat.ino) !== home.identity.ino) {
        throw fail('home source identity changed');
    }
}
function freezeReceipt(receipt) {
    for (const key of ['root', 'mountNamespace', 'userNamespace', 'mountOwner']) Object.freeze(receipt.target[key]);
    Object.freeze(receipt.target);
    Object.freeze(receipt.source);
    Object.freeze(receipt.destination);
    return Object.freeze(receipt);
}

class HelperChannel {
    constructor(child, timeoutMs) {
        this.child = child;
        this.timeoutMs = timeoutMs;
        this.buffer = '';
        this.queue = [];
        this.waiter = null;
        this.failure = null;
        this.closed = false;
        // Only the child close event (process exit plus closed stdio) counts
        // as an observed exit; a spawn error is not one.
        this.exit = new Promise((resolve) => {
            child.on('close', (code, signal) => {
                this.closed = true;
                resolve({ code, signal });
            });
        });
        child.stdin.on('error', () => {});
        child.stderr.on('data', () => {});
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            this.buffer += chunk;
            if (Buffer.byteLength(this.buffer) > 65536) return this.break(fail('helper output exceeded limit'));
            let index;
            while ((index = this.buffer.indexOf('\n')) >= 0) {
                const line = this.buffer.slice(0, index);
                this.buffer = this.buffer.slice(index + 1);
                try { this.queue.push(JSON.parse(line)); } catch { return this.break(fail('malformed helper output')); }
            }
            this.flush();
        });
        child.on('error', () => this.break(fail('helper could not start')));
        child.on('close', () => this.break(fail('helper exited')));
    }
    break(error) { this.failure ||= error; this.flush(); }
    flush() {
        if (!this.waiter) return;
        if (!this.queue.length && !this.failure) return;
        const { resolve, reject, timer } = this.waiter;
        this.waiter = null;
        clearTimeout(timer);
        if (this.queue.length) resolve(this.queue.shift()); else reject(this.failure);
    }
    next() {
        if (this.waiter) return Promise.reject(fail('concurrent helper read'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.break(fail('helper response timed out')), this.timeoutMs);
            this.waiter = { resolve, reject, timer };
            this.flush();
        });
    }
    send(action) {
        if (!['proceed', 'create', 'clone', 'attach', 'finish', 'abort'].includes(action) || this.failure) throw fail('helper unavailable');
        this.child.stdin.write(`${JSON.stringify({ action })}\n`);
    }
    close() { try { this.child.stdin.end(); } catch (_) { } }
    async finished() {
        let timer;
        try {
            const exit = await Promise.race([
                this.exit,
                new Promise((resolve) => { timer = setTimeout(() => resolve(null), this.timeoutMs); }),
            ]);
            if (!exit || exit.code !== 0 || exit.signal !== null) throw fail('helper cleanup unproven');
        } finally { clearTimeout(timer); }
    }
}

export function createHomeMountBroker({
    spawnImpl = spawnDefault,
    inspectTarget = inspectExactAgentTargetAsync,
    readIdentity = readLinuxProcessIdentity,
    listSessionMembers = listLinuxSessionMembers,
    scanNonce = async (nonce) => (await listLinuxProcessesWithArgument(nonce))
        .filter((observed) => helperArgvMatches(observed?.cmdline, nonce)),
    signal = (pid, name) => process.kill(pid, name),
    uid = process.getuid?.(),
    graceMs = 2_000,
    delay = sleep,
    timeoutMs = 10_000,
} = {}) {
    async function targetProof(target, expected) {
        const record = await inspectTarget(target.containerId);
        if (record.absent || !record.running || record.id !== target.containerId) throw fail('target not running');
        const processIdentity = await readIdentity(record.initPid);
        if (!processIdentity || processIdentity.state === 'Z') throw fail('target init identity unavailable');
        if (expected && (record.initPid !== expected.initPid || processIdentity.startToken !== expected.initStart)) throw fail('target init changed');
        return { initPid: record.initPid, initStart: processIdentity.startToken };
    }

    function memberMatches(observed, sessionId, own) {
        return Boolean(observed && observed.state !== 'Z' && observed.uid === own.uid
            && observed.session === sessionId && helperArgvMatches(observed.cmdline, own.nonce, own.config));
    }
    // Every enumerated live member is verified before any signal. A member
    // that cannot be proven to be this helper blocks signalling entirely.
    async function sessionMembers(own, sessionId, recycled) {
        const listed = await listSessionMembers(sessionId);
        if (!Array.isArray(listed)) throw fail('invalid helper session evidence');
        const owned = [];
        for (const member of listed) {
            const observed = await readIdentity(member.pid);
            if (!observed || observed.state === 'Z') continue;
            if (memberMatches(observed, sessionId, own)) {
                // A recycled leader PID cannot still anchor the old session.
                if (recycled) throw fail('helper session ownership ambiguous');
                owned.push(observed);
            } else if (observed.session === sessionId
                && !(recycled && !observed.cmdline?.includes(own.nonce))) {
                throw fail('unverified helper session member');
            }
        }
        return owned;
    }
    async function collect(own) {
        if (own.pid) {
            const leader = await readIdentity(own.pid);
            return sessionMembers(own, own.pid, Boolean(leader && leader.startToken !== own.startToken));
        }
        // Nonce-only ownership (spawn gap): every live match must itself be a
        // verified helper member (uid, exact nonce-bearing argv) of its own
        // session. The podman leader may already be gone (e.g. after SIGTERM
        // the stopped python survives); Linux keeps that session id reserved
        // while any member lives, so the whole session is enumerated and every
        // member must again verify as this helper before anything is signalled.
        const matches = await scanNonce(own.nonce);
        if (!Array.isArray(matches)) throw fail('invalid helper scan evidence');
        const live = matches.filter((observed) => observed && observed.state !== 'Z');
        const sessions = new Set();
        for (const observed of live) {
            if (!Number.isSafeInteger(observed.session) || observed.session <= 1
                || !memberMatches(observed, observed.session, own)) throw fail('unverified helper process');
            if (observed.session === observed.pid
                && !(observed.pgrp === observed.pid
                    && helperArgvMatches(observed.cmdline, own.nonce, own.config, [PODMAN_HELPER_PREFIX]))) {
                throw fail('unverified helper session leader');
            }
            sessions.add(observed.session);
        }
        const owned = [];
        for (const sessionId of sessions) owned.push(...await sessionMembers(own, sessionId, false));
        return owned;
    }
    async function signalMembers(members, name, own) {
        for (const expected of members) {
            const observed = await readIdentity(expected.pid);
            if (!observed || observed.state === 'Z' || observed.startToken !== expected.startToken) continue;
            if (!memberMatches(observed, expected.session, own) || !Number.isSafeInteger(observed.pid) || observed.pid <= 1) {
                throw fail('helper session member changed');
            }
            // No asynchronous step separates this check from the exact
            // positive-PID signal; process groups are never signalled.
            try { signal(observed.pid, name); } catch (error) {
                if (error?.code !== 'ESRCH') throw fail('helper signal refused');
            }
        }
    }
    // Bounded verified TERM/KILL. Proof requires an empty owned session and,
    // with a child handle, the observed child close event.
    async function reclaim(own, channel = null) {
        const closed = () => !channel || channel.closed;
        const settle = () => (channel && !channel.closed
            ? Promise.race([channel.exit, delay(graceMs)])
            : delay(graceMs));
        let members = await collect(own);
        for (const name of HELPER_SIGNALS) {
            if (!members.length && closed()) return true;
            if (members.length) await signalMembers(members, name, own);
            await settle();
            members = await collect(own);
        }
        return !members.length && closed();
    }
    async function stopHelper(channel, own) {
        channel.close();
        if (!channel.closed) await Promise.race([channel.exit, delay(graceMs)]);
        return reclaim(own, channel);
    }
    async function record(onHelper, state) {
        let accepted = false;
        try { accepted = await onHelper(state) === true; } catch (error) {
            throw Object.assign(fail('home projection helper ownership update failed'), { cause: error });
        }
        if (!accepted) throw fail('home projection helper ownership update failed');
    }
    async function runHelper(operation, config, onHelper, body) {
        if (typeof onHelper !== 'function') throw fail('home projection helper ownership callback missing');
        const nonce = crypto.randomBytes(24).toString('base64url');
        const encoded = Buffer.from(JSON.stringify(config)).toString('base64url');
        const own = Object.freeze({ nonce, config: encoded, uid });
        await record(onHelper, { nonce, operation });
        let child = null;
        let spawnError;
        try {
            child = spawnImpl(PODMAN, ['unshare', PYTHON, '-I', '-S', HELPER, nonce, encoded], {
                cwd: '/tmp', env: buildAgentWorkerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
            });
        } catch (error) { spawnError = error; }
        const channel = child ? new HelperChannel(child, timeoutMs) : null;
        if (!channel || !Number.isSafeInteger(child.pid) || child.pid <= 1) {
            const failure = fail('helper could not start');
            if (spawnError !== undefined) failure.cause = spawnError;
            channel?.close();
            // Clear the nonce-only ownership only after a scan proves that no
            // helper process carrying this nonce exists.
            let absent = false;
            try { absent = await reclaim(own); } catch (_) { absent = false; }
            if (!absent) throw exitUnproven(failure);
            await record(onHelper, null);
            throw failure;
        }
        let ownership = null;
        let result;
        let failure = null;
        try {
            const observed = await readIdentity(child.pid);
            if (!observed || observed.pid !== child.pid || observed.state === 'Z' || observed.uid !== uid
                || observed.session !== child.pid || observed.pgrp !== child.pid
                || !helperArgvMatches(observed.cmdline, nonce, encoded, [PODMAN_HELPER_PREFIX])) {
                throw fail('home projection helper identity unproven');
            }
            ownership = { nonce, operation, pid: child.pid, startToken: observed.startToken, uid };
            await record(onHelper, ownership);
            result = await body(channel);
            await channel.finished();
            const remaining = await listSessionMembers(child.pid);
            if (!Array.isArray(remaining) || remaining.length) throw fail('home projection helper session survived');
        } catch (error) { failure = error; }
        if (failure) {
            let proven = false;
            try {
                proven = await stopHelper(channel, ownership
                    ? { ...own, pid: ownership.pid, startToken: ownership.startToken }
                    : own);
            } catch (_) { proven = false; }
            // Unproven exit: the durable ownership (and any receipt) stays.
            if (!proven) throw exitUnproven(failure);
            try { await record(onHelper, null); } catch (_) { /* Durable recovery reclaims retained ownership. */ }
            throw failure;
        }
        channel.close();
        await record(onHelper, null);
        return result;
    }
    async function receive(channel, phase, fields = []) {
        const message = await channel.next();
        if (!exactKeys(message, ['phase', ...fields]) || message.phase !== phase) throw fail('home projection helper rejected operation');
        return message;
    }
    async function persist(callback, receipt) {
        if (typeof callback !== 'function' || await callback(receipt) !== true) throw fail('home projection journal update failed');
    }
    async function prepare({ target, home, sessionId, onHelper, onIntent, onDirectory, onPrepared, onAttached }) {
        validateInput(target, home, sessionId);
        checkSource(home);
        const proof = await targetProof(target);
        const config = { operation: 'prepare', source: home.absolutePath, sourceIdentity: home.identity, destination: `/run/ploinky-webtty-home-${sessionId}`, ...proof };
        return runHelper('prepare', config, onHelper, async (channel) => {
            let receipt;
            try {
                const hello = await receive(channel, 'identity', ['target']);
                if (!exactKeys(hello.target, ['root', 'mountNamespace', 'userNamespace', 'mountOwner'])) throw fail('invalid helper target');
                receipt = freezeReceipt(validateHomeMountReceipt({ version: 1, stage: 'intent', target: { containerId: target.containerId, ...proof, ...hello.target }, source: { ...home.identity }, destination: { path: `/run/ploinky-webtty-home-${sessionId}` } }));
                await targetProof(target, proof);
                await persist(onIntent, receipt);
                channel.send('create');
                const directory = await receive(channel, 'directory', ['identity']);
                if (!validIdentity(directory.identity)) throw fail('invalid helper directory');
                let next = { ...receipt, stage: 'directory', destination: { ...receipt.destination, ...directory.identity } };
                validateHomeMountReceipt(next, { previous: receipt });
                next = freezeReceipt(next);
                await persist(onDirectory, next);
                receipt = next;
                channel.send('clone');
                const prepared = await receive(channel, 'prepared', ['mountId']);
                next = { ...receipt, stage: 'prepared', mountId: prepared.mountId };
                validateHomeMountReceipt(next, { previous: receipt });
                next = freezeReceipt(next);
                await persist(onPrepared, next);
                receipt = next;
                checkSource(home);
                await targetProof(target, proof);
                channel.send('attach');
                await receive(channel, 'attached');
                next = { ...receipt, stage: 'attached' };
                validateHomeMountReceipt(next, { previous: receipt });
                next = freezeReceipt(next);
                await persist(onAttached, next);
                receipt = next;
                channel.send('finish');
                await receive(channel, 'closed');
                return { home: receipt.destination.path, receipt };
            } catch (error) {
                try { channel.send('abort'); } catch (_) { }
                throw error;
            }
        });
    }
    async function operation(action, { target, receipt, home, onHelper }) {
        validateHomeMountReceipt(receipt);
        if (target.containerId !== receipt.target.containerId) throw fail('target does not match receipt');
        if (action === 'validate') {
            if (receipt.stage !== 'attached') throw fail('home projection is not attached');
            validateInput(target, home, receipt.destination.path.slice('/run/ploinky-webtty-home-'.length));
            checkSource(home);
            if (!isDeepStrictEqual(home.identity, receipt.source)) throw fail('home source does not match receipt');
        }
        await targetProof(target, receipt.target);
        await runHelper(action, { operation: action, receipt }, onHelper, async (channel) => {
            try {
                // The helper checks, unmounts or removes nothing before the
                // durable ownership record authorizes it to proceed.
                const hello = await receive(channel, 'identity', ['target']);
                if (!exactKeys(hello.target, ['root', 'mountNamespace', 'userNamespace', 'mountOwner'])
                    || !['root', 'mountNamespace', 'userNamespace', 'mountOwner']
                        .every((key) => isDeepStrictEqual(hello.target[key], receipt.target[key]))) {
                    throw fail('helper target does not match receipt');
                }
                channel.send('proceed');
                await receive(channel, 'closed');
            } catch (error) {
                try { channel.send('abort'); } catch (_) { }
                throw error;
            }
        });
        if (action === 'validate') checkSource(home);
        await targetProof(target, receipt.target);
        return true;
    }
    // Restart/remove reclamation of a recorded helper without a child handle.
    async function reclaimHelper({ ownership, uid: ownerUid = uid } = {}) {
        validateHomeHelperOwnership(ownership);
        if (ownership.uid !== undefined && ownership.uid !== ownerUid) throw exitUnproven(fail('helper owner changed'));
        const own = { nonce: ownership.nonce, uid: ownerUid,
            ...(ownership.pid ? { pid: ownership.pid, startToken: ownership.startToken } : {}) };
        let proven = false;
        try { proven = await reclaim(own); } catch (error) { throw exitUnproven(error); }
        if (!proven) throw exitUnproven(fail('helper session survived'));
        return true;
    }
    return Object.freeze({
        prepare,
        validate: (args) => operation('validate', args),
        release: (args) => operation('release', args),
        recover: (args) => operation('release', args),
        reclaimHelper,
    });
}
