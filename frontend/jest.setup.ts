// Global Jest setup. Most native-module mocks live as manual mocks under
// __mocks__/ (auto-applied by Jest for the whole suite); this covers the one
// that doesn't fit that pattern — jest-expo's generic native-module mock
// wraps expo-crypto's exports in bare jest.fn() stubs with no implementation,
// which would make ids.ts's newId() return undefined under test.
jest.mock("expo-crypto", () => {
  let counter = 0;
  return {
    randomUUID: jest.fn(() => {
      counter += 1;
      return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
    }),
  };
});
