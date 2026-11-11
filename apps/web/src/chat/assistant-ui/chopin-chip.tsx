/**
 * The Chopin chip at the start of the draft: assistant-ui's mention chip (the secondary badge that
 * Directive text draws for a mention, copied and recorded, with one recorded extension point, a
 * control drawn inside it), driven by Chopin's state through props. It says who the message is
 * for; `chopin-chip.ts` holds the rules.
 *
 * The badge clips its own overflow, so a control drawn inside it could never have a touch target
 * wider than the badge. The cross inside it is only drawn there; the button that removes the chip is
 * drawn over it, outside the badge, where the target can grow.
 */

import { CloseIcon, SparkleIcon } from "@chopin/icons";
import { createDirectiveText } from "@/components/assistant-ui/elements/directive-text";
import { ASKING_CHOPIN, REMOVE_CHOPIN } from "../chopin-chip";

const ChipText = createDirectiveText(
	{ parse: () => [{ kind: "mention", type: "agent", label: "Chopin", id: "chopin" }] },
	{
		iconMap: { agent: SparkleIcon },
		trailing: () => <CloseIcon aria-hidden="true" size={12} />,
	},
);

/** The chip, with the button that takes it off. */
export function ChopinChip(
	{ disabled, onRemove }: { disabled: boolean; onRemove: () => void },
) {
	return (
		<span aria-label={ASKING_CHOPIN} className="composer-chip" role="group">
			<ChipText text=":agent[Chopin]" />
			<button
				aria-label={REMOVE_CHOPIN}
				className="composer-chip-remove"
				data-press="none"
				disabled={disabled}
				onClick={onRemove}
				onMouseDown={event => event.preventDefault()}
				type="button"
			/>
		</span>
	);
}
