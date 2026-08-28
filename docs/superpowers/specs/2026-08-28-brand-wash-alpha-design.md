# Brand wash alpha design

## Decision

Define `--color-brand-wash` as the brand colour at true 30% opacity:

```css
color-mix(in srgb, var(--color-brand) 30%, transparent)
```

This preserves the brand hue while allowing the surface beneath it to contribute to the result.

## Scope

- Change only `--color-brand-wash`.
- Keep all existing consumers and the design-audit swatch on the shared token.
- Do not change the brand, hover, active, or ink colours.

## Verification

- Add a token contract that distinguishes true alpha from an opaque page tint.
- Run the token tests and validation.
- Inspect the swatch and representative brand-wash consumers in the live catalogue.
