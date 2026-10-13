---
id: 01M4T9CRWAKB5K14NFX6BP1VAE
anchor: function prepareWorkspace
created: 2026-10-13T09:27:13Z
norm: '1'
sig: f7d499144b66000f
body_hash: b8dfd346a4f24ac6
raw_hash: 4845a3e803dfe6e7
lines: 114-159
---

Investigation retries retain the request ID but receive a new server claim generation. Key both receipt and worktree by attempt so explicit retries can run while replaying the same generation remains blocked; keep the first generation's legacy path and preserve prior work.
