import { View, Text, Pressable, FlatList, ActivityIndicator, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import { useCallback, useEffect, useRef, useState } from "react";

import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";
import { api, loadSession, type Session, type RadarResponse, type RadarAvatar } from "@/src/api";

const POLL_MS = 5000;
const NEAR_M = 20; // SL chat range
const SHOUT_M = 100;

function bearing(from: number[] | null, a: RadarAvatar): string {
  if (!from) return "--";
  const dx = a.x - from[0];
  const dy = a.y - from[1];
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return "here";
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI; // 0 = north (+y)
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(((deg + 360) % 360) / 45) % 8];
}

export default function RadarScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [radar, setRadar] = useState<RadarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const load = useCallback(async (silent = true) => {
    const s = sessionRef.current ?? (await loadSession());
    if (!s) return;
    sessionRef.current = s;
    setSession(s);
    if (!silent) setLoading(true);
    try {
      setRadar(await api.get<RadarResponse>(`/radar?session_id=${s.session_id}`));
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "radar unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const avatars = radar?.avatars ?? [];
  const inChat = avatars.filter((a) => a.distance != null && a.distance <= NEAR_M).length;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable testID="radar-back" onPress={() => router.back()} hitSlop={8}>
          <Icon name="chevron-left" size={26} color={colors.brandPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>RADAR</Text>
          <Text style={styles.subtitle} testID="radar-subtitle">
            {radar
              ? radar.connected
                ? `> ${avatars.length} avatars in region · ${inChat} in chat range`
                : "> no sim link - reconnect from Chat"
              : "> scanning..."}
          </Text>
        </View>
        {loading ? <ActivityIndicator color={colors.brandPrimary} size="small" /> : null}
      </View>

      <FlatList
        testID="radar-list"
        data={avatars}
        keyExtractor={(a) => a.id}
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl tintColor={colors.brandPrimary} refreshing={false} onRefresh={() => load(true)} />}
        ListHeaderComponent={
          <View style={styles.card}>
            <Text style={styles.cardLabel}>REGION</Text>
            <Text style={styles.value}>{radar?.region_name ?? (session?.region ? `sim ${session.region}` : "--")}</Text>
            <Text style={styles.meta}>
              {radar?.my_position
                ? `you @ <${radar.my_position.map((n) => Math.round(n)).join(", ")}> · updated ${radar.updated_ago_s ?? 0}s ago`
                : "position unknown"}
            </Text>
            {error ? <Text style={[styles.meta, { color: colors.error }]}>{`> ${error}`}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          !loading ? (
            <View style={styles.card}>
              <Text style={styles.meta}>{radar?.connected ? "> nobody else in this region" : "> radar needs a live sim link"}</Text>
            </View>
          ) : null
        }
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        renderItem={({ item: a }) => {
          const d = a.distance;
          const tone = d == null ? colors.muted : d <= NEAR_M ? colors.success : d <= SHOUT_M ? colors.warning : colors.brandPrimary;
          return (
            <Pressable
              testID={`radar-${a.id}`}
              style={styles.row}
              onPress={() => router.replace({ pathname: "/(tabs)/chat", params: { im: a.id, name: a.name } })}
            >
              <Icon name={a.is_friend ? "account-heart-outline" : "account-circle-outline"} size={22} color={a.is_friend ? colors.brandSecondary : colors.brandPrimary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>{a.name}</Text>
                <Text style={styles.meta}>{`bearing ${bearing(radar?.my_position ?? null, a)} · <${Math.round(a.x)}, ${Math.round(a.y)}, ${Math.round(a.z)}>${a.is_friend ? " · friend" : ""}`}</Text>
              </View>
              <View style={[styles.dist, { borderColor: tone }]}>
                <Text style={[styles.distTxt, { color: tone }]}>{d == null ? "?" : `${Math.round(d)}m`}</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  title: { color: c.brandPrimary, fontFamily: displayFont, fontSize: 20, letterSpacing: 5, fontWeight: "700" },
  subtitle: { color: c.muted, fontFamily: monoFont, fontSize: 11 },
  body: { padding: 16, paddingBottom: 32 },
  card: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    padding: 12,
    backgroundColor: c.surfaceSecondary,
    marginBottom: 8,
    gap: 2,
  },
  cardLabel: { color: c.brandPrimary, fontFamily: monoFont, fontSize: 11, letterSpacing: 3 },
  value: { color: c.onSurface, fontFamily: monoFont, fontSize: 14, marginTop: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    backgroundColor: c.surfaceSecondary,
  },
  name: { color: c.onSurface, fontFamily: monoFont, fontSize: 14 },
  meta: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 2 },
  dist: {
    borderWidth: 1,
    borderColor: c.brandPrimary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  distTxt: { color: c.brandPrimary, fontFamily: monoFont, fontSize: 11 },
}));
