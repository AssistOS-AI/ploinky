import { resolve } from 'node:path';
import { resolveAchillesAgentLib } from './depsLoader.mjs';

const defaultTaskTags = {
  bootstrap: 'project-bootstrap',
  documentation: 'documentation',
  orchestration: 'orchestration',
  specification: 'specification',
  testing: 'testing'
};

const defaultModelTiers = {
  fast: 'llm-fast',
  standard: 'llm-standard',
  premium: 'llm-premium'
};

async function buildRuntimeConfig(options = {}) {
  const env = options.env ?? process.env;
  const manualOverrides = options.manualOverrides ?? {};
  const baseDir = resolve(options.baseDir ?? manualOverrides.baseDir ?? process.cwd());
  const depResolution = await resolveAchillesAgentLib({
    baseDir,
    manualOverrides
  });

  return {
    baseDir,
    dataDir: resolve(baseDir, manualOverrides.dataDir ?? env.ACHILLES_DATA_DIR ?? 'data'),
    sourceDir: resolve(baseDir, 'src'),
    testsDir: resolve(baseDir, 'tests'),
    llm: {
      agentClass: 'LLMAgent',
      apiBaseUrl: manualOverrides.apiBaseUrl ?? env.LLM_API_BASE_URL ?? null,
      provider: manualOverrides.provider ?? env.LLM_PROVIDER ?? 'achilles',
      defaultModel: manualOverrides.defaultModel ?? env.LLM_DEFAULT_MODEL ?? defaultModelTiers.standard,
      taskTags: {
        ...defaultTaskTags,
        ...(manualOverrides.taskTags ?? {})
      },
      modelTiers: {
        ...defaultModelTiers,
        ...(manualOverrides.modelTiers ?? {})
      }
    },
    dependencies: {
      achillesAgentLib: depResolution
    }
  };
}

export { buildRuntimeConfig, defaultModelTiers, defaultTaskTags };
