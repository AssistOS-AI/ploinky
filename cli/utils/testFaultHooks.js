import fs from 'fs';
import path from 'path';

import { PLOINKY_DIR } from './config.js';

// Test-only fault hook for the targeted `ploinky restart` path. It can only
// force the existing coordinated-merge fallbacks and delay that merge's
// completion; it never changes routing content, rollback, or lease handling.
//
// Activation needs an explicit opt-in that exists only in a workspace where a
// test deliberately created it. A host process reaches the in-Box
// `ploinky-local` through `container exec` with a fixed environment, so an
// environment variable does not cross that boundary; the workspace file does.
//
//   <workspace>/.ploinky/test-faults/restart.json     (default location)
//   PLOINKY_TEST_FAULT_HOOKS=<absolute path>          (optional override, same directory only)
//
// The file must carry `"activation": "ploinky-test-fault-hooks-v1"`. A file
// that is merely present stays inert. Everything else fails closed: any
// problem returns no hook, so the unmodified behaviour runs.
//
// Scope: the hook affects every targeted restart, including the hardware Apply
// reconcile (cli/sandbox/hardwareLimits/reconcile.mjs) and the MPS cohort drain
// (cli/sandbox/hardwareLimits/mpsLifecycle.mjs), not only `ploinky restart`.
//
// Harness rule: `holdInactiveMs` keeps the routing lock held and the edge
// selector inactive for the whole hold. To abort a held restart, remove the hook
// file (or its activation marker); the hold re-checks it every
// HOLD_SLICE_MS and ends early. Never kill a restart during the hold: the
// routing lock has no dead-owner reclaim and would stay stuck.

export const TEST_FAULT_HOOKS_ENV = 'PLOINKY_TEST_FAULT_HOOKS';
export const TEST_FAULT_HOOKS_DIRNAME = 'test-faults';
export const TEST_FAULT_HOOKS_DEFAULT_FILE = 'restart.json';
export const TEST_FAULT_HOOKS_ACTIVATION = 'ploinky-test-fault-hooks-v1';
export const MAX_HOLD_INACTIVE_MS = 600000;
export const HOLD_SLICE_MS = 250;
const MAX_FILE_BYTES = 4096;
const ALLOWED_KEYS = new Set([
  'activation',
  'forceUnprovableWithdrawal',
  'forceUnprovableReopen',
  'holdInactiveMs',
]);

function inert(reason, { explicit, warn }) {
  // Only an operator who set the variable expects a hook; stay silent otherwise.
  if (explicit) warn(`[test-fault-hook] ${TEST_FAULT_HOOKS_ENV} ignored (inert): ${reason}`);
  return null;
}

function trustedOwner(stat, uids) {
  return uids.includes(stat.uid);
}

/**
 * Read the restart fault hook. Returns null (inert) unless an explicit,
 * trusted, well-formed test setting is present; otherwise returns
 * { forceUnprovableWithdrawal, forceUnprovableReopen, holdInactiveMs }.
 */
export function loadRestartFaultHooks(options = {}) {
  const read = readRestartFaultHooks(options);
  if (!read) return null;
  // Re-evaluates the same rules silently; false once the file is gone or deactivated.
  return Object.freeze(Object.defineProperty({ ...read }, 'stillActive', {
    value: () => readRestartFaultHooks({ ...options, warn: () => {} }) !== null,
    enumerable: false,
  }));
}

function readRestartFaultHooks({
  env = process.env,
  ploinkyDir = PLOINKY_DIR,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  warn = (line) => console.warn(line),
} = {}) {
  const requested = typeof env?.[TEST_FAULT_HOOKS_ENV] === 'string' ? env[TEST_FAULT_HOOKS_ENV].trim() : '';
  const explicit = requested !== '';
  const hooksDir = path.join(ploinkyDir, TEST_FAULT_HOOKS_DIRNAME);
  const file = explicit ? requested : path.join(hooksDir, TEST_FAULT_HOOKS_DEFAULT_FILE);
  const ctx = { explicit, warn };

  try {
    if (explicit && !path.isAbsolute(file)) return inert('path is not absolute', ctx);
    let fileStat;
    try {
      fileStat = fs.lstatSync(file);
    } catch (error) {
      if (error?.code === 'ENOENT' && !explicit) return null;
      return inert(`cannot stat the hook file (${error?.code || 'error'})`, ctx);
    }
    // Resolve before comparing so `..` segments and symlinked parents cannot escape the directory.
    const realDir = fs.realpathSync(hooksDir);
    const realFile = fs.realpathSync(file);
    if (path.dirname(realFile) !== realDir) return inert(`path is outside ${hooksDir}`, ctx);
    if (!fileStat.isFile()) return inert('hook path is not a regular file (symlinks are refused)', ctx);
    if (fileStat.size > MAX_FILE_BYTES) return inert('hook file is too large', ctx);

    const dirStat = fs.lstatSync(hooksDir);
    if (!dirStat.isDirectory()) return inert('hook directory is not a directory', ctx);
    // The invoking user, or the principal that owns the workspace state directory (uid mapping inside the Box).
    const owners = [uid];
    try { owners.push(fs.statSync(ploinkyDir).uid); } catch (_) {}
    if (!trustedOwner(fileStat, owners) || !trustedOwner(dirStat, owners)) {
      return inert('hook file or directory is not owned by the invoking user', ctx);
    }
    if ((fileStat.mode & 0o022) !== 0 || (dirStat.mode & 0o022) !== 0) {
      return inert('hook file or directory is group/world writable', ctx);
    }

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return inert('hook file is not a JSON object', ctx);
    // Present-but-unmarked is the normal inert state; say nothing unless the variable pointed here.
    if (parsed.activation !== TEST_FAULT_HOOKS_ACTIVATION) return inert('activation marker missing', ctx);
    for (const key of Object.keys(parsed)) {
      if (!ALLOWED_KEYS.has(key)) return inert(`unknown key '${key}'`, ctx);
    }
    for (const key of ['forceUnprovableWithdrawal', 'forceUnprovableReopen']) {
      if (key in parsed && typeof parsed[key] !== 'boolean') return inert(`${key} must be a boolean`, ctx);
    }
    const hold = parsed.holdInactiveMs ?? 0;
    if (!Number.isInteger(hold) || hold < 0 || hold > MAX_HOLD_INACTIVE_MS) {
      return inert(`holdInactiveMs must be an integer in 0..${MAX_HOLD_INACTIVE_MS}`, ctx);
    }
    const hooks = Object.freeze({
      forceUnprovableWithdrawal: parsed.forceUnprovableWithdrawal === true,
      forceUnprovableReopen: parsed.forceUnprovableReopen === true,
      holdInactiveMs: hold,
    });
    if (!hooks.forceUnprovableWithdrawal && !hooks.forceUnprovableReopen && hooks.holdInactiveMs === 0) return null;
    warn(`[test-fault-hook] ACTIVE test-only restart fault hook from ${file}: forceUnprovableWithdrawal=${hooks.forceUnprovableWithdrawal} forceUnprovableReopen=${hooks.forceUnprovableReopen} holdInactiveMs=${hooks.holdInactiveMs}`);
    return hooks;
  } catch (error) {
    return inert(`unreadable (${error?.code || error?.message || 'error'})`, ctx);
  }
}
