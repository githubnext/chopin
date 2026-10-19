---
id: 01M5A08APAG4J478BXZV2SZFSV
anchor: function state
created: 2026-10-19T11:55:21Z
norm: '1'
supersedes: 01M4Y2XGZPQ90GJV83JYFVMMZX
---

Prospective Chat views may omit legacy initiativePaused; use nullish fallback to live Chat so explicit false remains meaningful when persisting compatibility state. Automatic participation ignores this legacy pause, and ephemeral initiative candidates must never be persisted or replayed on restore.
