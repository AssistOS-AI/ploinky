// Cycle-free retirement for the public no-wait "current run" marker.
//
// Registry writers call this before publishing an identity transition. A
// malformed, foreign, or ambiguously owned marker must stop that transition:
// leaving an old marker visible beside a new registry generation would let a
// read-only observer attach to an identity that never existed.

import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { randomUUID as randomUUIDDefault } from 'node:crypto';

import { RUNNING_DIR } from '../utils/config.js';
import { readVerifiedJsonObject } from '../utils/verifiedReadOnlyFile.js';
import { noWaitCurrentMarkerPath } from './noWaitPaths.js';
import {
  exactNoWaitImmutableIdentity,
  sameNoWaitImmutableIdentity,
} from './noWaitWorkerArgs.js';

export const NO_WAIT_MARKER_BYTE_LIMIT = 256 * 1024;
const RETIREMENT_RECORD_VALIDATION_RUN_ID = '00000000-0000-4000-8000-000000000000';
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function retirementError(message, cause) {
  const error = new Error(message);
  if (cause) error.cause = cause;
  error.code = 'NO_WAIT_MARKER_RETIREMENT_FAILED';
  return error;
}

function exactContainerName(value) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || value.length > 1024
      || !SAFE_CONTAINER_NAME.test(value)) {
    throw retirementError('no-wait marker retirement requires one exact container name');
  }
  return value;
}

function lstatOrAbsent(fsApi, target) {
  try {
    return fsApi.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw retirementError(`no-wait marker path '${target}' could not be inspected`, error);
  }
}

