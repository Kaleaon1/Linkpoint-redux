import { useEffect, useState } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";

import { api, loadSession, type Session } from "@/src/api";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

type Friend = {
  id: string;
  name: string;
  online: boolean;
  can_see_me_online: boolean;
  can_see_me_map: boolean;
  can_modify_my_objects: boolean;
};

export default function FriendsScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "online">("all");

  const load = async (s?: Session | null) => {
    const sess = s ?? (await loadSession());
    if (!sess) return;
    setSession(sess);
    setLoading(true);
    try {
      const list = await api.get<Friend[]>(`/friends?session_id=${sess.session_id}`);
      setFriends(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const online = friends.filter((f) => f.online).length;
  const data = filter === "online" ? friends.filter((f) => f.online) : friends;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>FRIENDS</Text>
        <Text style={styles.subtitle}>
          {"> " + online + " online / " + friends.length + " total"}
        </Text>
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
            onPress={() => router.push("/(tabs)/chat")}
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
            <Icon name="chevron-right" size={20} color={colors.brandPrimary} />
          </Pressable>
        )}
      />
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
