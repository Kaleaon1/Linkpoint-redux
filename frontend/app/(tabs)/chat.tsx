import { useEffect, useMemo, useRef, useState } from "react";
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
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import * as Haptics from "expo-haptics";

import { api, loadSession, type Session } from "@/src/api";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

type Channel = "local" | "im" | "group";
type Msg = {
  id: string;
  channel: Channel;
  scope: string;
  sender: string;
  text: string;
  ts: string;
  system?: boolean;
};

const IM_PEERS = ["Ruth Resident", "Governor Linden", "Torley Linden"];
const GROUPS = ["The Sandbox", "Firestorm Support", "Builders Guild"];

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const [session, setSession] = useState<Session | null>(null);
  const [channel, setChannel] = useState<Channel>("local");
  const [scope, setScope] = useState<string>("local");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef<FlatList<Msg>>(null);

  useEffect(() => {
    loadSession().then(setSession);
  }, []);

  useEffect(() => {
    if (channel === "im" && (scope === "local" || !IM_PEERS.includes(scope))) setScope(IM_PEERS[0]);
    if (channel === "group" && !GROUPS.includes(scope)) setScope(GROUPS[0]);
    if (channel === "local") setScope("local");
  }, [channel, scope]);

  const load = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const msgs = await api.get<Msg[]>(`/chat?session_id=${session.session_id}&channel=${channel}&scope=${encodeURIComponent(scope)}`);
      setMessages(msgs);
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(
    useMemo(
      () => () => {
        load();
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [session, channel, scope],
    ),
  );

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, channel, scope]);

  const send = async () => {
    const body = text.trim();
    if (!body || !session) return;
    setText("");
    Haptics.selectionAsync().catch(() => {});
    try {
      await api.post("/chat/send", {
        session_id: session.session_id,
        channel,
        scope,
        text: body,
      });
      await load();
    } catch (e) {
      // restore text on failure
      setText(body);
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>CHAT</Text>
        <Text style={styles.subtitle}>
          {session ? `> ${session.avatar_name} @ ${session.grid.toUpperCase()}` : "> connecting..."}
        </Text>
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
        >
          {(channel === "im" ? IM_PEERS : GROUPS).map((s) => (
            <Pressable
              key={s}
              testID={`scope-${s}`}
              onPress={() => setScope(s)}
              style={[styles.chip, scope === s && styles.chipActive]}
            >
              <Icon
                name={channel === "im" ? "account" : "account-group"}
                size={14}
                color={scope === s ? colors.brandPrimary : colors.muted}
              />
              <Text style={[styles.chipTxt, scope === s && styles.chipTxtActive]}>{s}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

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
          renderItem={({ item }) => <Bubble msg={item} me={session?.avatar_name} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTxt}>
                {loading ? "> loading channel_" : `> no messages on ${channel === "local" ? "local chat" : scope}`}
              </Text>
              {loading && <ActivityIndicator color={colors.brandPrimary} style={{ marginTop: 8 }} />}
            </View>
          }
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        />

        {/* Compose */}
        <View style={styles.compose}>
          <TextInput
            testID="chat-input"
            value={text}
            onChangeText={setText}
            placeholder={`say to ${channel === "local" ? "local" : scope}...`}
            placeholderTextColor={colors.muted}
            style={styles.composeInput}
            onSubmitEditing={send}
            returnKeyType="send"
          />
          <Pressable testID="chat-send" onPress={send} style={styles.sendBtn}>
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

function Bubble({ msg, me }: { msg: Msg; me?: string }) {
  const styles = useStyles();
  const isMe = msg.sender === me;
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
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  title: { color: c.brandPrimary, fontFamily: displayFont, fontSize: 22, letterSpacing: 6, fontWeight: "700" },
  subtitle: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 2 },
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
  chipTxt: { color: c.muted, fontFamily: monoFont, fontSize: 12 },
  chipTxtActive: { color: c.brandPrimary },
  list: { padding: 12, gap: 6, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 },
  emptyTxt: { color: c.muted, fontFamily: monoFont, fontSize: 13 },
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
