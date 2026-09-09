// Tiny shared store for unread IM/group counts. One poller for the whole app
// (started on first subscribe); the Chat screen and the tab bar both read it.
import { useEffect, useSyncExternalStore } from "react";

import { api, loadSession, type UnreadEntry } from "@/src/api";

const POLL_MS = 8000;

type State = { entries: UnreadEntry[]; total: number };

let state: State = { entries: [], total: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit(next: UnreadEntry[]) {
  state = { entries: next, total: next.reduce((n, e) => n + e.count, 0) };
  listeners.forEach((l) => l());
}

export async function refreshUnread() {
  const s = await loadSession();
  if (!s) return;
  try {
    emit(await api.get<UnreadEntry[]>(`/chat/unread?session_id=${s.session_id}`));
  } catch {
    // keep last known counts
  }
}

export async function markRead(channel: "im" | "group" | "local", scope: string) {
  if (channel === "local") return;
  const s = await loadSession();
  if (!s) return;
  // Optimistic clear so the badge disappears instantly.
  emit(state.entries.filter((e) => !(e.channel === channel && e.scope === scope)));
  try {
    await api.post("/chat/mark_read", { session_id: s.session_id, channel, scope });
  } catch {
    // will be corrected on next poll
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!timer) {
    refreshUnread();
    timer = setInterval(refreshUnread, POLL_MS);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useUnread(): State {
  const snap = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    refreshUnread();
  }, []);
  return snap;
}

export function unreadFor(entries: UnreadEntry[], channel: string, scope: string): number {
  return entries.find((e) => e.channel === channel && e.scope === scope)?.count ?? 0;
}

export function unreadForChannel(entries: UnreadEntry[], channel: string): number {
  return entries.filter((e) => e.channel === channel).reduce((n, e) => n + e.count, 0);
}
