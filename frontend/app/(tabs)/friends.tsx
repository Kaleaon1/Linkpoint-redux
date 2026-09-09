import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";

import { api, loadSession, type Session, type Friend, type CircuitStatus } from "@/src/api";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

const PRESENCE_POLL_MS = 30000;

export default function FriendsScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [status, setStatus] = useState<CircuitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [filter, setFilter] = useState<"all" | "online">("all");
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const load = useCallback(async (s?: Session | null, silent = false) => {
    const sess = s ?? sessionRef.current ?? (await loadSession());
    if (!sess) return;
    sessionRef.current = sess;
    setSession(sess);
    if (!silent) setLoading(true);
    try {
      const [list, st] = await Promise.all([
        api.get<Friend[]>(`/friends?session_id=${sess.session_id}`),
        api.get<CircuitStatus>(`/status?session_id=${sess.session_id}`).catch(() => null),
      ]);
      setFriends(list);
      if (st) setStatus(st);
      setLastSync(new Date());
    } catch {
      // keep last good list
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const refreshNames = async () => {
    if (!session || session.mode !== "grid") return;
    setResolving(true);
    try {
      await api.post(`/friends/refresh_names?session_id=${session.session_id}`, {});
      await load(session);
    } catch {
      // silent - endpoint reports 502 when cap unavailable
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  // Presence: the sim pushes Online/OfflineNotification to the backend circuit;
  // we re-pull the roster every 30s while this tab is focused.
  useFocusEffect(
    useCallback(() => {
      load(undefined, true);
      const t = setInterval(() => load(undefined, true), PRESENCE_POLL_MS);
      return () => clearInterval(t);
    }, [load]),
  );

  const online = friends.filter((f) => f.online).length;
  const data = filter === "online" ? friends.filter((f) => f.online) : friends;
  const connected = status?.connected ?? false;
  const syncLabel = lastSync ? lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>FRIENDS</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {"> " + online + " online / " + friends.length + " total · " + (status ? (connected ? "live" : "no link") : "...") + " · sync " + syncLabel}
          </Text>
        </View>
        <Pressable testID="open-search" onPress={() => router.push("/search")} style={styles.iconBtn} hitSlop={8}>
          <Icon name="account-plus-outline" size={20} color={colors.brandPrimary} />
        </Pressable>
        {session?.mode === "grid" ? (
          <Pressable
            testID="refresh-names"
            onPress={refreshNames}
            disabled={resolving}
            style={styles.iconBtn}
            hitSlop={8}
          >
            {resolving ? (
              <ActivityIndicator color={colors.brandPrimary} size="small" />
            ) : (
              <Icon name="account-search-outline" size={20} color={colors.brandPrimary} />
            )}
          </Pressable>
        ) : null}
      </View>

      <View style={styles.segment}>
        <Pressable
          testID="filter-all"
          onPress={() => setFilter("all")}
          style={[styles.segBtn, filter === "all" && styles.segBtnActive]}
        >
          <Text style={[styles.segTxt, filter === "all" && styles.segTxtActive]}>ALL</Text>
        </Pressable>
        <Pressable
          testID="filter-online"
          onPress={() => setFilter("online")}
          style={[styles.segBtn, filter === "online" && styles.segBtnActive]}
        >
          <Text style={[styles.segTxt, filter === "online" && styles.segTxtActive]}>ONLINE</Text>
        </Pressable>
      </View>

      <FlatList
        testID="friends-list"
        data={data}
        keyExtractor={(f) => f.id}
        refreshControl={
          <RefreshControl
            tintColor={colors.brandPrimary}
            refreshing={loading}
            onRefresh={() => load(session)}
          />
        }
        ItemSeparatorComponent={() => <View style={styles.divider} />}
        ListEmptyComponent={
          loading ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.brandPrimary} />
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTxt}>{"> friends list empty"}</Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`friend-${item.id}`}
            style={styles.row}
            onPress={() => router.push({ pathname: "/(tabs)/chat", params: { im: item.id, name: item.name } })}
          >
            <View style={[styles.dot, { backgroundColor: item.online ? colors.success : colors.muted }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.meta}>
                {item.online ? "ONLINE" : "OFFLINE"} · id {item.id.slice(0, 8)}
              </Text>
            </View>
            <View style={styles.rights}>
              {item.can_see_me_online && <Icon name="eye" size={14} color={colors.brandSecondary} />}
              {item.can_see_me_map && <Icon name="map-marker" size={14} color={colors.brandSecondary} />}
              {item.can_modify_my_objects && <Icon name="pencil" size={14} color={colors.brandSecondary} />}
            </View>
            <Icon name="message-text-outline" size={20} color={colors.brandPrimary} />
          </Pressable>
        )}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceSecondary,
  },
  title: { color: c.brandPrimary, fontFamily: displayFont, fontSize: 22, letterSpacing: 6, fontWeight: "700" },
  subtitle: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 2 },
  segment: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    overflow: "hidden",
  },
  segBtn: { flex: 1, paddingVertical: 10, alignItems: "center", backgroundColor: c.surfaceSecondary },
  segBtnActive: { backgroundColor: c.brandTertiary, borderBottomWidth: 2, borderBottomColor: c.brandPrimary },
  segTxt: { color: c.muted, fontFamily: monoFont, fontSize: 12, letterSpacing: 3 },
  segTxtActive: { color: c.brandPrimary },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    backgroundColor: c.surface,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { color: c.onSurface, fontFamily: monoFont, fontSize: 14 },
  meta: { color: c.muted, fontFamily: monoFont, fontSize: 10, marginTop: 2, letterSpacing: 1 },
  rights: { flexDirection: "row", gap: 4, marginRight: 4 },
  divider: { height: 1, backgroundColor: c.divider },
  empty: { padding: 40, alignItems: "center" },
  emptyTxt: { color: c.muted, fontFamily: monoFont },
}));
