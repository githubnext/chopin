# Development startup checks

Run `bun node_modules/@playwright/test/cli.js test --config e2e/startup/playwright.config.ts`.
Chromium must already be installed (`bun run e2e:browsers`). The suite starts its own
Vite server on port 5431; `STARTUP_PORT` changes that port. It intercepts HTTP API
responses and needs no database or GitHub credentials.

The checks exercise delayed and failed developer feedback loading, preservation
of interactive sign-in state when feedback arrives, and navigation without an
open document loading no collaborative editor modules. They also check that document
code loads before delayed metadata and cannot reopen a route after Back. CI runs
this suite in the browser design job. The production integration suite excludes
these dev-only tests.
