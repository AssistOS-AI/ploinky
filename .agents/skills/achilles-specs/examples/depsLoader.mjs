import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const achillesPackageCandidates = [
  'AchillesAgentLib/package.json',
  '@achilles/agent-lib/package.json'
];

async function pathExists(candidatePath) {
  try {
    await access(candidatePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveFromParent(baseDir) {
  const parentDir = resolve(baseDir, '..');
  const directCandidates = [
    resolve(parentDir, 'AchillesAgentLib', 'package.json'),
    resolve(parentDir, 'AchillesAgentLib'),
    resolve(parentDir, '@achilles', 'agent-lib', 'package.json'),
    resolve(parentDir, '@achilles', 'agent-lib')
  ];

  for (const candidate of directCandidates) {
    if (await pathExists(candidate)) {
      return {
        strategy: 'parent-directory',
        path: candidate
      };
    }
  }

  return null;
}

function resolveFromNodeModules(baseDir) {
  const localRequire = createRequire(resolve(baseDir, 'package.json'));

  for (const candidate of achillesPackageCandidates) {
    try {
      return {
        strategy: 'node_modules',
        path: localRequire.resolve(candidate)
      };
    } catch {
      // Continue through the fallback list.
    }
  }

  return null;
}

async function resolveAchillesAgentLib(options = {}) {
  const baseDir = resolve(options.baseDir ?? process.cwd());
  const manualOverrides = options.manualOverrides ?? {};
  const manualPath =
    options.overridePath ??
    manualOverrides.achillesAgentLibPath ??
    process.env.ACHILLES_AGENT_LIB_PATH;

  if (manualPath) {
    return {
      strategy: 'manual-override',
      path: resolve(baseDir, manualPath)
    };
  }

  const parentResolution = await resolveFromParent(baseDir);
  if (parentResolution) {
    return parentResolution;
  }

  const nodeModulesResolution = resolveFromNodeModules(baseDir);
  if (nodeModulesResolution) {
    return nodeModulesResolution;
  }

  throw new Error(
    'Could not resolve AchillesAgentLib. Provide ACHILLES_AGENT_LIB_PATH, use manualOverrides.achillesAgentLibPath, or install the package in node_modules.'
  );
}

export { resolveAchillesAgentLib };
