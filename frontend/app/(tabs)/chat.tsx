import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import * as Haptics from "expo-haptics";

import {
  api,
  loadSession,
  type Session,
  type Friend,
  type Group,
  type Conversation,
  type CircuitStatus,
  type ScopeTarget,
} from "@/src/api";
import { ScopePicker } from "@/src/components/scope-picker";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

type Channel = "local" | "im" | "group";
type Msg = {
  id: string;
  channel: Channel;
  scope: string;
  scope_name?: string | null;
  sender: string;
  sender_id?: string | null;
  text: string;
  ts: string;
  system?: boolean;
};

const CHAT_POLL_MS = 4000;
const ROSTER_POLL_MS = 30000;
const CHIP_LIMIT = 8;

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const router = useRouter();
  const params = useLocalSearchParams<{ im?: string; name?: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [channel, setChannel] = useState<Channel>("local");
  const [scope, setScope] = useState<string>("local");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [status, setStatus] = useState<CircuitStatus | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Peer opened from Friends tab / search that may be offline and have no history yet.
  const [pinned, setPinned] = useState<ScopeTarget | null>(null);
  const listRef = useRef<FlatList<Msg>>(null);
  const focused = useRef(false);

  useEffect(() => {
    loadSession().then(setSession);
  }, []);

  // Roster: online friends, groups, IM history, circuit status.
  const loadRoster = useCallback(async (s: Session) => {
    const q = `?session_id=${s.session_id}`;
    const [f, g, c, st] = await Promise.all([
      api.get<Friend[]>(`/friends${q}`).catch(() => null),
      api.get<Group[]>(`/groups${q}`).catch(() => null),
      api.get<Conversation[]>(`/im/conversations${q}`).catch(() => null),
      api.get<CircuitStatus>(`/status${q}`).catch(() => null),
    ]);
    if (f) setFriends(f);
    if (g) setGroups(g);
    if (c) setConvs(c);
    if (st) setStatus(st);
  }, []);

  useEffect(() => {
    if (!session) return;
    loadRoster(session);
    const t = setInterval(() => loadRoster(session), ROSTER_POLL_MS);
    return () => clearInterval(t);
  }, [session, loadRoster]);

  // Deep-link from Friends tab: /chat?im=<agent_id>&name=<display name>
  useEffect(() => {
    if (!params.im) return;
    setChannel("im");
    setScope(params.im);
    setPinned({ id: params.im, name: params.name || "Resident", kind: "im" });
    router.setParams({ im: undefined, name: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.im]);

  // IM targets: online friends first, then recent conversations, then the pinned peer.
  const imTargets = useMemo<ScopeTarget[]>(() => {
    const byId = new Map<string, ScopeTarget>();
    const friendById = new Map(friends.map((f) => [f.id, f]));
    friends.filter((f) => f.online).forEach((f) => byId.set(f.id, { id: f.id, name: f.name, online: true, kind: "im" }));
    convs.forEach((c) => {
      if (!byId.has(c.id)) {
        const fr = friendById.get(c.id);
        byId.set(c.id, { id: c.id, name: fr?.name ?? c.name, online: !!fr?.online, kind: "im", last_ts: c.last_ts });
      }
    });
    if (pinned && !byId.has(pinned.id)) {
      const fr = friendById.get(pinned.id);
      byId.set(pinned.id, { ...pinned, name: fr?.name ?? pinned.name, online: !!fr?.online });
    }
    return Array.from(byId.values());
  }, [friends, convs, pinned]);

  const groupTargets = useMemo<ScopeTarget[]>(
    () => groups.map((g) => ({ id: g.id, name: g.name, kind: "group" as const })),
    [groups],
  );

  const targets = useMemo<ScopeTarget[]>(
    () => (channel === "im" ? imTargets : channel === "group" ? groupTargets : []),
    [channel, imTargets, groupTargets],
  );
  const scopeName = useMemo(() => {
    if (channel === "local") return "local";
    return targets.find((t) => t.id === scope)?.name ?? messages.find((m) => m.scope_name)?.scope_name ?? "";
  }, [channel, scope, targets, messages]);

  // Keep scope valid for the active channel.
  useEffect(() => {
    if (channel === "local") {
      if (scope !== "local") setScope("local");
      return;
    }
    if (scope === "local" || (!targets.some((t) => t.id === scope) && !(channel === "im" && pinned?.id === scope))) {
      setScope(targets[0]?.id ?? "");
    }
  }, [channel, scope, targets, pinned]);

  const load = useCallback(
    async (silent = false) => {
      if (!session || !scope) {
        setMessages([]);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const msgs = await api.get<Msg[]>(
          `/chat?session_id=${session.session_id}&channel=${channel}&scope=${encodeURIComponent(scope)}`,
        );
        setMessages((prev) => (prev.length === msgs.length && prev[prev.length - 1]?.id === msgs[msgs.length - 1]?.id ? prev : msgs));
      } catch {
        // keep last good list
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [session, channel, scope],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Live: poll the active channel while this tab is focused.
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      load(true);
      const t = setInterval(() => {
        if (focused.current) load(true);
      }, CHAT_POLL_MS);
      return () => {
        focused.current = false;
        clearInterval(t);
      };
    }, [load]),
  );

  const send = async () => {
    const body = text.trim();
    if (!body || !session || !scope) return;
    setText("");
    setSendError(null);
    Haptics.selectionAsync().catch(() => {});
    try {
      await api.post("/chat/send", {
        session_id: session.session_id,
        channel,
        scope,
        scope_name: channel === "local" ? "Local Chat" : scopeName,
        text: body,
      });
      await load(true);
    } catch (e: any) {
      setText(body);
      setSendError(e?.message ?? "send failed");
    }
  };

  const connected = status?.connected ?? false;
  const region = status?.region_name ?? session?.region ?? session?.grid.toUpperCase();
  const visibleChips = targets.slice(0, CHIP_LIMIT);
  const chipsHaveScope = visibleChips.some((t) => t.id === scope);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>CHAT</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {session ? `> ${session.avatar_name} @ ${region}` : "> connecting..."}
          </Text>
        </View>
        <View testID="link-status" style={[styles.link, connected ? styles.linkOn : styles.linkOff]}>
          <View style={[styles.linkDot, { backgroundColor: connected ? colors.success : colors.error }]} />
          <Text style={[styles.linkTxt, { color: connected ? colors.success : colors.error }]}>
            {status ? (connected ? "LINK" : "NO LINK") : "..."}
          </Text>
        </View>
      </View>

      {/* Channel segmented */}
      <View style={styles.segment}>
        <Seg label="LOCAL" active={channel === "local"} onPress={() => setChannel("local")} testID="chan-local" />
        <Seg label="IM" active={channel === "im"} onPress={() => setChannel("im")} testID="chan-im" />
        <Seg label="GROUP" active={channel === "group"} onPress={() => setChannel("group")} testID="chan-group" />
      </View>

      {/* Scope chips */}
      {channel !== "local" && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsRow}
          style={styles.chipsScroll}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            testID="scope-picker-open"
            onPress={() => setPickerOpen(true)}
            style={[styles.chip, styles.chipAll, !chipsHaveScope && scope ? styles.chipActive : null]}
          >
            <Icon name="format-list-bulleted" size={14} color={colors.brandPrimary} />
            <Text style={[styles.chipTxt, styles.chipTxtActive]}>
              {!chipsHaveScope && scope && scopeName ? scopeName : `ALL (${targets.length})`}
            </Text>
          </Pressable>
          {visibleChips.map((t) => (
            <Pressable
              key={t.id}
              testID={`scope-${t.id}`}
              onPress={() => setScope(t.id)}
              style={[styles.chip, scope === t.id && styles.chipActive]}
            >
              {t.kind === "im" ? (
                <View style={[styles.chipDot, { backgroundColor: t.online ? colors.success : colors.muted }]} />
              ) : (
                <Icon name="account-group" size={14} color={scope === t.id ? colors.brandPrimary : colors.muted} />
              )}
              <Text style={[styles.chipTxt, scope === t.id && styles.chipTxtActive]} numberOfLines={1}>
                {t.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <ScopePicker
        visible={pickerOpen}
        title={channel === "im" ? "IM PEERS" : "GROUPS"}
        targets={targets}
        selected={scope}
        onSelect={(t) => setScope(t.id)}
        onClose={() => setPickerOpen(false)}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
        style={{ flex: 1 }}
      >
        {/* Messages */}
        <FlatList
          ref={listRef}
          testID="chat-list"
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <Bubble msg={item} me={session?.avatar_name} meId={session?.agent_id} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              {channel !== "local" && targets.length === 0 ? (
                <>
                  <Text style={styles.emptyTxt}>
                    {channel === "im" ? "> no friends online and no IM history" : "> no groups on this account"}
                  </Text>
                  {channel === "im" && (
                    <Pressable testID="empty-goto-friends" onPress={() => router.push("/(tabs)/friends")} style={styles.emptyBtn}>
                      <Icon name="account-multiple-outline" size={16} color={colors.brandPrimary} />
                      <Text style={styles.emptyBtnTxt}>OPEN FRIENDS</Text>
                    </Pressable>
                  )}
                </>
              ) : (
                <Text style={styles.emptyTxt}>
                  {loading ? "> loading channel_" : `> no messages on ${channel === "local" ? "local chat" : scopeName || "this channel"}`}
                </Text>
              )}
              {loading && <ActivityIndicator color={colors.brandPrimary} style={{ marginTop: 8 }} />}
            </View>
          }
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        />

        {sendError ? (
          <Text testID="send-error" style={styles.sendError}>{`> ${sendError}`}</Text>
        ) : null}

        {/* Compose */}
        <View style={styles.compose}>
          <TextInput
            testID="chat-input"
            value={text}
            onChangeText={setText}
            placeholder={scope ? `say to ${channel === "local" ? "local" : scopeName}...` : "pick someone to talk to"}
            placeholderTextColor={colors.muted}
            style={styles.composeInput}
            onSubmitEditing={send}
            returnKeyType="send"
            editable={!!scope}
          />
          <Pressable testID="chat-send" onPress={send} style={[styles.sendBtn, !scope && { opacity: 0.4 }]} disabled={!scope}>
            <Icon name="send" size={20} color={colors.onBrandPrimary} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function Seg({ label, active, onPress, testID }: any) {
  const styles = useStyles();
  return (
    <Pressable onPress={onPress} testID={testID} style={[styles.segBtn, active && styles.segBtnActive]}>
      <Text style={[styles.segTxt, active && styles.segTxtActive]}>{label}</Text>
    </Pressable>
  );
}

function Bubble({ msg, me, meId }: { msg: Msg; me?: string; meId?: string }) {
  const styles = useStyles();
  const isMe = (meId && msg.sender_id === meId) || msg.sender === me;
  const isSys = msg.system || msg.sender === "System";
  const ts = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <View style={[styles.bubbleWrap, isMe ? { alignItems: "flex-end" } : { alignItems: "flex-start" }]}>
      <View
        style={[
          styles.bubble,
          isMe ? styles.bubbleMe : styles.bubbleThem,
          isSys && styles.bubbleSys,
        ]}
      >
        <View style={styles.bubbleHead}>
          <Text style={[styles.bubbleSender, isSys && { color: colors.warning }]}>
            [{ts}] {msg.sender}
          </Text>
        </View>
        <Text style={[styles.bubbleText, isSys && { color: colors.warning }]}>{msg.text}</Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, flexDirection: "row", alignItems: "center", gap: 12 },
  title: { color: c.brandPrimary, fontFamily: displayFont, fontSize: 22, letterSpacing: 6, fontWeight: "700" },
  subtitle: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 2 },
  link: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 28, borderRadius: 4, borderWidth: 1 },
  linkOn: { borderColor: c.success, backgroundColor: c.surfaceSecondary },
  linkOff: { borderColor: c.error, backgroundColor: c.surfaceSecondary },
  linkDot: { width: 6, height: 6, borderRadius: 3 },
  linkTxt: { fontFamily: monoFont, fontSize: 10, letterSpacing: 2 },
  segment: {
    flexDirection: "row",
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    overflow: "hidden",
  },
  segBtn: { flex: 1, paddingVertical: 10, alignItems: "center", backgroundColor: c.surfaceSecondary },
  segBtnActive: { backgroundColor: c.brandTertiary, borderBottomWidth: 2, borderBottomColor: c.brandPrimary },
  segTxt: { color: c.muted, fontFamily: monoFont, fontSize: 12, letterSpacing: 3 },
  segTxtActive: { color: c.brandPrimary },
  chipsScroll: { maxHeight: 56 },
  chipsRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  chip: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    flexShrink: 0,
  },
  chipActive: { borderColor: c.brandPrimary, backgroundColor: c.brandTertiary },
  chipAll: { borderColor: c.brandSecondary },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipTxt: { color: c.muted, fontFamily: monoFont, fontSize: 12, maxWidth: 160 },
  chipTxtActive: { color: c.brandPrimary },
  list: { padding: 12, gap: 6, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60, gap: 12 },
  emptyTxt: { color: c.muted, fontFamily: monoFont, fontSize: 13, textAlign: "center" },
  emptyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 44,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: c.brandPrimary,
    borderRadius: 4,
    backgroundColor: c.brandTertiary,
  },
  emptyBtnTxt: { color: c.brandPrimary, fontFamily: monoFont, fontSize: 12, letterSpacing: 2 },
  sendError: { color: c.error, fontFamily: monoFont, fontSize: 11, paddingHorizontal: 12, paddingBottom: 6 },
  bubbleWrap: { width: "100%", marginVertical: 2 },
  bubble: {
    maxWidth: "88%",
    padding: 8,
    borderRadius: 4,
    borderWidth: 1,
  },
  bubbleThem: { backgroundColor: c.surfaceSecondary, borderColor: c.border },
  bubbleMe: { backgroundColor: c.brandTertiary, borderColor: c.brandPrimary },
  bubbleSys: { backgroundColor: "transparent", borderColor: c.warning, borderStyle: "dashed" },
  bubbleHead: { marginBottom: 2 },
  bubbleSender: { color: c.brandPrimary, fontFamily: monoFont, fontSize: 10 },
  bubbleText: { color: c.onSurface, fontFamily: monoFont, fontSize: 13, lineHeight: 18 },
  compose: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.surfaceSecondary,
  },
  composeInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    backgroundColor: c.surface,
    color: c.onSurface,
    paddingHorizontal: 12,
    fontFamily: monoFont,
    fontSize: 14,
  },
  sendBtn: {
    width: 48,
    height: 44,
    borderRadius: 4,
    backgroundColor: c.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
}));
