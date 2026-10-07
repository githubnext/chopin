# Composer jig

Open `http://127.0.0.1:5181/design-jig/composer/` with Vite running:

```sh
CHOPIN_DEV_WEB_PORT=5181 bun run --cwd apps/web dev
```

This is a plain HTML jig with vanilla Dial Kit controls and React islands that
reuse Chopin's components. It has no production route or server mutations.

## Ace findings

Inspected `/Users/maggieappleton/Projects/ace`:

- `packages/ace.ui/src/components/composer/chat-composer.tsx`: controlled modes,
  automatic leading agent mentions, persistent mode after clearing a sent draft,
  formatting toolbar, mention and document pickers, draft/history, and independent
  send/stop controls. Escape exits a mode; double Escape enters Ace mode in the
  current checkout.
- `composer.tsx`: input/footer/header separation, folding accessory sections,
  file-drop feedback, and microphone-reactive glow.
- `composer.css`: agent-accented composer border and glowing submit action with
  an animated beam.
- `composer-actions.tsx`: overlapping secondary stop/cancel control, revealed
  on hover or keyboard focus.
- `composer-submit.tsx`: compact circular submission with busy/recording/editing
  states and motion feedback.

The useful first slice is persistent mode, automatic prefix, accented boundary,
compact footer, growing input, and independent send/stop controls. Shift+Tab is
the requested Chopin shortcut. Petrol replaces Ace green. A plain label makes
the destination clear without relying on colour. The jig uses a steady glow.

## Integration options

1. **Recommended: retain the textarea.** Extract the visual composer from
   `apps/web/src/chat/chat.tsx`; leave draft ownership, reference reconciliation,
   request IDs, acknowledgement, queueing, and errors in Chat. Least migration
   risk and no new editor dependency.
2. **Use Lexical for chat.** Reuse the existing editor stack for rich formatting,
   but implement chat-specific mentions, references, selection, and serialization.
3. **Port Ace's ProseMirror composer.** Closest interaction fidelity, at the cost
   of an additional editor stack and substantial Ace-specific dependencies.

## Small production slices after review

1. Extract the view without changing send behaviour.
2. Add explicit destination mode and Shift+Tab. Keep mode after sending, as Ace
   does. An automatic prefix must shift reference offsets, or send the existing
   explicit `to` value without editing the authored draft. Manual `@chopin`
   remains supported. Capture destination in the submitted draft so retries keep
   the same request ID and destination.
3. Apply reviewed styles and browser-check keyboard/IME input, normal Tab escape,
   references across toggles, acknowledgement and retry, reconnect, and live
   queue/stop/resume behaviour.

Rich formatting, voice, attachments, model selection, and message editing are
separate decisions. They should not appear as controls without supported product
behaviour. A future classifier is independent of this explicit interaction.

The gallery forces transient/error states. Sending, stop/resume, mention/reference
selection, retry, and reconnection are local simulations. The existing current
composer uses an in-memory wire for comparison. No real message is sent.

## Status placement

The jig lists all ten former below-input status messages with preview links.
Working, paused, and sending use controls within the composer. Queued messages
use the real transcript with withdrawal. Send errors use an attached light-red
panel with Retry; Chopin availability uses an attached light-grey panel. Read-only
and archived notices replace the input. Connection states use attached grey
panels with an icon and Reconnect or Retry. No visible status text sits below the adjusted composer.

## Mode-switch motion

The mode toggle uses Chat / Chopin and animates its width to fit the current
label. The shortcut appears only in the mode button’s hover tooltip. Pointer
presses use 0.99 scale rather than the shared small-button 0.96 scale. Width, scale, colour, and glow use the existing 120ms `duration-fast` and
`ease-out` tokens. Keyboard switching and reduced motion are immediate. The
Motion dial can compare press scale from 0.96 to 1; Copy values includes it.

## Document references

Both pickers align with the composer's left edge and use a 10px gap. The document picker matches the composer width, uses the raised
shadow rather than overlay, and has 32px rows. Selected references render in
semibold petrol with an underline. The jig uses an editable text surface with
styled reference spans so the native caret follows their actual font metrics.
The existing identity-backed draft helpers remain in use; edited tokens reconcile
to ordinary text. Pasted content stays plain text.

The Mention docs menu fades in and settles upward by 4px with the existing
dropdown duration and easing. Opening by keyboard or with reduced motion is
immediate. Opening input is captured once so moving the pointer over an
existing menu does not replay its entrance.

The Chopin halo defaults to 40% opacity and 10px spread. The Glow dials allow
up to 100% opacity and 96px spread. An outer shadow keeps the input interior
white while making the mode visible. Updated jig defaults reset the previous
persisted dial settings once.

The composer input defaults to a 64px minimum height.
