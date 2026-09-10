// Manual mock: an in-memory key/value store standing in for the OS
// keychain/Keystore, auto-applied by Jest for the whole suite.
const store = new Map<string, string>();

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}
export async function getItemAsync(key: string): Promise<string | null> {
  return store.has(key) ? store.get(key)! : null;
}
export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}
/** Test helper: clear all stored credentials between tests. */
export function __reset(): void {
  store.clear();
}
