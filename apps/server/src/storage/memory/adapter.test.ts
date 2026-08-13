import { storageContract } from "../contract";
import { MemoryStorage } from "./adapter";

storageContract("memory", () => new MemoryStorage());
