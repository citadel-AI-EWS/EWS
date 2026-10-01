# Agent Engineering Research Track — 2026-09-29

Purpose: turn current literature on AI agents, LLM systems, RAG, reliability, and distributed systems into concrete engineering improvements for CITADEL EWS.

This document is a synthesis of public publisher descriptions, tables of contents, companion repositories, and public excerpts. It does not reproduce copyrighted book text.

## Curated research corpus

### Agent architecture and multi-agent systems
1. Micheal Lanham — *AI Agents in Action, Second Edition* (Manning, 2026)  
   https://www.manning.com/books/ai-agents-in-action-second-edition
2. Michael Albada — *Building Applications with AI Agents* (O'Reilly, 2025)  
   https://www.oreilly.com/library/view/building-applications-with/9781098176495/
3. Nicole Koenigstein — *AI Agents: The Definitive Guide* (O'Reilly, 2026)  
   https://www.oreilly.com/library/view/ai-agents-the/0642572247775/
4. Jia Huang — *Designing AI Agents* (Manning MEAP, 2026)  
   https://www.manning.com/books/designing-ai-agents
5. Antonio Gullí — *Agentic Design Patterns* (Springer, 2025)  
   https://link.springer.com/book/10.1007/978-3-032-01402-3
6. Valentina Alto — *AI Agents in Practice* (Packt, 2025)  
   https://github.com/PacktPublishing/AI-Agents-in-Practice
7. Anjanava Biswas, Wrick Talukdar — *Building Agentic AI Systems* (Packt)  
   https://github.com/PacktPublishing/Building-Agentic-AI-Systems
8. Kyle Stratis — *AI Agents with MCP* (O'Reilly, 2026)  
   https://www.oreilly.com/library/view/ai-agents-with/9798341639546/

### LLM engineering and model understanding
9. Chip Huyen — *AI Engineering: Building Applications with Foundation Models* (O'Reilly)  
   https://www.oreilly.com/library/view/ai-engineering/9781098166298/
10. Sebastian Raschka — *Build a Large Language Model (From Scratch)* (Manning)  
    https://www.manning.com/books/build-a-large-language-model-from-scratch
11. Jay Alammar, Maarten Grootendorst — *Hands-On Large Language Models* (O'Reilly)  
    https://www.oreilly.com/library/view/hands-on-large-language/9781098150952/
12. Paul Iusztin, Maxime Labonne — *LLM Engineer's Handbook* (Packt)  
    https://www.packtpub.com/en-us/product/llm-engineers-handbook-9781836200062
13. John Berryman, Albert Ziegler — *Prompt Engineering for LLMs* (O'Reilly, 2024)  
    https://www.oreilly.com/library/view/prompt-engineering-for/9781098156145/
14. Lewis Tunstall, Leandro von Werra, Thomas Wolf — *Natural Language Processing with Transformers* (O'Reilly)  
    https://www.oreilly.com/library/view/natural-language-processing/9781098136789/

### RAG, knowledge and memory
15. Salvatore Raieli, Gabriele Iuculano — *Building AI Agents with LLMs, RAG, and Knowledge Graphs* (Packt, 2025)  
    https://www.oreilly.com/library/view/building-ai-agents/9781835087060/
16. Ofer Mendelevitch, Forrest Sheng Bao — *Hands-On RAG for Production* (O'Reilly, 2026)  
    https://www.oreilly.com/library/view/hands-on-rag-for/9798341621701/

### Production, reliability and distributed systems
17. Chip Huyen — *Designing Machine Learning Systems* (O'Reilly)  
    https://www.oreilly.com/library/view/designing-machine-learning/9781098107956/
18. Cathy Chen et al. — *Reliable Machine Learning* (O'Reilly)  
    https://www.oreilly.com/library/view/reliable-machine-learning/9781098106218/
19. Brendan Burns — *Designing Distributed Systems, 2nd Edition* (O'Reilly, 2024)  
    https://www.oreilly.com/library/view/designing-distributed-systems/9781098156343/
20. Martin Kleppmann, Chris Riccomini — *Designing Data-Intensive Applications, 2nd Edition* (O'Reilly, 2026)  
    https://www.oreilly.com/library/view/designing-data-intensive-applications/9781098119058/

Additional references to continue studying: *Release It!*, *Practical MLOps*, *Building Generative AI Services with FastAPI*, *Fundamentals of Data Engineering*, *The Agentic Enterprise*, *Architecting for Autonomy*, and *Systems Thinking for Agentic AI*.

## Repeated engineering ideas across the corpus

The useful common pattern is not "make the prompt smarter." Production agent systems repeatedly converge on the following ideas:

1. **Separate agent concerns into explicit layers.**  
   Model/persona, tools/actions, reasoning/planning, knowledge/memory, and evaluation/feedback should be independent components rather than one opaque prompt.

2. **Treat the agent as a stateful system, not a chat completion.**  
   Agent progress must be represented by durable state transitions, checkpoints, retries, cancellation, and recovery.

3. **Use typed contracts at every boundary.**  
   Tool inputs, tool results, task payloads, node capabilities, model metadata, and final results should have schemas and validation.

4. **Prefer bounded orchestration patterns over uncontrolled autonomy.**  
   Chain, route, parallel, supervisor/orchestrator, hierarchy, and loop patterns should be explicit and policy-limited.

5. **Make memory a first-class subsystem.**  
   Working memory, project memory, long-term knowledge, and operational state should be separated, versioned, and retrieved deliberately.

6. **Ground agents in external evidence.**  
   Retrieval and structured data access should be preferred over asking a model to remember facts from weights.

7. **Evaluate intermediate work, not only the final answer.**  
   Verification should happen per work item, after aggregation, and on important tool actions.

8. **Design for retries and nondeterminism.**  
   Duplicate requests, partial failures, timeouts, unavailable nodes, bad model outputs, and process restarts are normal cases.

9. **Observability is part of the agent runtime.**  
   Every significant decision should expose task ID, node ID, model, timing, tool/action, result status, retry count, and provenance.

10. **Human control belongs in the architecture.**  
    High-impact actions need explicit approval points, policy boundaries, and auditable intervention.

11. **Model selection should be dynamic.**  
    The orchestrator should use task requirements plus node/model capabilities, latency, context window, availability, and cost.

12. **Multi-agent systems need a coordination protocol, not just multiple prompts.**  
    Ownership, leases, message/state format, termination criteria, disagreement handling, and result merging must be explicit.

## What this implies for CITADEL EWS

CITADEL already has useful foundations: signed bounded node control, project work items, node capability reporting, professions, LM Studio integration, Drive-backed payload storage, project result aggregation, and an OpenRouter final quality gate.

The next evolution should make those pieces operate as a formal agent runtime.

### A. Canonical Agent Capability Contract

Add one machine-readable capability document per node/model runtime.

Suggested fields:

- node_id
- agent_version
- runtime_type: python / lmstudio / hybrid
- model_id
- model_family
- context_window
- supported_modalities
- tool_capabilities
- max_concurrency
- memory_available_mb
- gpu/vram metadata when available
- current_load
- health
- trust/policy tier
- last_verified_at

The Hub should route work from this contract instead of relying on version strings or UI assumptions.

### B. Durable project/task state machine

Normalize project execution into an explicit state machine:

```
planned
  -> eligible
  -> assigned
  -> accepted
  -> running
  -> verifying
  -> completed
            \
             -> retry_wait -> assigned
  -> failed
  -> cancelled
```

Every transition should be compare-and-swap/idempotent and carry timestamps, actor, reason, attempt number, and lease expiry.

### C. Supervisor + specialist + verifier pattern

Map the existing professions to an explicit topology:

- Architect: human authority / approval
- Controller Supervisor: decomposes and routes
- Specialist workers: Programmer, Research, Mathematician, Security Analyst, etc.
- Verifier: checks individual work products
- Synthesizer: combines accepted outputs
- Final quality gate: current OpenRouter/local reviewer path

The verifier should not be the same logical role that produced the result when another eligible worker/model is available.

### D. Bounded reflection/retry loop

Allow a failed verification to produce structured feedback and one or more bounded retries.

Required limits:

- max attempts
- token/cost ceiling
- wall-clock timeout
- no repeated identical retry
- stop reason recorded

This gives CITADEL "self-correction" without an endless autonomous loop.

### E. Project memory and RAG layer

Introduce project-scoped retrieval over:

- uploaded files
- prior accepted work-item outputs
- Architect instructions
- selected operational documentation
- conversation/follow-up context

Keep retrieval provenance with every generated answer section.

Do not mix operational secrets or unrestricted node logs into the model context.

### F. Typed task/result envelopes

Replace free-form internal handoffs with versioned envelopes such as:

```json
{
  "schema_version": 1,
  "project_id": "...",
  "work_item_id": "...",
  "role": "programmer",
  "goal": "...",
  "constraints": [],
  "inputs": [],
  "expected_output": {
    "type": "text|json|artifact",
    "schema": null
  },
  "deadline": "...",
  "attempt": 1
}
```

Result envelopes should include model identity, source/provenance references, timing, token/cost metrics when available, and structured failure codes.

### G. Model router

Build a routing score from hard requirements first, then preferences.

Hard filters:
- node alive/healthy
- required runtime installed
- model loaded/available
- context window sufficient
- modality/tool requirements satisfied
- trust/policy constraints satisfied

Soft factors:
- current queue depth
- measured latency
- historical task success
- cost
- VRAM/RAM headroom
- locality

The router should explain its decision in logs.

### H. Agent evaluation harness

Create a repeatable regression suite for the agent system itself.

Minimum scenario classes:

- single-worker deterministic task
- parallel independent subtasks
- disagreement between workers
- worker timeout
- duplicate assignment delivery
- node disappears mid-task
- malformed model output
- verifier rejects first attempt
- model unavailable
- Drive payload temporarily unavailable
- Controller restart during active project
- cancellation during execution

Measure:
- completion rate
- correct terminal state
- duplicate execution rate
- recovery time
- retry count
- routing decision correctness
- end-to-end latency
- final-answer quality checks

### I. MCP as an adapter boundary, not a replacement for CITADEL security

MCP is useful for standardizing access to tools/resources, but CITADEL should retain its signed Controller-to-node protocol for privileged lifecycle operations.

Recommended use:
- expose selected safe resources/tools to agent runtimes through an MCP-compatible adapter;
- keep install/update/reboot/uninstall and other privileged node lifecycle controls outside the generic agent tool surface.

### J. Observability model

Add one trace spanning:

Project -> Plan -> Work Item -> Assignment -> Model Invocation -> Tool Call -> Verification -> Synthesis -> Final Gate.

Each span should carry IDs and timings so the Architect UI can show real progress instead of simulated activity.

## First implementation slice

A practical first slice that improves the real system without rewriting it:

1. Define `agent_capability_v1`, `task_envelope_v1`, and `result_envelope_v1`.
2. Add explicit `verifying` and bounded retry states to project work items.
3. Add a dedicated verifier role/path.
4. Persist routing reason and assignment lease metadata.
5. Add five failure-injection tests before expanding autonomy.
6. Surface the trace in the Architect project report.

This slice is compatible with the current CITADEL signed-command boundary and can be delivered incrementally.

## Research rule for future book extraction

For every additional book/chapter/source, record only:
- the engineering pattern;
- the problem it solves;
- trade-offs/failure modes;
- whether CITADEL already implements it;
- proposed repository change;
- test proving the change.

Do not add features solely because a framework or book mentions them.
