---
id: "006"
title: Fix duplicate React keys on block preview portals
status: pr-opened
branch: tq/006-fix-duplicate-react-keys
pr: "https://github.com/githubnext/chopin/pull/24"
stacked_on:
blocked_reason:
---

## Context

Opening any plan that contains a code, diff or math block fills the console
with React's "Encountered two children with the same key" warning. It repeats
on every editor commit, so typing near one of these blocks produces the warning
in bursts of twenty or more.

## Goal

Render the block preview without React key collisions, so the console stays
clean while a plan containing code is edited.

## Notes

The plugin that renders code, diff and math blocks mounts two portals per
block, returned as siblings from one fragment: one into the preview host, one
into the chrome row that carries the language select and the collapse toggle.
Both are given the block's Lexical node key.

`createPortal`'s third argument is the React key, so the two siblings collide.
The key that appears in the warning is a bare number because Lexical node keys
are numeric strings.

Give each portal a key derived from the node key but distinct per role. Do not
solve it by dropping a key — the portals are keyed deliberately, so that a
block keeps its rendered output across commits rather than remounting and
losing scroll position inside a long code fence.

Worth checking whether the same pattern appears in the tabs strip, which also
keys off Lexical node keys, though it renders one element per node rather than
two and so is probably fine.

This is a correctness warning, not a cosmetic one: React's documented behaviour
for duplicate sibling keys is that children may be duplicated or omitted, and
that the behaviour may change between versions.

## Acceptance

- [ ] Opening a plan containing a code block produces no "same key" warning in
      the console
- [ ] Typing inside a paragraph next to a code block produces no such warning
- [ ] A plan containing a code block, a diff block and a formula renders all
      three previews, with the language select and collapse toggle on each
- [ ] Collapsing a code block, editing elsewhere, and returning leaves it
      collapsed
- [ ] A console screenshot showing zero warnings while editing a plan with a
      code block, attached to the PR
