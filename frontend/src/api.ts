// Same-shaped client the app screens have always used (api.get/api.post,
// saveSession/loadSession/clearSession, reconnectSession) — now backed by an
// in-process router (src/sl/router.ts) that talks to the SL grid directly
// instead of a FastAPI backend. See src/sl/ for the implementation.
import AsyncStorage from "@react-native-async-storage/async-storage";

import { routeGet, routePost } from "./sl/router";
import type { Session } from "./sl/types";

export const api = {
  async post<T>(path: string, body: any): Promise<T> {
    return routePost<T>(path, body);
  },

  async get<T>(path: string): Promise<T> {
    return routeGet<T>(path);
  },
};

export type {
  Session,
  Friend,
  Group,
  Conversation,
  SearchResult,
  CircuitStatus,
  FriendRequestIn,
  RadarAvatar,
  RadarResponse,
  UnreadEntry,
  ScopeTarget,
} from "./sl/types";

/** Re-run the grid handshake for the saved session and refresh the stored session fields. */
export async function reconnectSession(s: Session): Promise<Session> {
  const resp = await api.post<any>(`/reconnect?session_id=${s.session_id}`, {});
  const next: Session = { ...s, avatar_name: resp.avatar_name, agent_id: resp.agent_id, region: resp.region, login_message: resp.login_message };
  await saveSession(next);
  return next;
}

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
