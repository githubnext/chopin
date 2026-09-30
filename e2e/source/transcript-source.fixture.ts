export let sourceFixture = `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "../conversation-plan/source.css";
import type { Root } from "react-dom/client";
let saved: Chat.Entry[] = Array.from({ length: 24 }, (_, index) => ({
	id: \`m\${index}\`,
	author: { kind: "member", handle: "ana" },
	text: \`Message \${index}: A🧪 pilot stays visible.\`,
	ts: index + 1,
}));
saved[10] = { ...saved[10]!, text: "**Bold** after a pilot." };

let root: Root | undefined;
let token = 0;
let next = saved.length;

type FixtureState = { active: boolean; entries: Chat.Entry[]; destination?: ChatDestination };

function SourceFixture() {
	let [state, setState] = useState<FixtureState>({ active: true, entries: saved });
	window.transcriptFixture.select = id => {
		let message = saved.find(item => item.id === id);
		let raw = message?.text ?? "A🧪 pilot";
		let quote = id === "m10" ? "Bold" : "A🧪 pilot";
		let start = raw.indexOf(quote);
		setState(state => ({
			...state,
			destination: {
				itemId: "fixture-thread",
				token: ++token,
				source: {
					messageId: id,
					author: { kind: "member", handle: "ana" },
					role: "option",
					quote,
					start,
					end: start + quote.length,
				},
			},
		}));
	};
	window.transcriptFixture.clear = () => setState(state => ({ ...state, destination: undefined }));
	window.transcriptFixture.activate = active => setState(state => ({ ...state, active }));
	window.transcriptFixture.change = (id, text) => setState(state => ({
		...state,
		entries: state.entries.map(item => item.id === id ? { ...item, text } : item),
	}));
	window.transcriptFixture.append = () => {
		let index = next++;
		setState(state => ({
			...state,
			entries: [...state.entries, {
				id: \`m\${index}\`,
				author: { kind: "member", handle: "ana" },
				text: \`Message \${index}: appended after the current viewport.\`,
				ts: index + 1,
			}],
		}));
	};
	return createElement(Transcript, {
		active: state.active,
		entries: state.entries,
		handle: "ana",
		onWithdraw: () => {},
		queued: [],
		sourceDestination: state.destination,
	});
}

window.transcriptFixture = {
	mount() {
		root?.unmount();
		root = createRoot(document.querySelector("#fixture")!);
		root.render(createElement(SourceFixture));
	},
	unmount() {
		root?.unmount();
		root = undefined;
	},
	select() {},
	clear() {},
	activate() {},
	change() {},
	append() {},
};
`;
