import { useMemo, useState } from "react";
import { Modal, View, Text, TextInput, Pressable, FlatList } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";

import type { ScopeTarget } from "@/src/api";
import { colors, makeStyles, monoFont, displayFont } from "@/src/theme";

type Props = {
  visible: boolean;
  title: string;
  targets: ScopeTarget[];
  selected?: string;
  onSelect: (t: ScopeTarget) => void;
  onClose: () => void;
};

/** Full-height searchable picker for IM peers / groups (chip row only shows a few). */
export function ScopePicker({ visible, title, targets, selected, onSelect, onClose }: Props) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");

  const data = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? targets.filter((t) => t.name.toLowerCase().includes(needle)) : targets;
  }, [q, targets]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable testID="picker-close" onPress={onClose} hitSlop={12} style={styles.closeBtn}>
            <Icon name="close" size={22} color={colors.brandPrimary} />
          </Pressable>
        </View>
        <View style={styles.searchRow}>
          <Icon name="magnify" size={18} color={colors.muted} />
          <TextInput
            testID="picker-search"
            value={q}
            onChangeText={setQ}
            placeholder={`filter ${targets.length}...`}
            placeholderTextColor={colors.muted}
            style={styles.search}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>
        <FlatList
          data={data}
          keyExtractor={(t) => t.id}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTxt}>{"> nothing matches"}</Text>
            </View>
          }
          renderItem={({ item }) => {
            const active = item.id === selected;
            return (
              <Pressable
                testID={`picker-item-${item.id}`}
                onPress={() => {
                  onSelect(item);
                  onClose();
                }}
                style={[styles.row, active && styles.rowActive]}
              >
                {item.kind === "im" ? (
                  <View style={[styles.dot, { backgroundColor: item.online ? colors.success : colors.muted }]} />
                ) : (
                  <Icon name="account-group" size={16} color={active ? colors.brandPrimary : colors.brandSecondary} />
                )}
                <Text style={[styles.name, active && { color: colors.brandPrimary }]} numberOfLines={1}>
                  {item.name}
                </Text>
                {active && <Icon name="check" size={18} color={colors.brandPrimary} />}
              </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 8 },
  title: { flex: 1, color: c.brandPrimary, fontFamily: displayFont, fontSize: 18, letterSpacing: 4, fontWeight: "700" },
  closeBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 4,
    backgroundColor: c.surfaceSecondary,
  },
  search: { flex: 1, minHeight: 44, color: c.onSurface, fontFamily: monoFont, fontSize: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  rowActive: { backgroundColor: c.brandTertiary },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { flex: 1, color: c.onSurface, fontFamily: monoFont, fontSize: 14 },
  divider: { height: 1, backgroundColor: c.divider },
  empty: { padding: 40, alignItems: "center" },
  emptyTxt: { color: c.muted, fontFamily: monoFont },
}));
