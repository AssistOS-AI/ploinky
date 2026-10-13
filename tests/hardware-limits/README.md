# Optional Apple measurements

The Explorer `test:local-llm` dispatcher invokes this canonical runner. `apple` selects `mac-model-venus` and functional case `LIVE-L6`. `apple-cpu` selects a separate fresh `mac-model-cpu` workspace and `LIVE-L7`, with GPU access withdrawn before startup. The existing `cpu` profile remains native Linux.

Without `pins.model.measurement`, the functional smoke contract stays unchanged. A measurement is exactly `{schema:1, comparisonId, cohort, scenario, baselineContext}`. The comparison ID is 32 lowercase hexadecimal characters, the cohort is 1 or 2, and the common baseline context is 512, 1024, 2048 or 4096. Omission selects 4096. Preparation freezes this configuration; later actions accept no overrides.

| Scenario | Cases | Inputs |
| --- | --- | --- |
| `baseline-v1` | Functional case and `LIVE-M1` | Small model, one slot, fresh cached-weight load, one reload, one prompt warm-up and three measured prompts |
| `longer-context-v1` | `LIVE-M2` | Small model, context 8192, one slot, warm-up and three prompts |
| `two-slots-v1` | `LIVE-M3` | Small model, baseline context, two concurrent prompts |
| `larger-model-v1` | `LIVE-M4` | Pinned 1.5B model, baseline context, one slot, warm-up and three prompts |
| `load-cancel-v1` | `LIVE-M5` | Stop after received HTTP 503 and before accepted health |
| `generation-cancel-v1` | `LIVE-M6` | Stop after an acknowledged first token; cancellation must have explicit Stop-caused settlement |

Only the baseline runs on both backends. Extra scenarios run on Venus. Every measured Run explicitly selects the frozen context and slot count with `loadMode:'none'`. Refusal does not trigger a changed configuration or a retry. The fixed prompt is `Name one colour.` with at most 64 output tokens.

`liveModelMeasurements.mjs` validates configuration, case receipts and finalized comparisons. Validation requires the canonical run as well as exact indexed artifact bytes. Trials retain monotonic timings, output counts, individual rates, process identity and memory observations. Summaries exclude the labelled warm-up. Missing or contradictory source, model, process, host, trial or Stop evidence fails validation even if its JSON is internally consistent.

Cached weights means verified regular on-disk artifacts. Each Run retains the controller's existing best-effort per-file eviction. The receipt records its counts and says page-cache residency is unverified. A reload replaces the model process in the same agent and preserves the shader-cache location without claiming shader hits.

Generation cancellation requires the authenticated controller Stop notification to win while the observed request is pending. The public record must carry `controller-stop-abort-v1` with ordered first-token, Stop, notification and terminal sequences. The actual routed request must settle with `prompt_cancelled_by_stop`; a controller status alone cannot replace its acknowledgement. Request settlement, idle and runner-group absence share the same 60000 ms budget beginning immediately before Stop dispatch. Transport, parser, control and timeout failures remain non-PASS, including failures that occur after Stop. Completion before interception is not-exercised.

The external adapter freezes an execution manifest before provisioning. After action settlement, independent cleanup, machine restoration and review it writes a separate final evidence index. A comparison needs two complete Venus/CPU pairs with matching host, VM, model, image, source, context and prompt identities. Different backend binaries, flags and resolved threads remain recorded experimental differences. A successful comparison is not a hardware-only speedup claim.

Offline checks use Node's test runner with `--import ./tests/helpers/engineSpawnGuard.mjs` and the canonical `PLOINKY_AGENTLIB_DIR`. They make no hardware claim. Live execution still requires explicit target selection, preflight and sole machine ownership. The suite never creates an A10 completion marker.
