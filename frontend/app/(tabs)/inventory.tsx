import { useEffect, useMemo, useState } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import * as Haptics from "expo-haptics";

import { api, loadSession, type Session } from "@/src/api";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  type: string;
  version: number;
};

const ICON: Record<string, string> = {
  textures: "image-outline",
  texture: "image-outline",
  objects: "cube-outline",
  object: "cube-outline",
  clothing: "tshirt-crew-outline",
  body_parts: "human-handsup",
  scripts: "script-text-outline",
  script: "script-text-outline",
  notecards: "note-outline",
  notecard: "note-outline",
  landmarks: "map-marker-outline",
  landmark: "map-marker-outline",
  sounds: "music-note-outline",
  sound: "music-note-outline",
  animations: "run",
  animation: "run",
  gestures: "hand-wave",
  gesture: "hand-wave",
  trash: "trash-can-outline",
  root: "folder-star-outline",
};

export default function InventoryScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const [session, setSession] = useState<Session | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const load = async (s?: Session | null) => {
    const sess = s ?? (await loadSession());
    if (!sess) return;
    setSession(sess);
    setLoading(true);
    try {
      const list = await api.get<Folder[]>(`/inventory?session_id=${sess.session_id}`);
      setFolders(list);
      const roots = list.filter((f) => !f.parent_id).map((f) => f.id);
      const init: Record<string, boolean> = {};
      roots.forEach((r) => (init[r] = true));
      setExpanded(init);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: load inventory once on mount
    load();
  }, []);

  // Build a flat rendered list respecting expansion
  const flat = useMemo(() => {
    const byParent = new Map<string | null, Folder[]>();
    folders.forEach((f) => {
      const key = f.parent_id ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(f);
    });
    byParent.forEach((arr) => arr.sort((a, b) => a.name.localeCompare(b.name)));

    const out: (Folder & { depth: number; hasChildren: boolean; isOpen: boolean })[] = [];
    const walk = (parent: string | null, depth: number) => {
      const children = byParent.get(parent) ?? [];
      for (const c of children) {
        const hasChildren = (byParent.get(c.id) ?? []).length > 0;
        const isOpen = !!expanded[c.id];
        out.push({ ...c, depth, hasChildren, isOpen });
        if (isOpen && hasChildren) walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders, expanded]);

  const toggle = (id: string) => {
    Haptics.selectionAsync().catch(() => {});
    setExpanded((e) => ({ ...e, [id]: !e[id] }));
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>INVENTORY</Text>
        <Text style={styles.subtitle}>
          {"> " + folders.length + " folders · " + (session?.avatar_name ?? "")}
        </Text>
      </View>

      <FlatList
        testID="inventory-list"
        data={flat}
        keyExtractor={(f) => f.id}
        refreshControl={
          <RefreshControl tintColor={colors.brandPrimary} refreshing={loading} onRefresh={() => load(session)} />
        }
        ItemSeparatorComponent={() => <View style={styles.divider} />}
        ListEmptyComponent={
          loading ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.brandPrimary} />
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTxt}>{"> inventory empty"}</Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const iconName = ICON[item.type.toLowerCase()] ?? "folder-outline";
          return (
            <Pressable
              testID={`folder-${item.id}`}
              onPress={() => item.hasChildren && toggle(item.id)}
              style={[styles.row, { paddingLeft: 16 + item.depth * 18 }]}
            >
              <Icon
                name={item.hasChildren ? (item.isOpen ? "chevron-down" : "chevron-right") : "circle-small"}
                size={18}
                color={item.hasChildren ? colors.brandPrimary : colors.muted}
              />
              <Icon name={iconName as any} size={18} color={colors.brandSecondary} />
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.meta}>v{item.version}</Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  title: { color: c.brandPrimary, fontFamily: displayFont, fontSize: 22, letterSpacing: 6, fontWeight: "700" },
  subtitle: { color: c.muted, fontFamily: monoFont, fontSize: 11, marginTop: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 16,
    paddingVertical: 10,
    gap: 8,
  },
  name: { color: c.onSurface, fontFamily: monoFont, fontSize: 13, flex: 1 },
  meta: { color: c.muted, fontFamily: monoFont, fontSize: 10 },
  divider: { height: 1, backgroundColor: c.divider },
  empty: { padding: 40, alignItems: "center" },
  emptyTxt: { color: c.muted, fontFamily: monoFont },
}));
