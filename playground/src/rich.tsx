import { Link } from "@primer/react";
import type { ReactNode } from "react";

let pattern = /(\*\*[^*]+\*\*|`[^`]+`|@[a-z][\w-]*|#\d+)/g;

function reference(token: string) {
	let number = Number(token.slice(1));
	return number >= 12 && number <= 15 ? "/monalisa/smile/pulls" : "/monalisa/smile/issues";
}

/** Renders the small inline subset the demo conversation uses: bold, code, mentions and references. */
export function Rich({ text }: { text: string }) {
	let parts: ReactNode[] = [];
	let last = 0;
	for (let match of text.matchAll(pattern)) {
		let token = match[0];
		let index = match.index;
		if (index > last) parts.push(text.slice(last, index));
		if (token.startsWith("**")) parts.push(<strong key={index}>{token.slice(2, -2)}</strong>);
		else if (token.startsWith("`")) parts.push(<code key={index}>{token.slice(1, -1)}</code>);
		else if (token.startsWith("@")) {
			parts.push(
				<Link key={index} href={token === "@copilot" ? "/copilot" : `/${token.slice(1)}`} inline>
					<strong>{token}</strong>
				</Link>,
			);
		} else {
			parts.push(
				<Link key={index} href={reference(token)} inline>
					{token}
				</Link>,
			);
		}
		last = index + token.length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return <>{parts}</>;
}
