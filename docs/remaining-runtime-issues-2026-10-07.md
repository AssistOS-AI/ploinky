# Explorer runtime handoff, 7 October 2026

The repository-install recovery defect is fixed and pushed to `integration/explorer-preview`. The single final Copilot test failed: startup succeeded, but an OpenCode HTTP timeout prevented the requested reply. This report distinguishes current verification from unresolved historical findings; an old failure is not evidence of a regression in this candidate.

## Candidate and repaired failure

| Repository | Deployed preview commit |
| --- | --- |
| Ploinky | `4eaeacbfb39942b58945de9f3557db9271271120` |
| AssistOSExplorer | `cb2ebc1eceddbba2e0c8633f8131a851ed66ba25` |
| AchillesCLI | `9a8832812adc26923dc9fa32e01dbab376230b99` |
| proxies | `dc3c5be1a161b7f86c4e059a3419f14e01ffa09b` |
| local-llms | `bcf576fcab15fc87f5b96d8c3fb0e78c0f05ffd7` |

Shared AchillesAgentLib is pinned to `ef515b2d88a817eea60d1a3a6d3dc6c5f406bfca`. Repositories without the preview branch use their remote default branch. The browser release verifier records the participating source identities.

The old supervisor retained claims about short-lived Git processes after they exited. When the Router could no longer find a claimed process, it refused to settle the repository operation and latched workspace recovery. That blocked RoboTeam activation and LiveKit creation, explaining the observed Copilot startup/HTTP 503 and WebMeet signaling failures. A representative real clone reproduced `claim-unresolved` with a complete process census in 138 ms of a 999 ms budget. The original historical operation did not retain enough evidence to identify its exact process; the later controlled reproduction established the race.

Commit `8d72b5d2` adds precise refusal diagnostics. Commit `4eaeacbf` contains repository installation in an unprivileged user/PID namespace. The Router verifies ownership and retains the mutation lease until the namespace and protocol are fully closed. Detached children remain visible to the lifetime check. Cancellation stays bounded. Uninstall supervision and existing recovery safeguards remain unchanged.

| Check | Actual result and scope |
| --- | --- |
| Scoped unit suites | 163 passed, zero failures, skips or cancellations through the fresh-export helper. Exact command and TAP retained; some historical environment identities were not captured. |
| Native Linux integration | Four passed on the immutable Box image with UID 1000, an init/reaper, read-only source and isolated temporary storage. The same intended-success clone test fails against baseline `8d72b5d2` with `claim-unresolved`. |
| Independent review and runtime probes | Source approved. Identity forgery, foreign-process safety, surviving nested children, cancellation, safe bootstrap, late protocol frames and read-only mounts verified. |
| Real repository operation | The representative clone through RoboTeam completed in 2,524 ms, registered successfully and left no recovery lock on the earlier repaired deployment. This is separate from final browser evidence. |
| Fresh branch deployment | Created with `ploinky start explorer --branch integration/explorer-preview` in the dedicated local fixture. Required agents became ready and all ten background agents reached `running`. |
| Final Copilot browser test | One intended Chromium test failed in 451.9 seconds; zero skips and zero retries. Source/release preflight passed. The required reply token was absent. |

Earlier failed probes remain in the evidence. One omitted an init/reaper, one incorrectly demanded EROFS instead of accepting independently proven read-only denial with EACCES, and an early fixture did not reproduce the race. None counts as a pass. The corrected probes changed the apparatus or strengthened evidence; product assertions were not weakened.

## Final deployment and current limitations

The selected local fixture is `~/work/testExplorerFresh`. The final Box is `681199d963f532b3c1c94f7c005c0760a55ef0a85403888dbbd75d9daa9ed30f`, started at `2026-10-07T22:49:54.616104022+03:00`, with immutable local image ID `sha256:535c281eca0b6a3cdfa231c1840f1e3f144ad2f24f05662f6afa7778b44bc52b`. The Ploinky source mount is read-only and matches the clean checkout used by the verifier. Router TCP remains loopback-only; LiveKit UDP is the only other published surface. Privileged mode is off.

During account setup, a command omitted the pinned image-reference environment variable and recreated the Box using `:latest`. Its image content matched the expected immutable ID. Explorer was started again through the canonical branch command, and Box/source identity and graph readiness were captured again before the final test. This recreation is part of the evidence and must not be presented as an untouched initial generation.

UserPersisto defaults its Google callback to `localhost:8080`, which also redirects password sign-ins away from a browser configured for `127.0.0.1:8080`. Explicitly setting both `USERPERSISTO_GOOGLE_CLIENT_ID` and `USERPERSISTO_GOOGLE_REDIRECT_URI` through `ploinky var` aligned the local callback. Administrator sign-in then passed the existing origin and identity checks. This is deployment configuration, not a source fix. Future fresh fixtures need equivalent configuration or a consistently chosen supported origin.

| Remaining item | Status and next evidence needed |
| --- | --- |
| Copilot completion | The final test screenshot shows the agent online and the prompt submitted, followed by `ALA execution failed (5)` and `OpenCode HTTP request timed out.` The selected model is `opencode/big-pickle`. The underlying OpenCode/backend timeout is not isolated. This is distinct from the repaired startup/recovery failure. |
| WebMeet signaling, chat and media | LiveKit and WebMeet report running. The final two-account room/chat/ICE/RTP browser gate was not run under the user's one-final-Copilot stopping scope. Backend readiness does not prove the reported room error is fully resolved. |
| OnlyOffice | The confidential document save/callback/drain/restart/reopen browser gate remains unrun. Historical activation proves setup only. |
| WebChat Tasks control | Current source and the final test screenshot have no Tasks header button. It retains the hidden task dialog and task-message support. The earlier visible button came from the older deployment; this session did not remove the remaining task subsystem. |
| Command-catalog/startup robustness | Historical repeated requests were observed while startup was blocked. Static inspection also identified bounded retry cycles without an overall fetch deadline and potentially overlapping refreshes. Those paths were not changed or independently accepted here. |
| Copilot failure classification | The UI displayed `ALA execution failed` / `OpenCode HTTP request timed out`, but the terminal diagnostic recorded `firstTerminalError: null` and `replyOutcome: waiting`. The early-error matcher missed this failure wording; the test correctly failed on the missing reply after the full deadline. |
| Uninstall recovery | The fix covers repository installation. The older uninstall process-supervision path is unchanged; no claim of a general recovery redesign is made. |

