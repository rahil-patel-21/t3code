/**
 * Antigravity's client `fs` capability. The containment and read/write
 * behaviour is the shared implementation in `./ClientFiles.ts`; these names
 * stay so the flavor reads in its own terms.
 */
export {
  readClientTextFile as readAntigravityClientTextFile,
  writeClientTextFile as writeAntigravityClientTextFile,
} from "./ClientFiles.ts";
