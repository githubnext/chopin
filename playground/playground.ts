import { definePlayground } from "@github-ui/playground/config";
import chopin from "./chopin.feature";

export default definePlayground({
	data: { base: "stock" },
	features: [chopin()],
});
