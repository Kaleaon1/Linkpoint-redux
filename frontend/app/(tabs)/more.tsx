import { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";

import { api, clearSession, loadSession, type Session, type CircuitStatus } from "@/src/api";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

export default function MoreScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<CircuitStatus | null>(null);

  useEffect(() => {
    loadSession().then((s) => {
      setSession(s);
      if (s) api.get<CircuitStatus>(`/status?session_id=${s.session_id}`).then(setStatus).catch(() => {});
    });
  }, []);

  const logout = async () => {
    if (session) {
      try {
        await fetch(`${process.env.EXPO_PUBLIC_BACKEND_URL}/api/logout?session_id=${session.session_id}`, { method: "POST" });
      } catch {}
    }
    await clearSession();
    router.replace("/login");
  };

  const rows: {
    key: string;
    icon: string;
    label: string;
    hint: string;
    onPress: () => void;
    testID: string;
    danger?: boolean;
  }[] = [
    {
      key: "diagnostics",
      icon: "pulse",
      label: "Grid Diagnostics",
      hint: "> ping login server, latency, DNS",
      onPress: () => router.push("/diagnostics"),
      testID: "row-diagnostics",
    },
    {
      key: "radar",
      icon: "radar",
      label: "Radar",
      hint: "> nearby avatars in region",
      onPress: () => router.push("/radar"),
      testID: "row-radar",
    },
    {
      key: "settings",
      icon: "tune-variant",
      label: "Settings",
      hint: "> viewer preferences",
      onPress: () => router.push("/settings"),
      testID: "row-settings",
    },
    {
      key: "logout",
      icon: "logout",
      label: "Disconnect",
      hint: "> end session",
      onPress: logout,
      testID: "row-logout",
      danger: true,
    },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface }}
      contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 12, paddingBottom: 24 }]}
    >
      <View style={styles.header}>
        <Text style={styles.title}>MORE</Text>
        <Text style={styles.subtitle}>{"> " + (session?.avatar_name ?? "no session")}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>SESSION</Text>
        <KV k="avatar" v={session?.avatar_name ?? "-"} />
        <KV k="mode" v={session?.mode ?? "-"} />
        <KV k="grid" v={session?.grid ?? "-"} />
        <KV k="region" v={status?.region_name ?? session?.region ?? "-"} />
        <KV k="agent_id" v={session?.agent_id?.slice(0, 12) ?? "-"} />
        <KV
          k="sim link"
          v={status ? (status.connected ? `LIVE · ${status.rx_packets ?? 0} rx / ${status.tx_packets ?? 0} tx` : status.error ?? "down") : "-"}
        />
        {session?.login_message ? (
          <Text style={styles.motd}>{"> " + session.login_message}</Text>
        ) : null}
      </View>

      <View style={styles.list}>
        {rows.map((r) => (
          <Pressable
            key={r.key}
            testID={r.testID}
            onPress={r.onPress}
            style={styles.row}
          >
            <View style={[styles.rowIcon, r.danger && { borderColor: colors.error }]}>
              <Icon name={r.icon as any} size={20} color={r.danger ? colors.error : colors.brandSecondary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, r.danger && { color: colors.error }]}>{r.label}</Text>
              <Text style={styles.rowHint}>{r.hint}</Text>
            </View>
            <Icon name="chevron-right" size={20} color={colors.brandPrimary} />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  const styles = useStyles();
  return (
    <View style={styles.kv}>
      <Text style={styles.kvK}>{k}</Text>
      <Text style={styles.kvV} numberOfLines={1}>{v}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  scroll: { paddingHorizontal: 16, gap: 16 },
  header: { marginBottom: 4 },
  title: { color: c.brandPrimary, fontFamily: displayFont, fontSize: 22, letterSpacing: 6, fontWeight: "700" },
  subtitle: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 2 },
  card: {
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceSecondary,
    borderRadius: 4,
    padding: 12,
    gap: 4,
  },
  cardLabel: {
    color: c.brandPrimary,
    fontFamily: monoFont,
    fontSize: 11,
    letterSpacing: 3,
    marginBottom: 4,
  },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  kvK: { color: c.muted, fontFamily: monoFont, fontSize: 12 },
  kvV: { color: c.onSurfaceSecondary, fontFamily: monoFont, fontSize: 12, marginLeft: 12, maxWidth: "60%" },
  motd: { color: c.warning, fontFamily: monoFont, fontSize: 11, marginTop: 6 },
  list: { borderWidth: 1, borderColor: c.border, borderRadius: 4, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    backgroundColor: c.surfaceSecondary,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surface,
  },
  rowLabel: { color: c.onSurface, fontFamily: monoFont, fontSize: 14 },
  rowHint: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 2 },
}));
