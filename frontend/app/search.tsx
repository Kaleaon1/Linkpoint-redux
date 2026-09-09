import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, FlatList, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import * as Haptics from "expo-haptics";

import { api, loadSession, type Session, type SearchResult } from "@/src/api";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

type RowState = "idle" | "sending" | "sent" | "error";

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadSession().then(setSession);
  }, []);

  const search = async (term: string) => {
    if (!session) return;
    const needle = term.trim();
    if (needle.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const r = await api.get<SearchResult[]>(`/search/residents?session_id=${session.session_id}&q=${encodeURIComponent(needle)}`);
      setResults(r);
      setSearched(true);
    } catch (e: any) {
      setError(e?.message ?? "search failed");
    } finally {
      setSearching(false);
    }
  };

  const onChange = (v: string) => {
    setQ(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => search(v), 450);
  };

  const addFriend = async (r: SearchResult) => {
    if (!session) return;
    setRowState((s) => ({ ...s, [r.id]: "sending" }));
    Haptics.selectionAsync().catch(() => {});
    try {
      await api.post("/friends/request", {
        session_id: session.session_id,
        agent_id: r.id,
        name: r.name,
        message: `Hi ${r.name.split(" ")[0]}, adding you from GridLink Mobile.`,
      });
      setRowState((s) => ({ ...s, [r.id]: "sent" }));
    } catch (e: any) {
      setRowState((s) => ({ ...s, [r.id]: "error" }));
      setError(e?.message ?? "request failed");
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Pressable testID="search-back" onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Icon name="arrow-left" size={22} color={colors.brandPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>FIND RESIDENTS</Text>
          <Text style={styles.subtitle}>{"> " + (session?.mode === "grid" ? "AvatarPickerSearch @ " + session.grid.toUpperCase() : "offline directory")}</Text>
        </View>
      </View>

      <View style={styles.searchRow}>
        <Icon name="magnify" size={18} color={colors.muted} />
        <TextInput
          testID="search-input"
          value={q}
          onChangeText={onChange}
          onSubmitEditing={() => search(q)}
          placeholder="resident name (min 2 chars)"
          placeholderTextColor={colors.muted}
          style={styles.search}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {searching ? <ActivityIndicator color={colors.brandPrimary} size="small" /> : null}
      </View>

      {error ? <Text testID="search-error" style={styles.error}>{`> ${error}`}</Text> : null}

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <FlatList
          testID="search-results"
          data={results}
          keyExtractor={(r) => r.id}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTxt}>
                {searched && !searching ? "> no residents match" : "> type a name to search the grid"}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const st: RowState = rowState[item.id] ?? "idle";
            return (
              <View style={styles.row} testID={`result-${item.id}`}>
                <Icon name="account-circle-outline" size={28} color={colors.brandSecondary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.meta}>{item.username} · {item.id.slice(0, 8)}</Text>
                </View>
                {item.is_friend ? (
                  <Pressable
                    testID={`im-${item.id}`}
                    onPress={() => router.replace({ pathname: "/(tabs)/chat", params: { im: item.id, name: item.name } })}
                    style={styles.pillGhost}
                  >
                    <Icon name="message-text-outline" size={14} color={colors.brandPrimary} />
                    <Text style={styles.pillGhostTxt}>FRIEND</Text>
                  </Pressable>
                ) : st === "sent" ? (
                  <View style={[styles.pillGhost, { borderColor: colors.success }]}>
                    <Icon name="check" size={14} color={colors.success} />
                    <Text style={[styles.pillGhostTxt, { color: colors.success }]}>OFFERED</Text>
                  </View>
                ) : (
                  <Pressable
                    testID={`add-${item.id}`}
                    onPress={() => addFriend(item)}
                    disabled={st === "sending"}
                    style={[styles.pill, st === "error" && { backgroundColor: colors.error }]}
                  >
                    {st === "sending" ? (
                      <ActivityIndicator color={colors.onBrandPrimary} size="small" />
                    ) : (
                      <>
                        <Icon name="account-plus" size={14} color={colors.onBrandPrimary} />
                        <Text style={styles.pillTxt}>{st === "error" ? "RETRY" : "ADD"}</Text>
                      </>
                    )}
                  </Pressable>
                )}
              </View>
            );
          }}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingBottom: 8 },
  backBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { color: c.brandPrimary, fontFamily: displayFont, fontSize: 18, letterSpacing: 4, fontWeight: "700" },
  subtitle: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 2 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 4,
    backgroundColor: c.surfaceSecondary,
  },
  search: { flex: 1, minHeight: 44, color: c.onSurface, fontFamily: monoFont, fontSize: 14 },
  error: { color: c.error, fontFamily: monoFont, fontSize: 11, paddingHorizontal: 16, paddingBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  name: { color: c.onSurface, fontFamily: monoFont, fontSize: 14 },
  meta: { color: c.muted, fontFamily: monoFont, fontSize: 10, marginTop: 2, letterSpacing: 1 },
  divider: { height: 1, backgroundColor: c.divider },
  empty: { padding: 40, alignItems: "center" },
  emptyTxt: { color: c.muted, fontFamily: monoFont, textAlign: "center" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    minWidth: 76,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: 4,
    backgroundColor: c.brandPrimary,
  },
  pillTxt: { color: c.onBrandPrimary, fontFamily: monoFont, fontSize: 11, letterSpacing: 2, fontWeight: "700" },
  pillGhost: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: 4,
    borderWidth: 1,
    borderColor: c.brandPrimary,
    backgroundColor: c.surfaceSecondary,
  },
  pillGhostTxt: { color: c.brandPrimary, fontFamily: monoFont, fontSize: 11, letterSpacing: 2 },
}));
