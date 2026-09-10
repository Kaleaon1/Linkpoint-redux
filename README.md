# GridLink

A mobile Second Life communicator (Expo / React Native) — login, friends,
IMs, group chat, radar and inventory browsing, talking to the SL grid
**directly from the device**. There is no backend server or database; the
app itself does everything a small SL viewer's networking layer does:

- XML-RPC login handshake (`login.agni.lindenlab.com`)
- LLSD+XML capability calls (display names, resident search, event queue)
- The raw UDP LLUDP sim circuit (chat, IMs, presence, radar, groups)

See `frontend/src/sl/` for the implementation and `frontend/README.md` for
how to run it. Because raw UDP sockets aren't available in Expo Go, the app
needs a custom dev client / EAS build (`npx expo run:android` /
`npx expo run:ios`, or `eas build --profile development`) rather than the
Expo Go app.

## Testing

`frontend/src/sl/__tests__/` has the automated test suite (`yarn test`),
and `.github/workflows/ci.yml` runs it — along with a typecheck and lint —
on every push and pull request. See `frontend/TESTING.md` for how to
exercise the app itself without a device, in a browser or a GitHub
Codespace.
