import { Tabs } from "expo-router";
import Icon from "@react-native-vector-icons/material-design-icons";
import { Platform } from "react-native";

import { colors, monoFont } from "@/src/theme";
import { useUnread } from "@/src/unread";

export default function TabsLayout() {
  const { total } = useUnread();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandPrimary,
        tabBarInactiveTintColor: colors.muted,
        tabBarBadgeStyle: { backgroundColor: colors.brandSecondary, color: colors.onBrandSecondary, fontFamily: monoFont, fontSize: 10 },
        tabBarStyle: {
          backgroundColor: colors.surfaceSecondary,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          ...(Platform.OS === "web" ? { height: 64 } : {}),
        },
        tabBarItemStyle: { alignSelf: "center" },
        tabBarLabelStyle: {
          fontFamily: monoFont,
          fontSize: 10,
          letterSpacing: 2,
        },
      }}
    >
      <Tabs.Screen
        name="chat"
        options={{
          title: "CHAT",
          tabBarBadge: total > 0 ? (total > 99 ? "99+" : total) : undefined,
          tabBarIcon: ({ color, size }) => <Icon name="chat-processing-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="friends"
        options={{
          title: "FRIENDS",
          tabBarIcon: ({ color, size }) => <Icon name="account-multiple-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="inventory"
        options={{
          title: "INV",
          tabBarIcon: ({ color, size }) => <Icon name="folder-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "MORE",
          tabBarIcon: ({ color, size }) => <Icon name="dots-grid" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
