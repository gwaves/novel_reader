# Android App

The Android app is a Capacitor shell around the independent React mobile workspace.

## Commands

```bash
npm install
npm run android:sync
npm run android:open
```

`android:sync` builds the React app into `dist/` and copies the assets into the native Android project.

## PC Sync URL

On an Android device or emulator, `localhost` points to the device itself, not the PC.

Use one of these:

- Physical phone on the same LAN: `http://<PC-LAN-IP>:5174`
- Android emulator: `http://10.0.2.2:5174`

The PC API must be listening on an address reachable from the phone, for example:

```bash
NOVEL_READER_API_HOST=0.0.0.0 npm run api
```

If `NOVEL_READER_MOBILE_SYNC_TOKEN` is set on the PC API, enter the same token in the mobile sync screen.

## Build Notes

Gradle/Android builds require a local JDK and Android SDK. The workspace can still run `npm run android:sync` without compiling an APK, but APK generation requires Java.

