import { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";

import { api } from "@/src/api";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

type Diag = {
  grid: string;
  login_uri: string;
  dns_ok: boolean;
  dns_ms: number;
  reachable: boolean;
  tls_ms: number;
  latency_ms: number | null;
  server_time: string | null;
  viewer_channel: string;
  viewer_version: string;
  error: string | null;
};

export default function DiagnosticsScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const router = useRouter();
  const [grid, setGrid] = useState<"agni" | "aditi">("agni");
  const [data, setData] = useState<Diag | null>(null);
  const [loading, setLoading] = useState(true);

  const run = async (g: "agni" | "aditi" = grid) => {
    setLoading(true);
    try {
      const d = await api.get<Diag>(`/diagnostics?grid=${g}`);
      setData(d);
    } catch (e: any) {
      setData({
        grid: g,
        login_uri: "-",
        dns_ok: false,
        dns_ms: 0,
        reachable: false,
        tls_ms: 0,
        latency_ms: null,
        server_time: null,
        viewer_channel: "-",
        viewer_version: "-",
        error: String(e?.message ?? e),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: re-probe whenever the selected grid changes
    run(grid);
  }, [grid]);

  const latencyColor =
    data?.latency_ms == null
      ? colors.muted
      : data.latency_ms < 100
      ? colors.success
      : data.latency_ms < 300
      ? colors.warning
      : colors.error;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable testID="diag-back" onPress={() => router.back()} hitSlop={8}>
          <Icon name="chevron-left" size={26} color={colors.brandPrimary} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>DIAGNOSTICS</Text>
          <Text style={styles.subtitle}>{"> grid connectivity probe"}</Text>
        </View>
        <Pressable testID="diag-refresh" onPress={() => run(grid)} hitSlop={8}>
          <Icon name="refresh" size={22} color={colors.brandPrimary} />
        </Pressable>
      </View>

      <View style={styles.segment}>
        <Pressable testID="diag-agni" onPress={() => setGrid("agni")} style={[styles.segBtn, grid === "agni" && styles.segBtnActive]}>
          <Text style={[styles.segTxt, grid === "agni" && styles.segTxtActive]}>AGNI</Text>
        </Pressable>
        <Pressable testID="diag-aditi" onPress={() => setGrid("aditi")} style={[styles.segBtn, grid === "aditi" && styles.segBtnActive]}>
          <Text style={[styles.segTxt, grid === "aditi" && styles.segTxtActive]}>ADITI</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        {loading ? (
          <View style={{ paddingVertical: 40, alignItems: "center" }}>
            <ActivityIndicator color={colors.brandPrimary} />
            <Text style={styles.hint}>{"> probing " + grid + "..."}</Text>
          </View>
        ) : data ? (
          <>
            <View style={styles.gauge}>
              <Text style={styles.gaugeLabel}>LATENCY</Text>
              <Text style={[styles.gaugeValue, { color: latencyColor }]}>
                {data.latency_ms != null ? `${data.latency_ms}` : "--"}
                <Text style={styles.gaugeUnit}> ms</Text>
              </Text>
              <Text style={styles.hint}>
                {data.latency_ms == null
                  ? "> no round-trip data"
                  : data.latency_ms < 100
                  ? "> excellent"
                  : data.latency_ms < 300
                  ? "> acceptable"
                  : "> degraded"}
              </Text>
            </View>

            <View style={styles.grid2}>
              <Metric label="DNS" value={data.dns_ok ? "OK" : "FAIL"} sub={`${data.dns_ms} ms`} ok={data.dns_ok} />
              <Metric label="TCP/TLS" value={data.reachable ? "OK" : "FAIL"} sub={`${data.tls_ms} ms`} ok={data.reachable} />
            </View>

            <View style={styles.card}>
              <Text style={styles.cardLabel}>ENDPOINT</Text>
              <KV k="grid" v={data.grid} />
              <KV k="uri" v={data.login_uri} />
              <KV k="viewer" v={`${data.viewer_channel} ${data.viewer_version}`} />
              <KV k="server_time" v={data.server_time ?? "-"} />
            </View>

            {data.error ? (
              <View style={styles.errBox}>
                <Text style={styles.errTxt}>{"! " + data.error}</Text>
              </View>
            ) : (
              <View style={styles.okBox}>
                <Text style={styles.okTxt}>{"> handshake reachable, credentials not tested"}</Text>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Metric({ label, value, sub, ok }: { label: string; value: string; sub: string; ok: boolean }) {
  const styles = useStyles();
  return (
    <View style={[styles.metric, ok ? { borderColor: colors.success } : { borderColor: colors.error }]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color: ok ? colors.success : colors.error }]}>{value}</Text>
      <Text style={styles.metricSub}>{sub}</Text>
    </View>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  const styles = useStyles();
  return (
    <View style={styles.kv}>
      <Text style={styles.kvK}>{k}</Text>
      <Text style={styles.kvV} numberOfLines={2}>{v}</Text>
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
    paddingTop: 8,
    paddingBottom: 8,
  },
  title: { color: c.brandPrimary, fontFamily: displayFont, fontSize: 20, letterSpacing: 5, fontWeight: "700" },
  subtitle: { color: c.muted, fontFamily: monoFont, fontSize: 11 },
  segment: {
    flexDirection: "row",
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 12,
  },
  segBtn: { flex: 1, paddingVertical: 10, alignItems: "center", backgroundColor: c.surfaceSecondary },
  segBtnActive: { backgroundColor: c.brandTertiary, borderBottomWidth: 2, borderBottomColor: c.brandPrimary },
  segTxt: { color: c.muted, fontFamily: monoFont, fontSize: 12, letterSpacing: 3 },
  segTxtActive: { color: c.brandPrimary },
  body: { paddingHorizontal: 16, gap: 16 },
  gauge: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    padding: 20,
    backgroundColor: c.surfaceSecondary,
    alignItems: "center",
  },
  gaugeLabel: { color: c.brandPrimary, fontFamily: monoFont, fontSize: 11, letterSpacing: 3 },
  gaugeValue: { fontFamily: monoFont, fontSize: 56, fontWeight: "700", marginTop: 4 },
  gaugeUnit: { fontSize: 20, color: c.muted },
  hint: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 4 },
  grid2: { flexDirection: "row", gap: 12 },
  metric: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 4,
    padding: 16,
    backgroundColor: c.surfaceSecondary,
  },
  metricLabel: { color: c.muted, fontFamily: monoFont, fontSize: 10, letterSpacing: 2 },
  metricValue: { fontFamily: monoFont, fontSize: 22, fontWeight: "700", marginTop: 4 },
  metricSub: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 2 },
  card: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    backgroundColor: c.surfaceSecondary,
    padding: 12,
    gap: 4,
  },
  cardLabel: { color: c.brandPrimary, fontFamily: monoFont, fontSize: 11, letterSpacing: 3, marginBottom: 4 },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  kvK: { color: c.muted, fontFamily: monoFont, fontSize: 12 },
  kvV: { color: c.onSurfaceSecondary, fontFamily: monoFont, fontSize: 11, marginLeft: 12, maxWidth: "65%", textAlign: "right" },
  errBox: { borderWidth: 1, borderColor: c.error, padding: 12, borderRadius: 4 },
  errTxt: { color: c.error, fontFamily: monoFont, fontSize: 12 },
  okBox: { borderWidth: 1, borderColor: c.success, padding: 12, borderRadius: 4 },
  okTxt: { color: c.success, fontFamily: monoFont, fontSize: 12 },
}));
