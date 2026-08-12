# Tool failure labels

## Goal

Make every failed agent tool call identifiable in the expanded tool-run list.

## Behaviour

When a `Chat.Activity` has `status: "failed"`, its existing chronological row
shows a visible red `Failed` label between the tool name and duration. Successful
tool rows remain unchanged. The summary continues to show the aggregate failed
count.

## Design

`ToolRun` already receives each activity and the protocol already supplies its
status, so this is a presentation-only change in `apps/web/src/chat/transcript.tsx`.
The label is plain text, which makes the failing call and its outcome available
to visual and assistive-technology users without opening a second detail view.

## Verification

Extend the browser transcript test to open a completed tool run and assert that
the failed call's row contains both its display name and `Failed`.
