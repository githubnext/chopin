import { agendaContract } from "../storage/agenda-contract";
import { MemoryStorage } from "../storage/memory/adapter";

agendaContract("memory", () => new MemoryStorage());
