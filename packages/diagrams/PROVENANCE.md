# SeeCode source provenance

Copied from [Aryanutkarsh/SeeCode](https://github.com/Aryanutkarsh/SeeCode) at
`8c48bb8804a5e531ea718edecedd10200ddbcb31` under the MIT licence in [LICENSE](LICENSE).

| Local source                             | Upstream source                                                         | Adaptation                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/render/**`                     | `skills/seecode/scripts/lib/render/**`                                  | Layout algorithms retained.                                                                                                                |
| `src/core/{types,schema,svg,motion}.mjs` | Same paths under `skills/seecode/scripts/lib/`                          | Registry, validation, SVG construction and motion retained.                                                                                |
| `src/core/text.mjs`                      | `skills/seecode/scripts/lib/text.mjs`                                   | Fixed 1.1 width allowance for Chopin Inter; removed mutable global width scale.                                                            |
| `src/core/tokens.mjs`                    | `skills/seecode/scripts/lib/tokens.mjs`                                 | Retained only renderer layout type ramp; browser styling owns colours and fonts.                                                           |
| `src/core/schemas/*.json`                | `skills/seecode/schemas/*.json`                                         | Static schema registry in `src/core/schemas.ts`; no file reads.                                                                            |
| `src/fixtures/specs/**`                  | `examples/specs/**`                                                     | Retained resolved JSON examples for tests and gallery.                                                                                     |
| `src/render.ts`                          | Rendering boundary adapted from `skills/seecode/scripts/lib/render.mjs` | Bounded JSON input, static schema lookup, alias normalization and structured results; CLI, file data loading, and page generation omitted. |

Repository formatting and safe lint fixes were applied to the copied algorithms. No upstream fonts,
brand assets, standalone page, importer/exporter or command-line files are copied. The legacy
`loop-terminal` alias retains its variant, but its `skin: "terminal"` hint is not used: the embedded
viewer applies Chopin's presentation tokens.
