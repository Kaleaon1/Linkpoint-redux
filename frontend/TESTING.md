# Testing GridLink without a device

Everything below runs without installing onto a physical Android device or
emulator — in a browser tab, or in CI. See the root `README.md` for why a
dev-client build is needed at all (raw UDP sockets aren't available in Expo
Go), and `src/sl/__tests__/` for the automated test suite this complements.

## Automated (CI)

```bash
cd frontend
npx tsc --noEmit   # typecheck
yarn lint          # eslint
yarn test          # jest — src/sl/*.ts logic + a few component tests
```

`.github/workflows/ci.yml` runs all three on every push and pull request.

## Manual, in a browser: `expo start --web`

No setup beyond `yarn install` — the `web` script and `react-native-web`
dependency are already in place.

```bash
cd frontend
npx expo start --web
```

**What works fully in a browser**, and is worth walking through once after
any change to `src/sl/`:

1. **Offline mode.** Log in with "OFFLINE" mode and any avatar name. Send a
   local chat message, open Search and look up a Linden, open Diagnostics.
   None of this touches the network or the UDP circuit — it's the same code
   path `router.test.ts` exercises, just with your eyes on it.
2. **Grid mode login.** Log in with "GRID LOGIN" and real (or throwaway) SL
   credentials. The XML-RPC handshake and capability calls
   (`GetDisplayNames`, `AvatarPickerSearch`) are plain HTTPS `fetch()`, so
   they work from a browser tab like any other web request — you should see
   your real friends list and groups populate.
3. **Confirm the no-live-circuit state is visible, not silent.** A browser
   can't open the raw UDP socket real-time chat/presence/radar need, so
   after grid login the Chat tab's `link-status` pill should read **NO
   LINK** or **RECONNECT** (not **LINK**), and More → sim link should show
   the same. This is the exact state `router.test.ts`'s
   `"reports the app-restarted state"` test and `chat.test.tsx`'s
   `"RECONNECT"` test lock in — if the browser ever showed a green LINK
   there without a real circuit, that would be a bug.
4. **CORS.** The first time you do this, note whether the grid's login and
   capability hosts (`login.agni.lindenlab.com`, and whatever
   `seed_capability`/`GetDisplayNames` host the login response returns)
   respond to a browser-origin request without a CORS error in the console.
   If they don't, that's a real browser-only limitation to note here, not a
   bug in the port — file it as a comment in this doc rather than assuming
   either way.

## GitHub Codespaces (zero local setup)

Same checklist, but running entirely on GitHub's infrastructure — nothing
to install locally:

1. Open a Codespace on this repo.
2. `cd frontend && yarn install && yarn web`.
3. Open the auto-forwarded port in a browser tab and repeat the checklist
   above.

## What this does *not* cover

Live real-time chat, presence, and radar depend on the actual LLUDP UDP
circuit (`src/sl/circuit.ts`), which needs a native module
(`react-native-udp`) that only exists in a dev-client / EAS build on a real
device or emulator. `circuit.test.ts` validates the packet parsing and
dispatch logic against synthetic-but-spec-accurate bytes (see the file's
header comment), but that's a stand-in for — not a substitute for — an
actual login against a live sim. Treat a real-device pass as a separate,
later verification step once one is available.
