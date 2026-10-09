import type { IconProps } from "@chopin/icons";
import type { ComponentProps, ComponentType } from "react";

import { IconLabel } from "./icon-label";
import { semanticClasses } from "./semantic-tone";
import type { SemanticTone } from "./semantic-tone";

export type BadgeProps = Omit<ComponentProps<"span">, "children"> & {
	icon: ComponentType<IconProps>;
	label: string;
	/** `sm` is a compact, borderless status label for dense chrome such as headers. */
	size?: "md" | "sm";
	/** Dense chrome can reduce the label independently of its badge geometry. */
	textSize?: "xs" | "2xs";
	tone?: SemanticTone;
};

export function Badge(
	{ className, icon, label, size = "md", textSize, tone = "neutral", ...props }: BadgeProps,
) {
	return (
		<span
			{...props}
			className={semanticClasses("cv-badge", className)}
			data-size={size}
			data-text-size={textSize}
			data-slot="badge"
			data-tone={tone}
		>
			<IconLabel icon={icon} label={label} tone={tone} />
		</span>
	);
}
