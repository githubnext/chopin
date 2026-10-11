import { LineIcon } from "./icon";

/** A page with another behind it: the documents list. Sized for the phone bar, so it takes no props. */
export function DocumentsIcon() {
	return (
		<LineIcon size={18}>
			<rect x="3.25" y="4.75" width="9" height="11.5" rx="1.75" />
			<path d="M6.25 2.25h6.5c1.105 0 2 .895 2 2v8.5" />
			<line x1="5.75" x2="9.75" y1="8.75" y2="8.75" />
			<line x1="5.75" x2="9.75" y1="11.75" y2="11.75" />
		</LineIcon>
	);
}
