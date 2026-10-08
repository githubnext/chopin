# Evidence and handoff

Report these facts in the form the current delivery contract accepts, or in a
small local report when integration is absent:

- Source repository, branch and full commit; relevant dirty files and whether the
  generated preview changes source. Name component exports, child/provider paths,
  style/token references, dependency versions and fixture substitutions.
- Each control's meaning, app mapping, unit, bounds/step and source baseline.
  Separate retained chosen values from a temporary comparison baseline.
- Build command, entry point and exact emitted resource list, including CSS,
  chunks, fonts and images. Compute SHA-256 over each resource's actual bytes and
  compare the final directory to the list; keep the manifest outside its own hash
  set. These local facts are not an invented delivery schema or integrity policy.
- Browser commands, viewport dimensions, screenshots and measured outcomes.
  Distinguish observations, interpretations and unresolved choices.
- Compatibility limits, missing capabilities and untested behaviour.

## Browser verification

Serve built resources after the compiler/development server has stopped. Observe
console/page errors, failed requests, bad HTTP responses and unexpected external
calls. Compare the live source and embedded baseline at the same component
viewport after `document.fonts.ready` and image readiness; screenshots of an
imitation do not establish fidelity. Check real children, assets, fonts, portals
and narrow layout, including clipping and horizontal overflow.

Exercise each control through the actual host; inspect the real affected prop or
computed style. Check invalid snapshots are refused, Reset restores baseline,
and supported pointer/keyboard comparison restores chosen values on every exit.
Assert restored styles, chosen snapshot and comparison state immediately after
each exit, before another exit or cleanup can mask a failure. For cancellation,
capture loss, blur or visibility checks, keep the pointer held until that assertion;
check keyboard focus loss before key-up. For native capture loss, move while held
to activate pending capture, call `releasePointerCapture`, then move outside while
still held and assert restoration before release cleanup. Distinguish injected
event-handler checks from native browser or physical device/OS evidence.

Test visible rendering failure and recovery with retained chosen values. After
Retry, observe the replacement frame/attempt and successful fresh resource loads
before asserting the component; old repaired DOM can pass value assertions while
the replacement build is still pending.

Describe only checks you ran and results you observed. A local sandbox test does
not certify production artifact access, retention, hosting or privacy. Preparing
resources or exporting values does not approve a shared decision.
