---
id: 01M4M43PSAZGBJBTD4JWW04C6P
anchor: const calloutFoldState
created: 2026-10-10T23:59:27Z
norm: '1'
---

Fold is NodeState outside containers.ts on purpose: containers.ts carries whole-file sourceHash design-contract exceptions, so any edit there needs exception renewal. The editor plugin owns data-fold-state/data-fold-lead and the unmanaged disclosure host.
