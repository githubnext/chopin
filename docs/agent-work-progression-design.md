# Agent work progression

## Goal

Make Chopin's active work readable as a changing sequence, while keeping actual tool calls available on demand and collapsed by default. The sequence must describe real events rather than invent reasoning text or timed progress.

## Reference review

The [Kobra Reasoning Steps demo](https://kobra.systems/components/reasoning-steps) was inspected in the browser across its source, reasoning, collapsed, and expanded states. It uses one stable 20 px animated lattice beside a short stage title. The title changes with a brief fade, blur, and vertical move; source pills then give way to a height-limited reasoning region. Completion reduces the sequence to a compact button that reopens the detail region. Its seven-second sequence is scripted from fixed stages and paragraphs, so its timing cannot be copied as a truthful representation of a hosted Chopin turn.

## Approaches considered

| Approach | Benefit | Cost |
| --- | --- | --- |
| Use the existing chat events for a derived progression | Small, reviewable client change; stages remain tied to real work | Older entries remain grouped by message rather than an exact persistent turn timeline |
| Add durable turn IDs and a server-side timeline | Exact grouping across messages and reconnections | Cross-package schema and persistence work for a visual improvement |
| Animate the existing tool label and count | Fastest | Keeps the current opaque, technical wording and does not make tool calls inspectable during work |

Use the existing events. Add a protocol turn identity only if a later workflow needs an exact cross-message history. The client already receives each tool's name, status, arguments, result, and duration; the server redacts reference content and caps displayed results.

## Progression and copy

The active work row keeps one stable position beneath Chopin's author line. A small 3×3 dot lattice indicates activity. Its headline changes only when the real event-derived phase changes:

1. A turn without tool or response events: **Getting oriented**.
2. A read/list/search tool is running: **Gathering context**.
3. An `ask` tool is running: **Waiting for an answer**.
4. An edit/create/anchor tool is running: **Making changes**.
5. Another tool is running: **Working through the request**.
6. A response is streaming: **Writing a response**.
7. Tools have finished but the turn has not: **Reviewing the next step**.

Do not auto-advance through phases, show a percentage, or show generated reasoning paragraphs. A small secondary count may state how many actions finished. When the tool-bearing message is complete, the active headline contracts to a one-line disclosure such as **Work details · 4 actions**. Label the sum of reported tool durations as **tool time**, not as the duration of the entire thought or turn. If there are no tool calls, do not leave an empty work disclosure.

## Tool inspection

The tool list is collapsed initially both during and after work. The summary is a button with an expanded state, visible focus, and a stable controlled region. Opening it shows a compact, capped list with a readable name, Running/Done/Failed or Interrupted status, and measured duration when present. Each call has its own disclosure for available **Input** and **Result** text. Preserve line breaks, wrap long strings, and bound scrolling. Do not render tool data as HTML. Redacted results remain redacted. An old `running` activity without an active turn reads **Interrupted** rather than animating forever. A person's explicit expand/collapse choice remains intact as live events arrive.

## Motion and layout

- The lattice uses a low-contrast, diagonally staggered 1.6 s pulse while active. It stops immediately when the turn ends.
- A new phase label enters with opacity and a small vertical shift over about 180 ms. No shimmer runs across text continuously.
- The disclosure uses the existing motion contract; its detail region is at most 192 px tall and scrolls inside the chat pane.
- `prefers-reduced-motion: reduce` removes pulses and stage transitions. There is no motion-only status signal.
- The layout fits the existing narrow chat pane without pushing the composer offscreen or changing breakpoint behavior.

## Verification

Unit tests cover the phase mapping, completed/failed counts, and stale running activity. Chromium tests cover the active sequence, collapsed default, opening tool details during a run, keyboard and ARIA behavior, completion, failure/stop, and reduced motion. Capture real rendered active, expanded, and completed states for the PR. A second agent reviews interaction, accessibility, and code quality before the PR opens.
