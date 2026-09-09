// Domain types shared by login.ts, circuit.ts, router.ts and src/api.ts.
// Mirrors the pydantic models in the old backend/server.py.
export type Grid = "agni" | "aditi";

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

export type FriendRequestIn = {
  id: string;
  from_id: string;
  from_name: string;
  message: string;
  ts: string;
  status: string;
};

export type RadarAvatar = { id: string; name: string; x: number; y: number; z: number; distance: number | null; is_friend: boolean };
export type RadarResponse = {
  region_name: string | null;
  connected: boolean;
  my_position: number[] | null;
  updated_ago_s: number | null;
  avatars: RadarAvatar[];
};

export type UnreadEntry = { channel: "im" | "group"; scope: string; scope_name?: string | null; count: number };

export type ScopeTarget = { id: string; name: string; online?: boolean; kind: "im" | "group"; last_ts?: string };

export type ChatMessage = {
  id: string;
  session_id: string;
  channel: "local" | "im" | "group";
  scope: string;
  scope_name?: string | null;
  sender: string;
  sender_id?: string | null;
  text: string;
  ts: string;
  system?: boolean;
};

export type InventoryFolder = { id: string; parent_id: string | null; name: string; type: string; version: number };

export type LoginResponse = {
  ok: boolean;
  session_id: string;
  mode: "grid" | "offline";
  grid: string;
  avatar_name: string;
  agent_id?: string | null;
  sl_session_id?: string | null;
  sim_ip?: string | null;
  sim_port?: number | null;
  region?: string | null;
  look_at?: string | null;
  seed_capability?: string | null;
  login_message?: string | null;
  friends_count: number;
  inventory_folders: number;
};

export type Diagnostics = {
  grid: string;
  login_uri: string;
  dns_ok: boolean;
  dns_ms: number;
  reachable: boolean;
  tls_ms: number;
  latency_ms: number | null;
  server_time: string | null;
  viewer_channel: string;
  viewer_version: string;
  error: string | null;
};

export function nowIso(): string {
  return new Date().toISOString();
}
