// The names of the local-llm fixture, apart from its commands and programs so that
// the fixture, the harness and the cases can each import them without a cycle.
export const LLM_REPOSITORY = 'local-llms';
export const LLM_AGENT = 'local-llm';
export const LLM_REF = `${LLM_REPOSITORY}/${LLM_AGENT}`;
// Where the frozen candidate payload carries the local-llm tree, beside the Ploinky candidate.
export const LLM_SOURCE_DIRECTORY = '.hwl-local-llms';
export const LLM_MODELS = Object.freeze({ small: 'qwen2.5-0.5b-instruct-q4_k_m', awq: 'qwen3-4b-awq' });
// The install throughput evidence keeps the first and the newest download samples (a 3.5 h cap at the 15 s poll is about 840 samples).
export const INSTALL_SAMPLES_HEAD = 300;
export const INSTALL_SAMPLES_TAIL = 300;
