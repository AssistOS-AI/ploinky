# Optional AMD APU cases

These optional Linux cohorts require an explicitly selected host, immutable source and image pins, a private fresh workspace, and separate authorization for provision, live and cleanup. Preparing a manifest performs no engine or SSH operation. AMD support remains experimental and unqualified.

| Profile | Block | Ordered cases |
| --- | --- | --- |
| `amd-apu` | `linux-model-amd-apu` | `LIVE-L13` functional inference, `LIVE-L9` admission refusal, `LIVE-L11` tensor-load cancellation, `LIVE-L12` generation cancellation |
| `amd-apu-pressure` | `linux-model-amd-apu-pressure` | `LIVE-L10` runtime guard |
| `amd-apu-cpu` | `linux-model-amd-apu-cpu` | `LIVE-L8` CPU comparison |

`LIVE-L7` remains the Apple CPU case. The APU blocks do not accept it as an alias for `LIVE-L13`.

The model pins include `amd.pci`, the exact 0666-compatible `amd.render` character node, `amd.host` with kernel, `ID VERSION_ID` OS identity, MemTotal, idle MemAvailable and owner-supplied UMA label, `amd.memory` VRAM/GTT totals, `amd.vulkan` identity and heaps, and `amd.devices` with the Vulkan0 name, total and free bytes. These facts are reobserved on the selected host and inside its agent. NVIDIA UUIDs and Apple machine pins are refused. GPU cohorts require exactly one amdgpu render node, Box devices `/dev/fuse`, `/dev/net/tun` and that node, plus the agent's single `ploinky.local/gpu=all` CDI argument. The CPU cohort withdraws GPU access before startup and proves device absence.

The reviewed entry proof selects manifest-default delivery. Preparation rewrites only the immutable image and the declared APU environment defaults. GPU cohorts set `LOCAL_LLM_AMD_APU=experimental`; only pressure sets `LOCAL_LLM_APU_GUARD_FLOOR_BYTES`, exactly pinned MemTotal plus 1 GiB. Preparation and provisioning share the safe-integer, strictly-greater predicate. Source checks allow only this exact rewrite, and the running agent reports matched or unexpected values without dumping its environment.

L9 derives a refusal from the frozen CPU-eligible GGUF catalog and the production C1/C2 arithmetic. It searches contexts 512 through 131072 and slots 1 through 4, choosing by ascending weight size, model ID, context and slots. The manifest retains every sizing input and the selected status/constraint; source validation recomputes the derivation against the frozen catalog. If nothing is refusable, the outcome is `not-exercised`. Its zero-byte certificate uses `controller-acquisition-no-entry/v1`: unchanged model-job, runner-install and lookup lifetime counts, zero active counts, ordered observations from one controller, and independent process absence. These are exhaustive acquisition-entry observations, not a network byte meter.

The Linux guard samples MemAvailable, swap and full PSI every two seconds, with at most 1800 samples. It blocks below max(2 GiB, 10% MemTotal), at full PSI 10 or above, on swap growth over 1 GiB, or on unreadable observations. GPU cohorts also retain a stable 60-second AMD baseline and require a five-second busy median at most 10%. Unexplained VRAM plus GTT growth above logged buffers, overhead and 512 MiB blocks execution. Provision, live and cleanup retain their own guard evidence.

L11 requires the current runner's real tensor marker while starting, independently observed process identity, contiguous sequence coverage from `logSeqStart` through idle, and a settled routed Stop with group absence. Only event kinds and sequences are retained. Missing observations, stale launches, source or transport loss, gaps and exhausted bounds remain nonpassing; an observed ready race is `not-exercised`. A stopping phase is optional. L12 deliberately returns `pending` with `server-generation-observation-unavailable` because reviewed APU generation/request binding is missing. Synthetic positive L12 validator tests are not runtime evidence.

Every declared case produces a receipt and preserves its actual outcome. Remote certification retrieves all receipts, checks report/outcome/digest bindings, and applies each case's semantic requirements. An invalid final case cannot hide behind a valid first case. Separate cleanup may pass while live remains pending or not-exercised; cleanup never upgrades the live result. Only a bound provision/cleanup history with no live intent can omit case receipts.

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
