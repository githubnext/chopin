# Canonical Implementation Skill Instructions

## Problem

The portable implementation skill says Chopin's MCP contract is authoritative,
then repeats lifecycle policy in its own prose. That copy already drifted: it
directs graph changes to `block_task`, while the rebuilt lifecycle requires
`request_revision` to end the run and release the graph. The prompt also asks
agents to read MCP service instructions that the initialize response does not
currently provide.

## Decision

The MCP initialize response will publish concise implementation instructions.
Those instructions will be assembled from the existing public tool registry,
so tool names and descriptions remain the single lifecycle source of truth.
Lifecycle tool descriptions will distinguish task blockers from graph revision
and state the ordering constraints agents need to use the tools safely.

The portable skill will retain only concerns the service cannot know: resolving
the canonical document, validating the local checkout, dependency-aware local
work, independent review, and one pull request per task. It will direct agents
to the initialize instructions and current tool descriptions for lifecycle
semantics instead of naming a second command sequence.

## Verification

A boundary test will call the real MCP initialize handler and assert that its
instructions expose the complete implementation lifecycle, including the
task-blocker/graph-revision distinction. The skill will also be exercised with
a fresh-agent pressure scenario in which sunk work and a deadline tempt the
agent to keep a claim whose graph must change.

PR #50 must contain only the skill commit and this hardening work on the current
PR #49 base; none of the obsolete stack history may remain.
