---
id: 01M4Y4JRMYYBDQFKYABHSWCH1F
anchor: function claimContext
created: 2026-10-14T21:20:04Z
norm: '1'
sig: 1456206dda9c4409
body_hash: de99e477057aa06d
raw_hash: 12e7dec003b34ace
lines: 35-55
---

PostgreSQL JSONB may arrive as serialized JSON text through Bun. Normalize and validate it at the adapter boundary; a TypeScript row annotation cannot establish the driver return shape.
