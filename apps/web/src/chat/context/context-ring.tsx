import { ComposerContext } from "@/components/assistant-ui/elements/composer";
import { toComposerUsage } from "./context-usage";

import type { Chat } from "@chopin/protocol";

export function ContextRing({ usage }: { usage?: Chat.ContextUsage }) {
	let mapped = toComposerUsage(usage);
	if (!mapped) return null;
	return <ComposerContext usage={mapped} />;
}

export default ContextRing;
