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
  can_reconnect?: boolean;
  error?: string | null;
  region_name?: string | null;
  avatar_name?: string;
  rx_packets?: number;
  tx_packets?: number;
  uptime_s?: number;
  events?: string[];
};

export type FriendRequestIn = { id: string; from_id: string; from_name: string; message: string; ts: string; status: string };

export type RadarAvatar = { id: string; name: string; x: number; y: number; z: number; distance: number | null; is_friend: boolean };
export type RadarResponse = {
  region_name: string | null;
  connected: boolean;
  my_position: number[] | null;
  updated_ago_s: number | null;
  avatars: RadarAvatar[];
};

export type UnreadEntry = { channel: "im" | "group"; scope: string; scope_name?: string | null; count: number };

/** Re-run the grid handshake for the saved session and refresh the stored session fields. */
export async function reconnectSession(s: Session): Promise<Session> {
  const resp = await api.post<any>(`/reconnect?session_id=${s.session_id}`, {});
  const next: Session = { ...s, avatar_name: resp.avatar_name, agent_id: resp.agent_id, region: resp.region, login_message: resp.login_message };
  await saveSession(next);
  return next;
}

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
