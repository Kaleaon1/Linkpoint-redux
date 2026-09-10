// Component test for the login screen's offline path: fills in an avatar
// name, taps connect, and confirms it drives the real api.ts/router.ts/
// local-db.ts stack (a session gets saved) and navigates on success. Only
// visual/native-only dependencies are stubbed — the login flow itself is
// the genuine, unmocked implementation.
import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";

jest.mock("expo-router", () => {
  const replace = jest.fn();
  return { useRouter: () => ({ replace, push: jest.fn(), back: jest.fn() }), __mockReplace: replace };
});
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("@react-native-vector-icons/material-design-icons", () => () => null);
jest.mock("react-native-safe-area-context", () => {
  const mock = require("react-native-safe-area-context/jest/mock");
  return mock.default ?? mock;
});

import LoginScreen from "@/app/login";
import { loadSession } from "@/src/api";

// The mock module's __mockReplace export isn't part of expo-router's real
// type surface, so pull it out via require rather than a typed import.
const __mockReplace: jest.Mock = require("expo-router").__mockReplace;

beforeEach(() => {
  __mockReplace.mockClear();
});

describe("LoginScreen (offline mode)", () => {
  test("connecting offline saves a session and navigates to chat", async () => {
    const { getByTestId } = render(<LoginScreen />);

    fireEvent.press(getByTestId("mode-offline"));
    fireEvent.changeText(getByTestId("input-avatar-name"), "Kaleaon Resident");
    fireEvent.press(getByTestId("connect-button"));

    // Let the async connect() handler's awaited chain (api.post -> AsyncStorage
    // writes -> saveSession) settle before polling; waitFor alone stalled here.
    await new Promise((res) => setTimeout(res, 50));
    await waitFor(() => expect(__mockReplace).toHaveBeenCalledWith("/(tabs)/chat"));

    const session = await loadSession();
    expect(session).toMatchObject({ mode: "offline", avatar_name: "Kaleaon Resident" });
  });

  test("shows an error and does not navigate when the avatar name is blank", async () => {
    const { getByTestId, findByTestId } = render(<LoginScreen />);

    fireEvent.press(getByTestId("mode-offline"));
    fireEvent.press(getByTestId("connect-button"));

    await findByTestId("login-error");
    expect(__mockReplace).not.toHaveBeenCalled();
  });
});
