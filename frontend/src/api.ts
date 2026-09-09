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

export type Friend = {
  id: string;
  name: string;
  online: boolean;
  can_see_me_online: boolean;
  can_see_me_map: boolean;
  can_modify_my_objects: boolean;
};

export type Group = { id: string; name: string; insignia_id?: string | null; accept_notices: boolean };

export type Conversation = { id: string; name: string; last_ts: string; last_text: string };

export type SearchResult = { id: string; name: string; username: string; is_friend: boolean };

export type CircuitStatus = {
  mode: "grid" | "offline";
  connected: boolean;
  closed?: boolean;
  error?: string | null;
  region_name?: string | null;
  avatar_name?: string;
  rx_packets?: number;
  tx_packets?: number;
  uptime_s?: number;
  events?: string[];
};

/** A thing you can talk to on the IM or Group channel. */
export type ScopeTarget = { id: string; name: string; online?: boolean; kind: "im" | "group"; last_ts?: string };

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
