---
id: 01M4TTM7D59WDW55KVJMM76EPE
anchor: '@file'
created: 2026-10-13T14:28:23Z
norm: '1'
---

The auth project owns port 8791 and the fourth disposable database in per-test subprocesses. Serialize its files so auth lifecycle and demo rehearsals cannot bind the port or writer lease simultaneously.
