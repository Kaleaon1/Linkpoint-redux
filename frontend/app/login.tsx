import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";

import { api, saveSession, type Session } from "@/src/api";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

type Mode = "grid" | "offline";

const HERO =
  "https://images.unsplash.com/photo-1773429494448-1c13750ad80d?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjAzMzl8MHwxfHNlYXJjaHwxfHxkYXJrJTIwY3liZXJwdW5rJTIwbmV0d29yayUyMGdyaWR8ZW58MHx8fHwxNzg4OTYxNjQ5fDA&ixlib=rb-4.1.0&q=85";

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const [mode, setMode] = useState<Mode>("grid");
  const [grid, setGrid] = useState<"agni" | "aditi">("agni");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("Resident");
  const [password, setPassword] = useState("");
  const [avatarName, setAvatarName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      let resp: any;
      if (mode === "grid") {
        if (!first.trim() || !password) throw new Error("First name and password required");
        resp = await api.post("/login/grid", {
          first: first.trim(),
          last: last.trim() || "Resident",
          password,
          grid,
          start: "last",
          agree_to_tos: true,
        });
      } else {
        if (!avatarName.trim()) throw new Error("Enter an avatar name");
        resp = await api.post("/login/offline", { avatar_name: avatarName.trim() });
      }
      const s: Session = {
        session_id: resp.session_id,
        mode: resp.mode,
        grid: resp.grid,
        avatar_name: resp.avatar_name,
        agent_id: resp.agent_id,
        region: resp.region,
        login_message: resp.login_message,
      };
      await saveSession(s);
      router.replace("/(tabs)/chat");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <Image source={HERO} style={styles.hero} contentFit="cover" />
      <LinearGradient
        colors={["rgba(5,8,16,0.2)", "rgba(5,8,16,0.85)", "#050810"]}
        locations={[0, 0.55, 1]}
        style={styles.scrim}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}
        >
          <View style={styles.header}>
            <View style={styles.brandRow}>
              <Icon name="hexagon-multiple-outline" size={24} color={colors.brandPrimary} />
              <Text style={styles.brand}>GRIDLINK</Text>
            </View>
            <Text style={styles.tag}>SECONDLIFE COMMUNICATOR // v1.0.0</Text>
          </View>

          <View style={styles.card}>
            <View style={styles.segment}>
              <SegBtn label="GRID LOGIN" active={mode === "grid"} onPress={() => setMode("grid")} testID="mode-grid" />
              <SegBtn label="OFFLINE" active={mode === "offline"} onPress={() => setMode("offline")} testID="mode-offline" />
            </View>

            {mode === "grid" ? (
              <>
                <Text style={styles.label}>GRID</Text>
                <View style={styles.gridRow}>
                  <GridBtn label="Agni (Main)" active={grid === "agni"} onPress={() => setGrid("agni")} testID="grid-agni" />
                  <GridBtn label="Aditi (Beta)" active={grid === "aditi"} onPress={() => setGrid("aditi")} testID="grid-aditi" />
                </View>

                <Text style={styles.label}>AVATAR NAME</Text>
                <View style={styles.nameRow}>
                  <TextInput
                    testID="input-first"
                    value={first}
                    onChangeText={setFirst}
                    placeholder="First"
                    placeholderTextColor={colors.muted}
                    autoCapitalize="words"
                    style={[styles.input, { flex: 1 }]}
                  />
                  <TextInput
                    testID="input-last"
                    value={last}
                    onChangeText={setLast}
                    placeholder="Last"
                    placeholderTextColor={colors.muted}
                    autoCapitalize="words"
                    style={[styles.input, { flex: 1 }]}
                  />
                </View>

                <Text style={styles.label}>PASSWORD</Text>
                <TextInput
                  testID="input-password"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  placeholderTextColor={colors.muted}
                  secureTextEntry
                  style={styles.input}
                />
              </>
            ) : (
              <>
                <Text style={styles.label}>AVATAR NAME</Text>
                <TextInput
                  testID="input-avatar-name"
                  value={avatarName}
                  onChangeText={setAvatarName}
                  placeholder="e.g. Ruth Resident"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="words"
                  style={styles.input}
                />
                <Text style={styles.hint}>
                  {"> Offline mode: no grid connection, chat stays local."}
                </Text>
              </>
            )}

            {error ? (
              <Text testID="login-error" style={styles.error}>
                {"> " + error}
              </Text>
            ) : null}

            <Pressable
              testID="connect-button"
              onPress={connect}
              disabled={busy}
              style={({ pressed }) => [
                styles.cta,
                (pressed || busy) && { opacity: 0.7 },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.onBrandPrimary} />
              ) : (
                <>
                  <Icon name="power-plug" size={18} color={colors.onBrandPrimary} />
                  <Text style={styles.ctaText}>{mode === "grid" ? "CONNECT TO GRID" : "ENTER OFFLINE"}</Text>
                </>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function SegBtn({ label, active, onPress, testID }: any) {
  const styles = useStyles();
  return (
    <Pressable onPress={onPress} testID={testID} style={[styles.segBtn, active && styles.segBtnActive]}>
      <Text style={[styles.segTxt, active && styles.segTxtActive]}>{label}</Text>
    </Pressable>
  );
}

function GridBtn({ label, active, onPress, testID }: any) {
  const styles = useStyles();
  return (
    <Pressable onPress={onPress} testID={testID} style={[styles.gridBtn, active && styles.gridBtnActive]}>
      <Text style={[styles.gridBtnTxt, active && styles.gridBtnTxtActive]}>{label}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  hero: { position: "absolute", top: 0, left: 0, right: 0, height: 380 },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, height: 500 },
  scroll: { paddingHorizontal: 16 },
  header: { marginBottom: 24 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  brand: {
    color: c.brandPrimary,
    fontSize: 28,
    fontFamily: displayFont,
    letterSpacing: 6,
    fontWeight: "700",
  },
  tag: {
    color: c.muted,
    marginTop: 4,
    fontFamily: monoFont,
    fontSize: 11,
    letterSpacing: 2,
  },
  card: {
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    padding: 16,
    marginTop: 12,
    gap: 8,
  },
  segment: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  segBtn: { flex: 1, paddingVertical: 10, alignItems: "center", backgroundColor: c.surfaceTertiary },
  segBtnActive: { backgroundColor: c.brandTertiary, borderBottomWidth: 2, borderBottomColor: c.brandPrimary },
  segTxt: { color: c.muted, fontFamily: monoFont, fontSize: 12, letterSpacing: 2 },
  segTxtActive: { color: c.brandPrimary },
  label: { color: c.brandPrimary, fontFamily: monoFont, fontSize: 11, letterSpacing: 2, marginTop: 8 },
  gridRow: { flexDirection: "row", gap: 8 },
  gridBtn: {
    flex: 1,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    alignItems: "center",
    backgroundColor: c.surfaceTertiary,
  },
  gridBtnActive: { borderColor: c.brandPrimary, backgroundColor: c.brandTertiary },
  gridBtnTxt: { color: c.onSurfaceSecondary, fontFamily: monoFont, fontSize: 12 },
  gridBtnTxtActive: { color: c.brandPrimary },
  nameRow: { flexDirection: "row", gap: 8 },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    color: c.onSurface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 4,
    fontFamily: monoFont,
    fontSize: 14,
  },
  hint: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 4 },
  error: {
    color: c.error,
    fontFamily: monoFont,
    fontSize: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: c.error,
    padding: 8,
    borderRadius: 4,
  },
  cta: {
    marginTop: 16,
    backgroundColor: c.brandPrimary,
    borderRadius: 4,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  ctaText: {
    color: c.onBrandPrimary,
    fontFamily: monoFont,
    fontSize: 13,
    letterSpacing: 3,
    fontWeight: "700",
  },
}));
