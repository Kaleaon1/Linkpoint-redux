import { View, Text, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import { useEffect, useState } from "react";

import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";
import { loadSession, type Session } from "@/src/api";

// Static demo radar with a handful of nearby avatars derived from the session.
const NEARBY = [
  { name: "Ruth Resident", distance: 4, bearing: "N" },
  { name: "Governor Linden", distance: 12, bearing: "NE" },
  { name: "Torley Linden", distance: 18, bearing: "E" },
  { name: "Magnum Resident", distance: 27, bearing: "SW" },
  { name: "Philip Linden", distance: 42, bearing: "W" },
];

export default function RadarScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    loadSession().then(setSession);
  }, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Icon name="chevron-left" size={26} color={colors.brandPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>RADAR</Text>
          <Text style={styles.subtitle}>{`> ${NEARBY.length} avatars within 50m`}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>REGION</Text>
          <Text style={styles.value}>
            {session?.region ? `sim ${session.region}` : "GridLink Sandbox"}
          </Text>
        </View>

        {NEARBY.map((a) => (
          <View key={a.name} style={styles.row}>
            <Icon name="account-circle-outline" size={22} color={colors.brandPrimary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{a.name}</Text>
              <Text style={styles.meta}>{`bearing ${a.bearing} · ${a.distance}m`}</Text>
            </View>
            <View style={styles.dist}>
              <Text style={styles.distTxt}>{a.distance}m</Text>
            </View>
          </View>
        ))}
      </ScrollView>
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
  body: { padding: 16, gap: 8 },
  card: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    padding: 12,
    backgroundColor: c.surfaceSecondary,
    marginBottom: 8,
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
