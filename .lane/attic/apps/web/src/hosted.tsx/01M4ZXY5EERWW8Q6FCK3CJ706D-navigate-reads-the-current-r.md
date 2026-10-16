---
id: 01M4ZXY5EERWW8Q6FCK3CJ706D
anchor: hostedRoute(location.pathname)
created: 2026-10-15T14:02:27Z
norm: '1'
---

navigate reads the current route from location, not route state: navigation-shell rewrites a renamed parent's slug with history.replaceState without updating HostedApp's route, and canonicalPath then early-returns. A stale slug made research-child opens skip the opener/history marker (flaky research-child-motion focus tests).
