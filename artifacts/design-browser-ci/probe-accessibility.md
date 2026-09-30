# Deliberate accessibility failure

The temporary unnamed menu action was detected in pinned Linux Chromium. The probe source was removed after this run.

# Test info

- Name: regression-probe.e2e.ts >> detection-probe: unnamed control fails
- Location: e2e/design/regression-probe.e2e.ts:13:0

# Error details

```
Error: Axe findings for probe-unnamed; see attached report and known-issues/README.md

expect(received).toEqual(expected) // deep equality

- Expected  -  1
+ Received  + 17

- Array []
+ Array [
+   Object {
+     "evidence": "Fix any of the following:
+   Element does not have inner text that is visible to screen readers
+   aria-label attribute does not exist or is empty
+   aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty
+   Element has no title attribute
+   Element does not have an implicit (wrapped) <label>
+   Element does not have an explicit <label>
+   Element's default semantics were not overridden with role=\"none\" or role=\"presentation\"",
+     "html": "<button role=\"menuitem\" type=\"button\"></button>",
+     "rule": "button-name",
+     "target": Array [
+       "#_r_4_ > button[role=\"menuitem\"]:nth-child(2)",
+     ],
+   },
+ ]
```
