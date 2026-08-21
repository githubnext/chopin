# Chopin mention

## Goal

Replace the public `@ai` summons with `@chopin` and name Chopin directly in the
composer. This is a hard cutover: `@ai` becomes ordinary room text.

## Behaviour

- `@chopin` routes a message to the Planner, case-insensitively and with the
  existing token-boundary rules.
- The summons is removed before the instruction reaches the Planner.
- Generated accepted-comment instructions use `@chopin`.
- The composer says `Use @chopin to ask Chopin`.
- User documentation and examples use `@chopin`.
- Internal names such as the `planner` wire destination remain unchanged.

## Verification

Addressing tests will prove that `@chopin` routes and is stripped, while `@ai`
does not route. Existing unit, type, formatting, and relevant browser coverage
will be updated and run.
