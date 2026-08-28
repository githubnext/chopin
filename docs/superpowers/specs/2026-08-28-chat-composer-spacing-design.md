# Chat composer spacing

## Goal

Keep at least 32 pixels between the final Chat message and the top of the composer field on
desktop and compact layouts.

## Design

The transcript leaves a 16-pixel flex gap before its bottom scroll marker. Make that marker a
16-pixel-high spacer. When Chat follows the marker to the bottom, the final message will sit 32
pixels above the composer.

This keeps the existing 16-pixel spacing between messages and does not change the composer's
height, padding, or reference-picker positioning.

## Verification

Extend the tall-transcript Playwright test to measure the rendered distance between the final
message and composer field. Require at least 32 pixels in desktop and compact layouts.
