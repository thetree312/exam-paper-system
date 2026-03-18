# ORC Agentic Retrospective Handoff (2026-03-10)

## Purpose
This document records:
- What the latest real tests show about current agent behavior.
- What recent 2025-2026 industry guidance suggests for agentic agent design.
- How the recent implementation drifted away from that direction and caused ORC behavior regression and file bloat.

It is intended as a reset point for future work. It is not a feature spec.

## Current Test-Based Behavior Summary
Based on the latest real traces in:
- `d:\Exam-paper\agent思考.txt`
- `d:\Exam-paper\新建文本文档.txt`

Observed behavior:

1. The agent still does not reliably start from world relations.
It still tends to form an early "find a tool / find an index / find the content" goal rather than naturally grounding on:
- current workspace is empty
- a `source_file` exists in KB
- the user is asking about evidence likely inside that source

2. The agent often treats visible environment facts as narration, not as action constraints.
It can say things like:
- current focus domain is KB
- workspace has no expanded questions
but then still choose workspace-first actions.

3. The tool loop has repeatedly shown behavior regression introduced by recent implementation changes.
Examples seen in recent traces:
- repeated "reboot-like" reasoning turns
- repeated `read_workspace_index` attempts after zero-result observations
- empty ORC payload / invalid parameter failures caused by message-chain handling

4. Input token pressure improved compared with earlier 10K+ spikes, but is still too high.
The remaining weight now comes mainly from:
- repeated action-contract system prompts
- repeated function schemas
- repeated subcalls inside the same tool loop
- image payloads when visual evidence is injected

## Main Problems Still Unresolved
The original problem axis has not changed:

1. Agent behavior
- The agent is still not naturally acting from environment relations.
- It still drifts toward "ability gap / tool lookup" behavior.

2. World understanding
- The agent still often fails to treat environment structure as the basis for action.
- It describes world facts but does not consistently let them constrain action choice.

3. Input growth
- The system still sends too much repeated control/context/tool material during multi-step tool interaction.

## What Recent Industry Guidance Actually Suggests
Recent 2025-2026 public guidance from major companies points in a different direction than the current ORC design.

### Shared design direction
1. Stateful runtime over stateless prompt reassembly
- Runtime should hold working state across steps.
- The model should not repeatedly receive full reconstructed control context.

2. Observation-first, not control-panel-first
- The model should see the current environment and incremental changes.
- It should not be driven by backend state labels or orchestration hints.

3. Automatic context editing
- Old tool calls, stale results, and no-longer-relevant context should be removed automatically.
- This is not "compress a few words"; it is runtime-level context management.

4. Tool results should be high-signal observations
- Tool output shown to the model should be minimal and environment-relevant.
- Long explanations, tool-manual text, and low-level technical payloads should stay out of the active context.

### Reference sources
- OpenAI, "Introducing the Stateful Runtime Environment for Agents in Amazon Bedrock" (2026-02-27)
  - https://openai.com/index/introducing-the-stateful-runtime-environment-for-agents-in-amazon-bedrock/
- Google DeepMind, "Interactions API: A unified foundation for models and agents" (2025-12-11)
  - https://blog.google/technology/developers/interactions-api/
- Anthropic, "Managing context on the Claude Developer Platform" (2025-09-29)
  - https://www.anthropic.com/news/context-management
- Anthropic, "Writing effective tools for agents" (2025)
  - https://www.anthropic.com/engineering/writing-tools-for-agents
- Google DeepMind, Project Mariner
  - https://deepmind.google/models/project-mariner/

## How Implementation Drifted Away From The Goal
Recent implementation drift did not move ORC toward a cleaner agentic runtime. It instead layered more engineering control inside `orc_loop.py`.

### Drift pattern 1: Prompt-over-prompt control
`orc_loop.py` accumulated:
- one outer ORC prompt
- one tool-loop prompt
- repeated action contracts
- repeated "what tool_search should do" guidance

This pushed ORC toward "dispatcher/planner" behavior, not environment-first agent behavior.

### Drift pattern 2: Engineering narration instead of environment
I repeatedly translated runtime/tool state into model-visible explanatory language, such as:
- tool discovery summaries
- tool loading summaries
- path stall labels
- hand-authored observation phrasing

This created a pseudo-environment shaped by engineering interpretation, not a clean environment the model could act within.

### Drift pattern 3: Context editing turned into behavior shaping
Instead of only removing stale context, I started using:
- active tool view restriction
- current intent shaping
- message pruning heuristics

These changes did not just reduce context. They began shaping the agent's path and sometimes locked it into the wrong path.

### Drift pattern 4: ORC file bloat from stacked control logic
`backend/app/assistant_graph/nodes/orc_loop.py` grew to around 1400 lines because I kept adding:
- prompt logic
- observation formatting
- tool protocol handling
- JSON contract enforcement
- message compaction
- fallback and coercion logic

This growth is not a sign of "more agentic sophistication". It is a sign of engineering control and mixed responsibilities accumulating in one place.

## Concrete Mistakes In My Implementation
These are the main mistakes I made during implementation:

1. I kept trying to improve behavior by adding control logic instead of removing distortion.
2. I repeatedly slid back into workflow thinking:
   - first-step shaping
   - action contracts
   - explicit control of tool usage
3. I treated prompt and orchestration tweaks as a substitute for a cleaner runtime/environment boundary.
4. I let `orc_loop.py` absorb responsibilities that should not have been added as model-control code at all.
5. I mistook some regressions as "deeper root causes" instead of recognizing them as bugs introduced by my own changes.

## Current Working Conclusion
Future work should treat the current situation this way:

1. The main problem axis is unchanged:
- agent behavior
- world grounding
- input control

2. Recent regressions are real regressions introduced by implementation drift.
They should not be reframed as "natural exposure of deeper structure."

3. The path forward is not:
- more prompt layers
- more action contracts
- more runtime narration
- more behavior-shaping heuristics

4. The path forward is:
- reduce model-visible control scaffolding
- keep runtime state in runtime
- expose only environment observations and real tool results needed for the next step
- apply context editing as context editing, not as hidden workflow control

## Immediate Guidance For Whoever Continues This Work
Use this as the guardrail:

- If a change adds more model-visible control logic, it is probably wrong.
- If a change makes ORC more like a planner/dispatcher, it is probably wrong.
- If a change reduces distortion between runtime state and model-visible environment, it is probably in the right direction.
- If a change reduces repeated control text, repeated schemas, or repeated stale tool history without shaping behavior, it is probably in the right direction.

Do not continue by adding more control code to `orc_loop.py`.
