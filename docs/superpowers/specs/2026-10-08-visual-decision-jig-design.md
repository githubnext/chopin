# Collaborative visual decision jig

## Goal and first specimen

Let a team tune a component inside a Chopin decision, see each other's changes, and save
the exact chosen values as an attributed decision. The first specimen uses Chopin's real
decision card. It exposes option vertical padding (4, 6, or 8 px) and a selected-option
colour (`#RRGGBB`). This proves one numeric and one colour control without introducing
arbitrary repository component publication or a general control generator.

The visual reference is the shadow exploration on `Maggie/visual-interface-evals` at
`ecf6d3342affe995174fff743892c715e9e94a29`: a quiet decision card, Save decision
at top right, a preview and compact right inspector. Its two simultaneous previews are
replaced by the single-preview interaction below. Its Save button is only a callback;
this design includes durable decision persistence.

## Interaction

- Show one adjusted component. Hold **Show current** to temporarily render the
  baseline captured when the decision was created; release to restore the adjusted
  view. Peeking never changes the draft or the saved answer. Pointer and touch use
  press/release; keyboard Space uses key down/up. Assistive-technology activation
  offers a persistent peek toggle that clears on the next activation or focus loss.
- On wide screens, the bounded controls sit in a right inspector beside the preview.
  On narrow screens, they sit below it. **Save decision** stays in the card header;
  Reset is within the inspector and changes the shared draft back to its baseline.
- The controls are Chopin-owned. Dial Kit informs the compact slider treatment but
  is not a production dependency. There is no floating panel, version picker,
  clipboard action, or second visible component.
- Editors see each other's accepted changes live. Viewers can see the changing
  preview but cannot change controls or save. Reconnecting restores the shared
  draft. After Save, reload shows the saved values, saver, and time.

## State and save boundary

The server owns an immutable definition: bundle digest, frozen baseline values,
control IDs, types, numeric steps or colour format, and limits. It owns a separate
visual draft beside the existing questionnaire draft. The visual draft holds one
validated register per control. Edits to different controls converge independently;
if two editors change the same control, the last server-accepted value wins.
The server validates every patch against the definition before durable acceptance
and broadcast. Only repository writers can edit or save.

The trusted Chopin UI subscribes to the visual draft and owns the controls and Save
action. It sends only validated parameter values to the preview. The preview cannot
write the decision record or choose what gets saved.

Save claims one accepted draft revision. Under the document lifecycle lock, the
server stages the authoritative decision record, saved parameter values, attribution,
and document projection, commits them durably, then publishes the result. The
projection identifies the record; browser document edits cannot create or alter
its values. A claim pauses further draft edits until commit or failure. If another
edit advances the draft before the claim, Save refuses the stale revision and shows
the latest values for review. A failed commit releases the claim and leaves the
shared draft available for retry. The frozen baseline is never replaced by a
later source-app change.

## Preview boundary

The first specimen can use a code-owned static bundle of the real decision card.
The trusted host verifies fetched bytes and the manifest. The separate iframe
navigation relies on the trusted preview server serving the same immutable bytes
at that digest URL and on reviewed TLS and ingress preserving those bytes and CSP
without rewriting or injection; browsers do not enforce HTML subresource integrity.
The host keeps credentials and control state outside the iframe and uses an opaque sandbox, restrictive response
CSP, and a versioned, source-checked bridge. The preview site must have a distinct
registrable domain without reusable Chopin credentials before production delivery.
An unexpected frame load must enter a bounded host-owned handshake and replacement
path; the local proof of concept showed that blocked self-navigation can otherwise
leave a Chrome error page in the preview slot. Bundle-supplied URLs never become
host fetch targets. Private repository bundle publication is outside this specimen.

## Verification

- Browser tests cover wide and narrow layouts, one visible preview, press/release
  and accessible peek behavior, Reset, editing permissions, and saved attribution.
- Two browser participants edit separate controls and observe both values; two
  participants edit one control and converge on the last accepted value. Reconnect
  restores the draft and reload restores the saved answer.
- A concurrent edit makes a stale Save refuse without publishing a partial answer;
  a failed commit leaves the draft usable for retry.
- Browser boundary tests repeat the proof-of-concept's cookie, egress, navigation,
  and bridge probes, and prove recovery from a blocked self-navigation. The preview
  never receives a Chopin credential.

## Scope

This design is one end-to-end visual decision for a built-in Chopin component.
It does not add an arbitrary component marketplace, agent-generated bundle
publication, element annotations, a general visual grammar, or decision editing
after Save. Those need separate designs once this workflow is usable.