function assertOwnedDirectory(target, stat, uid) {
  if (!stat?.isDirectory() || stat.isSymbolicLink?.()) {
    throw retirementError(`no-wait marker directory '${target}' is not one regular directory`);
  }
  if (Number.isInteger(uid) && stat.uid !== uid) {
    throw retirementError(`no-wait marker directory '${target}' is not owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw retirementError(`no-wait marker directory '${target}' is group- or other-writable`);
  }
}

function assertOwnedMarker(target, stat, uid) {
  if (!stat?.isFile() || stat.isSymbolicLink?.()) {
    throw retirementError(`no-wait marker '${target}' is not one regular file`);
  }
  if (Number.isInteger(uid) && stat.uid !== uid) {
    throw retirementError(`no-wait marker '${target}' is not owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw retirementError(`no-wait marker '${target}' is group- or other-writable`);
  }
}

function sameInode(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function sameExpectedRecord(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return ['type', 'instanceId', 'enableGeneration', 'repoName', 'agentName', 'alias']
    .every((field) => left[field] === right[field]);
}

function exactExpectedRecordIdentity(containerName, expectedRecord, pathApi) {
  if (!expectedRecord || expectedRecord.type !== 'agent') {
    throw retirementError('no-wait marker retirement has no exact prior agent record');
  }
  const alias = expectedRecord.alias === undefined || expectedRecord.alias === null
    ? ''
    : expectedRecord.alias;
  try {
    return exactNoWaitImmutableIdentity({
      containerName,
      instanceId: expectedRecord.instanceId,
      enableGeneration: expectedRecord.enableGeneration,
      repoName: expectedRecord.repoName,
      shortAgent: expectedRecord.agentName,
      alias,
      routeKey: alias || expectedRecord.agentName,
      runId: RETIREMENT_RECORD_VALIDATION_RUN_ID,
      runStartedAtMs: 0,
      waveIndex: 0,
      statusFile: `${containerName}.${RETIREMENT_RECORD_VALIDATION_RUN_ID}.json`,
    }, { pathApi });
  } catch (error) {
    throw retirementError('no-wait marker retirement has an invalid prior registry identity', error);
  }
}

/**
 * Retire one exact container's current marker before its registry identity is
 * replaced or removed. Missing state is an idempotent success. Every present
 * marker is pinned, parsed, and checked against its own immutable identity
 * before a same-directory atomic rename makes it undiscoverable.
 */
export function retireNoWaitRunMarker(containerName, {
  runningDir = RUNNING_DIR,
  expectedRecord,
  fsApi = fsDefault,
  pathApi = pathDefault,
  randomUUID = randomUUIDDefault,
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
} = {}) {
  const exactContainer = exactContainerName(containerName);
  let markerPath;
  try {
    markerPath = noWaitCurrentMarkerPath(exactContainer, { runningDir });
  } catch (error) {
    throw retirementError('no-wait marker retirement requires one exact container name', error);
  }
  const markerDirectory = pathApi.dirname(markerPath);
  const directoryStat = lstatOrAbsent(fsApi, markerDirectory);
  if (!directoryStat) return Object.freeze({ retired: false, containerName: exactContainer, markerPath });
  assertOwnedDirectory(markerDirectory, directoryStat, uid);

  const before = lstatOrAbsent(fsApi, markerPath);
  if (!before) return Object.freeze({ retired: false, containerName: exactContainer, markerPath });
  assertOwnedMarker(markerPath, before, uid);
  const expectedRegistryIdentity = expectedRecord === undefined
    ? null
    : exactExpectedRecordIdentity(exactContainer, expectedRecord, pathApi);

  let marker;
  try {
    marker = readVerifiedJsonObject({
      trustedRoot: runningDir,
      relativeSegments: [pathApi.basename(markerDirectory), pathApi.basename(markerPath)],
      byteLimit: NO_WAIT_MARKER_BYTE_LIMIT,
      fsApi,
      pathApi,
    });
  } catch (error) {
    throw retirementError(`no-wait marker '${markerPath}' could not be verified`, error);
  }
  let identity;
  try {
    identity = exactNoWaitImmutableIdentity(marker, { pathApi });
  } catch (error) {
    throw retirementError(`no-wait marker '${markerPath}' has an invalid immutable identity`, error);
  }
  if (identity.containerName !== exactContainer) {
    throw retirementError(`no-wait marker '${markerPath}' belongs to a different container`);
  }
  if (expectedRegistryIdentity) {
    let expectedIdentity;
    try {
      expectedIdentity = exactNoWaitImmutableIdentity({
        ...identity,
        instanceId: expectedRegistryIdentity.instanceId,
        enableGeneration: expectedRegistryIdentity.enableGeneration,
        repoName: expectedRegistryIdentity.repoName,
        shortAgent: expectedRegistryIdentity.shortAgent,
        alias: expectedRegistryIdentity.alias,
        routeKey: expectedRegistryIdentity.routeKey,
      }, { pathApi });
    } catch (error) {
      throw retirementError(`no-wait marker '${markerPath}' has an invalid prior registry identity`, error);
    }
    if (!sameNoWaitImmutableIdentity(identity, expectedIdentity)) {
      throw retirementError(`no-wait marker '${markerPath}' does not match the exact prior registry identity`);
    }
  }

  const currentDirectory = lstatOrAbsent(fsApi, markerDirectory);
  assertOwnedDirectory(markerDirectory, currentDirectory, uid);
  if (!sameInode(directoryStat, currentDirectory)) {
    throw retirementError(`no-wait marker directory '${markerDirectory}' changed during retirement`);
  }
  const current = lstatOrAbsent(fsApi, markerPath);
  assertOwnedMarker(markerPath, current, uid);
  if (!sameInode(before, current)) {
    throw retirementError(`no-wait marker '${markerPath}' changed during retirement`);
  }

  const retirementId = String(randomUUID());
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(retirementId)) {
    throw retirementError('no-wait marker retirement received no exact unique identifier');
  }
  const retiredPath = pathApi.join(
    markerDirectory,
    `${exactContainer}.current.${retirementId.toLowerCase()}.retired.json`,
  );
  if (lstatOrAbsent(fsApi, retiredPath)) {
    throw retirementError(`no-wait retired marker destination '${retiredPath}' already exists`);
  }
  try {
    fsApi.renameSync(markerPath, retiredPath);
  } catch (error) {
    throw retirementError(`no-wait marker '${markerPath}' could not be retired atomically`, error);
  }

  const retired = lstatOrAbsent(fsApi, retiredPath);
  const retiredDirectory = lstatOrAbsent(fsApi, markerDirectory);
  assertOwnedDirectory(markerDirectory, retiredDirectory, uid);
  assertOwnedMarker(retiredPath, retired, uid);
  if (!sameInode(directoryStat, retiredDirectory)
      || !sameInode(before, retired)
      || lstatOrAbsent(fsApi, markerPath)) {
    throw retirementError(`no-wait marker '${markerPath}' lost exact ownership during retirement`);
  }
  try {
    fsApi.unlinkSync(retiredPath);
  } catch (error) {
    throw retirementError(`retired no-wait marker '${retiredPath}' could not be removed`, error);
  }
  return Object.freeze({ retired: true, containerName: exactContainer, markerPath });
}

/**
 * Deterministically retire a set of exact container markers. Partial success
 * is safe: callers still abort the registry write, and already-retired markers
 * remain idempotently absent on retry.
 */
export function retireNoWaitRunMarkers(containerNames, options = {}) {
  if (!containerNames
      || typeof containerNames === 'string'
      || typeof containerNames[Symbol.iterator] !== 'function') {
    throw retirementError('no-wait marker retirement requires an iterable of container names');
  }
  const expectedRecords = options.expectedRecords;
  const byName = new Map();
  for (const rawEntry of containerNames) {
    const structured = rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry);
    const containerName = exactContainerName(structured ? rawEntry.containerName : rawEntry);
    let expectedRecord = structured
      ? (rawEntry.expectedRecord ?? rawEntry.record)
      : undefined;
    if (expectedRecord === undefined && expectedRecords) {
      expectedRecord = expectedRecords instanceof Map
        ? expectedRecords.get(containerName)
        : (Object.hasOwn(expectedRecords, containerName) ? expectedRecords[containerName] : undefined);
    }
    if (byName.has(containerName) && !sameExpectedRecord(byName.get(containerName), expectedRecord)) {
      throw retirementError(`no-wait marker retirement repeats '${containerName}' with conflicting records`);
    }
    byName.set(containerName, expectedRecord);
  }
  const commonOptions = { ...options };
  delete commonOptions.expectedRecords;
  return Object.freeze([...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([containerName, expectedRecord]) => retireNoWaitRunMarker(containerName, {
      ...commonOptions,
      ...(expectedRecord === undefined ? {} : { expectedRecord }),
    })));
}
