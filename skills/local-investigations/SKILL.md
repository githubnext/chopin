---
name: local-investigations
description: Execute an owner-authorized Chopin investigation using the run-scoped MCP tools and return captured evidence for native views.
---

# Local investigations

A person proposes an investigation by typing `/` on a document line and choosing
**Investigate**; its card sits at that place in the document. Someone selects
**Run** on the card, which starts this run on their own local agent. A failed or
stopped card's **Retry** reuses the same investigation id.

1. Read `read_investigation` before acting. Its sealed brief, source context and
   capability schema are authoritative for this run.
2. Use your normal repository instructions and configured tools. Keep the work
   within the authorized objective. State blockers rather than inventing access,
   results or a different source revision.
3. For performance comparisons, check correctness and measure under comparable
   conditions. Record units, samples, warm-up and aggregation. Distinguish observed,
   derived, simulated and qualitative data.
4. Return a short report, typed datasets, supported native view mappings and useful
   bounded text evidence. All required columns must be present in every row;
   nullable values are explicit and are not zero. Preserve source and capture
   provenance. Never include service credentials or indiscriminate transcripts.
5. Use tables, metric comparisons, bars or lines from the supplied schema. Do not
   generate frontend applications, executable chart configuration or live URLs.
6. Call `submit_investigation_result`. Repair validation failures and submit a valid
   candidate before finishing the turn. The connector handles durable publication.
   Do not claim a decision was accepted or start another investigation yourself.
