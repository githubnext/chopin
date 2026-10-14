import { LineIcon } from "./icon";

import type { IconProps } from "./icon";

export function InvestigationIcon(props: IconProps) {
	return (
		<LineIcon {...props}>
			<path
				d="m9,5.75l.671,2.579,2.579.671-2.579.671-.671,2.579-.671-2.579-2.579-.671,2.579-.671.671-2.579Z"
				fill="currentColor"
			/>
			<path d="m6.25,15.25h-1c-1.105,0-2-.895-2-2v-2.625c0-.897-.728-1.625-1.625-1.625.897,0,1.625-.728,1.625-1.625v-2.625c0-1.105.895-2,2-2h1" />
			<path d="m11.75,15.25h1c1.105,0,2-.895,2-2v-2.625c0-.897.728-1.625,1.625-1.625-.897,0-1.625-.728-1.625-1.625v-2.625c0-1.105-.895-2-2-2h-1" />
		</LineIcon>
	);
}
