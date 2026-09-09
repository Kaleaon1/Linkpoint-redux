import { useEffect } from "react";
import { View, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";

import { loadSession } from "@/src/api";
import { colors } from "@/src/theme";

export default function Index() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const s = await loadSession();
      if (s?.session_id) router.replace("/(tabs)/chat");
      else router.replace("/login");
    })();
  }, [router]);

  return (
    <View
      testID="boot-splash"
      style={{ flex: 1, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }}
    >
      <ActivityIndicator color={colors.brandPrimary} />
    </View>
  );
}
