import { View, Text, Pressable, Switch, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import { useState } from "react";

import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const router = useRouter();
  const [notifications, setNotifications] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [monospaceChat, setMonospaceChat] = useState(true);
  const [autoAcceptFriends, setAutoAcceptFriends] = useState(false);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Icon name="chevron-left" size={26} color={colors.brandPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>SETTINGS</Text>
          <Text style={styles.subtitle}>{"> viewer preferences"}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Section title="CHAT">
          <Toggle
            label="Show timestamps"
            value={showTimestamps}
            onChange={setShowTimestamps}
            testID="toggle-timestamps"
          />
          <Toggle
            label="Force monospace chat"
            value={monospaceChat}
            onChange={setMonospaceChat}
            testID="toggle-monospace"
          />
        </Section>

        <Section title="NOTIFICATIONS">
          <Toggle
            label="Enable IM notifications"
            value={notifications}
            onChange={setNotifications}
            testID="toggle-notifications"
          />
        </Section>

        <Section title="FRIENDS">
          <Toggle
            label="Auto-accept friend requests"
            value={autoAcceptFriends}
            onChange={setAutoAcceptFriends}
            testID="toggle-auto-accept"
          />
        </Section>

        <View style={styles.footer}>
          <Text style={styles.footerTxt}>{"> GridLink Mobile 1.0.0"}</Text>
          <Text style={styles.footerTxt}>{"> viewer channel: GridLink Mobile"}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Toggle({ label, value, onChange, testID }: any) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onChange}
        thumbColor={value ? colors.brandPrimary : colors.muted}
        trackColor={{ true: colors.brandTertiary, false: colors.border }}
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
  body: { padding: 16, gap: 16 },
  section: {},
  sectionLabel: { color: c.brandPrimary, fontFamily: monoFont, fontSize: 11, letterSpacing: 3, marginBottom: 8 },
  sectionBody: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    backgroundColor: c.surfaceSecondary,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  rowLabel: { color: c.onSurface, fontFamily: monoFont, fontSize: 13 },
  footer: { marginTop: 24, alignItems: "center", gap: 4 },
  footerTxt: { color: c.muted, fontFamily: monoFont, fontSize: 11 },
}));