## Historical work still open

These items come from the earlier remediation checkpoint and handoff. They were not rerun on the final candidate. The new containment evidence addresses the reproduced short-lived-child race; it does not retrospectively identify every older refusal.

| Historical finding or coverage gap | Remaining uncertainty |
| --- | --- |
| Process-environment EACCES | An older install failed after 11.362 seconds; the process identity and precise cause remain unknown. Its controlled reproduction was inconclusive. |
| Unstable-argv recovery refusal | An isolated measurement recorded 13 HTTP 200 and five recovery HTTP 503 responses. The first unstable-argv process transition remains unidentified. |
| Full RoboTeam suite | Earlier result: 185 passed, 58 failed, one cancelled. No complete baseline comparison exists, so the failures cannot all be called inherited or regressions. |
| Paired bootstrap assertion | Baseline and candidate each had eight passes and one failure: the GUI-image/tool-cache manifest test expected no environment list but found four `ROBOTEAM_*_VERSION` names. This paired failure is inherited. |
| Strict Ploinky timing | A full candidate inventory test measured 5.459967 ms against a strict `<5 ms` assertion. Isolated timing passes do not erase that failure. No final broad-suite or CI pass is established. |
| Skipped coverage | Fifty historical Ploinky skips and four Explorer skips remain unverified. The Explorer skips cover recursive graphs, sibling revisions and inherited `GIT_DIR` isolation. |
| Browser matrix | Twenty-four other local identities and nineteen separate profiles remain: delegation/live skills (2), native Codex (1), external-network matrix (1), QA (2), hardware administration/API (6), Playground (3), fixture graphs (4). Dedicated account, service and resource prerequisites remain. |
| Runtime and feature probes | Complete MCP operations, routed authenticated operations, a writable inner-container child and fourteen formerly blocked feature paths remain unrun. Basic health probes are narrower evidence. |
| Generation schedule | The complete official sequence has not been proven within the unchanged 30-minute generation limit. A single current test cannot close that scheduling gate. |
| Suite guard apparatus | Raw guard collection assumed the wrong owner PID. Broader reviewed wiring for independent file and nested-operation ledgers remains unfinished. |
| Performance and isolation matrix | N200 paired measurements, later chunks, seven measurement controls, full E7 transaction/namespace acceptance and both production Box layouts remain incomplete. |
| Separate operational claims | Live SSO-disable, STOP-1/M3, combined Router/browser timing and a historical CP2 HTTP 502 remain unverified. A macOS Bash 3 size helper also failed on `declare -A`. |
| Inactive work | A6, A7 and full same-run C.7; fifty directory calls and latency/Router/fork criteria; tasks/git migration and gitAgent security review remain open. |

Earlier installer/image and tmpfs findings were recorded as repaired and are not listed as outstanding defects. The prior 7.5-minute Copilot attempt with no reply is preserved in historical evidence; the final attempt below governs the current browser status.

## Evidence and preservation

Local evidence is under `~/.codex/coordination/explorer-runtime-fix-20261007_codex`. Key records are `containment_commit_codex.json`, `containment_r4_author_unit_command_environment_codex.json`, `native_r4_command_codex.json`, `native_baseline_r4_command_codex.json`, `independent_verification_codex/verification_report_codex.md`, `live_fixed_repository_codex.json`, `final_configured_box_codex.json`, `final_graph_readiness_codex.json`, `final_copilot_observation_codex.json`, `final_copilot_timeout_codex.jpeg`, and the `runtime-final-copilot-1791402820264_codex` artifacts. Failed preflight and setup attempts are retained separately and are not browser passes.

Historical evidence is under `~/.codex/coordination/explorer-remediation-20261007_codex` and `EXPLORER_DEPLOYMENT_REMEDIATION_HANDOFF_2026-10-07_codex.md` in the workspace root. Relevant records include `checkpoint_codex.json`, `bootstrap_baseline_codex.tap`, `bootstrap_candidate_codex.tap`, `roboteam_suite_v6_candidate_codex.tap`, `skipped_cases_codex.json`, `acceptance_status_codex.json`, `suite_guard_blocker_codex.md` and `ci_observation_codex.json`.

Previous deployments were stopped and removed through the supported lifecycle. Their data was archived outside the new fixture, including the diagnostic repository aliases; it was not carried into the fresh workspace. No old deployment container remains. The user's staged Explorer extraction plan and unrelated local files were preserved. Credentials are held privately and are excluded from this report and commits.

The final command was `node scripts/run-playwright.mjs --project=chromium --workers=1 --retries=0 --grep "opens a working Copilot from a newly created folder" specs/05-copilot-folder-launch.spec.mjs`, run from the clean Explorer smoke checkout with the exact release manifest and private account environment. It exited 1 at `2026-10-07T20:01:17.063Z`. Its test folder was removed by cleanup; traces, screenshots and the failure ledger were retained.

The user requested one final Copilot attempt followed by documentation and a stop. No additional tests or source fixes were attempted after this result. The running deployment remains available for inspection. The report commit only adds documentation; runtime evidence applies to the source revisions recorded above.
