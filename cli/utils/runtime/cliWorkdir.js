import fs from 'node:fs';
import path from 'node:path';

import { PLOINKY_WORKSPACE_ROOT } from '../config.js';

export function cliWorkdirError(message, code = 'PLOINKY_WORKDIR_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

export function resolveCliWorkdir(value, {
  workspaceRoot = PLOINKY_WORKSPACE_ROOT,
  fsImpl = fs,
} = {}) {
  const raw = String(value ?? '');
  if (!raw || raw.includes('\0')) {
    throw cliWorkdirError('cli --workdir requires a non-empty path');
  }
  const rawSegments = raw.split('/');
  if (rawSegments.includes('..')) {
    throw cliWorkdirError('cli --workdir does not permit traversal segments');
  }

  let relative;
  if (path.posix.isAbsolute(raw)) {
    const trimmedAbsolute = raw.replace(/\/+$/, '') || '/';
    if (trimmedAbsolute === '/workspace') {
      throw cliWorkdirError(
        'cli --workdir cannot select the workspace root',
        'PLOINKY_WORKDIR_ROOT_FORBIDDEN',
      );
    }
    if (!raw.startsWith('/workspace/')) {
      throw cliWorkdirError('cli --workdir absolute paths must remain below /workspace');
    }
    relative = raw.slice('/workspace/'.length);
  } else {
    relative = raw;
  }

  const normalized = path.posix.normalize(relative);
  if (!normalized || normalized === '.') {
    throw cliWorkdirError(
      'cli --workdir cannot select the workspace root',
      'PLOINKY_WORKDIR_ROOT_FORBIDDEN',
    );
  }
  const segments = normalized.split('/');
  const protectedPath = segments[0] === '.data'
    || (segments[0] === '.ploinky'
      && !(segments[1] === 'repos' && typeof segments[2] === 'string' && segments[2].length > 0));
  if (protectedPath) {
    throw cliWorkdirError('cli --workdir selects protected Ploinky state');
  }

  let rootStat;
  try {
    rootStat = fsImpl.lstatSync(workspaceRoot);
  } catch {
    throw cliWorkdirError('Ploinky workspace root is unavailable');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw cliWorkdirError('Ploinky workspace root must be a real directory');
  }
  let canonicalRoot;
  try {
    canonicalRoot = fsImpl.realpathSync(workspaceRoot);
  } catch {
    throw cliWorkdirError('Ploinky workspace root is unavailable');
  }
  const lexicalCandidate = path.resolve(canonicalRoot, ...segments);
  if (lexicalCandidate === canonicalRoot) {
    throw cliWorkdirError(
      'cli --workdir cannot select the workspace root',
      'PLOINKY_WORKDIR_ROOT_FORBIDDEN',
    );
  }
  if (!lexicalCandidate.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw cliWorkdirError('cli --workdir escapes the workspace');
  }

  let cursor = canonicalRoot;
  try {
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      const stat = fsImpl.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw cliWorkdirError('cli --workdir must name an existing real directory');
      }
    }
    const canonicalPath = fsImpl.realpathSync(lexicalCandidate);
    if (!canonicalPath.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw cliWorkdirError('cli --workdir escapes the workspace');
    }
    const relativePath = path.relative(canonicalRoot, canonicalPath).split(path.sep).join('/');
    return Object.freeze({
      canonicalPath,
      canonicalRoot,
      relativePath,
      runtimePath: `/workspace/${relativePath}`,
    });
  } catch (error) {
    if (error?.code?.startsWith?.('PLOINKY_')) throw error;
    throw cliWorkdirError('cli --workdir must name an existing real directory');
  }
}

export function validateCliWorkdir(value, options = {}) {
  return resolveCliWorkdir(value, options).canonicalPath;
}

export function normalizeCliWorkdirForRuntime(value) {
  const raw = String(value || '');
  if (raw.startsWith('/workspace/')) return raw;
  return `/workspace/${raw}`;
}
