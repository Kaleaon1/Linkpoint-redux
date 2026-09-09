# GridLink (Expo app)

This app talks to the Second Life grid directly — no backend server. See
`src/sl/` for the login/LLUDP/capability implementation.

> **No Expo Go.** The app opens a raw UDP socket (`react-native-udp`) to the
> sim server, which Expo Go's sandbox doesn't allow. Use a dev client build
> instead: `npx expo run:android`, `npx expo run:ios`, or
> `eas build --profile development`.

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Build and run a dev client (first time, or after adding a native module)

   ```bash
   npx expo run:android   # or: npx expo run:ios
   ```

3. On later runs, just start Metro and reopen the installed dev client

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
