# Operational Notes

1. Captured runtime instrumentation in `decision_state.py`, `context_assembler.py`, `outer.py`, and `outer_runtime.py`, plus the Workroom/environment state wiring, focus, and bound source metadata required by this plan.
2. Confirmed runtime bootstrap now injects `_build_runtime_context_block`/`_build_runtime_context_message` output into `_node_decide`, so tests such as `tests/agent/test_runtime_prompt_hygiene.py` verify the current turn still supplies `llm_messages` rather than raw fragments.
3. Documented policy/tool metadata changes: the studio runtime now reads guardrail policy, tool traces are surfaced into `environment_state`, and `world_model`/`runtime_snapshot` expose `center_panel_mode`, `active_center_document_id`, and `bound_source_ids`.
4. Testing expectations stay: run `pytest tests/agent/... tests/services/...` plus `py_compile app/agent/assistant_graph/runtime_bootstrap.py tests/agent/test_runtime_prompt_hygiene.py` before landing.
5. Current open issue: stream mode only collected `messages`/`conversation_messages`, so `final_answer_payload` never saw `tool_results` and therefore could not publish citations even though `read_kb_evidence` produced `citation_candidates`, and the frontend flush routine could overwrite the `assistant_final` text. Attempts made:
   - Updated `router.stream` and `router.resume_stream` to accumulate `tool_results` with the streamed messages, then recompute the final payload via `_extract_final_reply` + `_resolve_final_answer_payload`.
   - Added `authoritativeFinalText` handling inside `useAgentChat` so `assistant_final` becomes the final displayed text and prevents later `delta` events from clobbering it.
   - Introduced `backend/tests/agent/test_router_stream_final_answer_payload.py` to ensure stream-only results can still produce `[1]` inline citations.
   Latest action: stream/resume now aggregate `tool_results` before emitting `final_answer_payload`, and the frontend treats `assistant_final` as authoritative. Verification still pending—restart backend and front-end services and replay a real question to confirm inline citations appear.
