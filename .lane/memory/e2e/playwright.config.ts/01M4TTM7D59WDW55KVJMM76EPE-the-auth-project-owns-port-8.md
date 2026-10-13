---
id: 01M4TTM7D59WDW55KVJMM76EPE
anchor: '@file'
created: 2026-10-13T14:28:23Z
norm: '1'
sig: e05fabb2b0d7bcbc
body_hash: 1459a7363d884900
raw_hash: b8045497a04af4bb
lines: 1-228
---

The auth project owns port 8791 and the fourth disposable database in per-test subprocesses. Serialize its files so auth lifecycle and demo rehearsals cannot bind the port or writer lease simultaneously.
