import type { SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "height" | "width"> & {
	size?: number;
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
