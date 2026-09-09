import AsyncStorage from "@react-native-async-storage/async-storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL ?? "";

export const api = {
  base: `${BASE}/api`,

  async post<T>(path: string, body: any): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await this._err(r);
    return r.json();
  },

  async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.base}${path}`);
    if (!r.ok) throw await this._err(r);
    return r.json();
  },

  async _err(r: Response) {
    let detail: any = r.statusText;
    try {
      const j = await r.json();
      detail = j.detail ?? detail;
    } catch {}
    return new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  },
};

// Session persistence
export type Session = {
  session_id: string;
  mode: "grid" | "offline";
  grid: string;
  avatar_name: string;
  agent_id?: string;
  region?: string;
  login_message?: string;
};

const KEY = "gridlink.session";

export async function saveSession(s: Session) {
  await AsyncStorage.setItem(KEY, JSON.stringify(s));
}
export async function loadSession(): Promise<Session | null> {
  const s = await AsyncStorage.getItem(KEY);
  return s ? JSON.parse(s) : null;
}
export async function clearSession() {
  await AsyncStorage.removeItem(KEY);
}
