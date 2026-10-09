import type { SVGProps } from "react";

export let iconSizes = [10, 12, 14, 16, 18, 24] as const;
export type IconSize = typeof iconSizes[number];

export type IconProps = Omit<SVGProps<SVGSVGElement>, "height" | "width"> & {
	size?: IconSize;
};

export function LineIcon(
	{ children, size = 14, viewBox = "0 0 18 18", ...props }: IconProps & {
		children: React.ReactNode;
		viewBox?: string;
	},
) {
	let labelled = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
	return (
		<svg
			aria-hidden={labelled ? undefined : true}
			data-nucleo-icon=""
			height={size}
			viewBox={viewBox}
			width={size}
			{...props}
		>
			<g
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
			>
				{children}
			</g>
		</svg>
	);
}
