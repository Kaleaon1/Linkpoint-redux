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
