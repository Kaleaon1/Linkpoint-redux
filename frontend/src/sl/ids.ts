import * as Crypto from "expo-crypto";

/** RFC-4122 v4 id for local-only records (session ids, chat message ids, ...). */
export function newId(): string {
  return Crypto.randomUUID();
}
