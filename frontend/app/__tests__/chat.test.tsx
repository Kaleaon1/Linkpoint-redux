// Component test for the chat screen's link-status pill: given a session
// already in local storage, confirms it renders LINK for a (always-connected)
// offline session and RECONNECT for a grid session with stored credentials
// but no live circuit — the exact "app restarted" state described in
// src/sl/router.ts's status() and exercised at the router level in
// router.test.ts. This closes the loop with an automated check of the same
// UI a manual `expo start --web` tester would see.
import React from "react";
import { render, waitFor } from "@testing-library/react-native";

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useIsFocused: () => true,
}));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(() => Promise.resolve()) }));
jest.mock("@react-native-vector-icons/material-design-icons", () => () => null);
jest.mock("react-native-safe-area-context", () => {
  const mock = require("react-native-safe-area-context/jest/mock");
  return mock.default ?? mock;
});

import ChatScreen from "@/app/(tabs)/chat";
import { saveSession, type Session } from "@/src/api";
import { newId } from "@/src/sl/ids";
import { db, secureCreds } from "@/src/sl/local-db";

async function flush() {
  await new Promise((res) => setTimeout(res, 50));
}

describe("ChatScreen link-status pill", () => {
  test("shows LINK for an offline session (always connected)", async () => {
    const sessionId = newId();
    await db.sessions.insertOne({ session_id: sessionId, mode: "offline", grid: "offline", avatar_name: "Kaleaon" });
    const session: Session = { session_id: sessionId, mode: "offline", grid: "offline", avatar_name: "Kaleaon" };
    await saveSession(session);

    const { findByTestId, unmount } = render(<ChatScreen />);
    await flush();
    const pill = await findByTestId("link-status");
    await waitFor(() => expect(pill).toHaveTextContent("LINK"));
    unmount();
  });

  test("shows RECONNECT for a grid session with stored credentials but no live circuit", async () => {
    const sessionId = newId();
    await db.sessions.insertOne({ session_id: sessionId, mode: "grid", grid: "agni", avatar_name: "Kaleaon", agent_id: "1", caps: {} });
    await secureCreds.save(sessionId, { first: "Kaleaon", last: "Resident", passwd_hash: "x", grid: "agni", start: "last" });
    const session: Session = { session_id: sessionId, mode: "grid", grid: "agni", avatar_name: "Kaleaon" };
    await saveSession(session);

    const { findByTestId, unmount } = render(<ChatScreen />);
    await flush();
    const pill = await findByTestId("link-status");
    await waitFor(() => expect(pill).toHaveTextContent("RECONNECT"));
    unmount();
  });
});
