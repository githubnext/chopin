import { ROOT } from "../servers";
import { requireScriptedServer } from "./scripted-environment";
import { createScriptedFetch } from "./scripted-network";

requireScriptedServer(process.env, ROOT);
let network = globalThis.fetch;
globalThis.fetch = createScriptedFetch(network);
