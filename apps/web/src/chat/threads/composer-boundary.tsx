import { ChatComposer } from "../composer";

import type { ChatComposerProps } from "../composer";

/**
 * Single component boundary between the Thread panel and Chopin's main composer.
 * Reuses `ChatComposer` directly and puts "Also send to Chat" at the start of its row of
 * controls, inside the box, so composer changes on `main` flow into threads through one seam.
 */
export function ThreadComposerBoundary(
	props: ChatComposerProps & {
		alsoToChat: boolean;
		alsoDisabled?: boolean;
		onAlsoToChatChange: (checked: boolean) => void;
	},
) {
	return (
		<div className="thread-composer-boundary shrink-0" data-thread-composer="">
			<ChatComposer
				agent={props.agent}
				alone={props.alone}
				banner={props.banner}
				chopin={props.chopin}
				dictation={props.dictation}
				draftable={props.draftable}
				files={props.files}
				format={props.format}
				input={props.input}
				inputRef={props.inputRef}
				mention={props.mention}
				model={props.model}
				notice={props.notice}
				onSubmit={props.onSubmit}
				pickers={props.pickers}
				references={props.references}
				rootRef={props.rootRef}
				rowStart={
					<label className="thread-also-send">
						<input
							checked={props.alsoToChat}
							className="thread-also-checkbox"
							disabled={props.alsoDisabled}
							onChange={event => props.onAlsoToChatChange(event.currentTarget.checked)}
							type="checkbox"
						/>
						<span>Also send to Chat</span>
					</label>
				}
				run={props.run}
				sendDisabled={props.sendDisabled}
				sending={props.sending}
				unavailable={props.unavailable}
			/>
		</div>
	);
}
