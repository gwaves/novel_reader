# Android App

The Android app is a Capacitor shell around the independent React mobile workspace.

## Commands

```bash
npm install
npm run android:sync
npm run android:open
```

`android:sync` builds the React app into `dist/` and copies the assets into the native Android project.

To build a debug APK from the command line:

```bash
cd android
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH" \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
./gradlew assembleDebug
```

The generated debug APK is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

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

The Android app allows cleartext HTTP for LAN sync. This is intentional for local development because the PC API currently runs as `http://...:5174`.

Relevant files:

- `capacitor.config.ts`: uses `androidScheme: 'http'` and `cleartext: true`.
- `android/app/src/main/AndroidManifest.xml`: sets `android:usesCleartextTraffic="true"`.
- `android/app/src/main/res/xml/network_security_config.xml`: permits cleartext traffic.

## Build Notes

Gradle/Android builds require a local JDK and Android SDK. The working local setup is:

- JDK: Homebrew `openjdk@21`
- Android command line tools: Homebrew `android-commandlinetools`
- SDK root: `/opt/homebrew/share/android-commandlinetools`
- Android platform: `android-36`
- Build tools: `36.0.0`

The Android project has a local SDK pointer in `android/local.properties`. That file is ignored by Git because SDK paths are machine-specific.

If Gradle reports `无效的源发行版：21` or `invalid source release: 21`, make sure `JAVA_HOME` points to OpenJDK 21, not 17.

If Gradle reports `SDK location not found`, install Android command line tools and set `ANDROID_HOME` or create `android/local.properties`.

## Status Bar And Safe Area

The app uses `@capacitor/status-bar` so Android system status icons do not overlap the React UI.

At app startup, `src/main.tsx` calls:

- `StatusBar.setOverlaysWebView({ overlay: false })`
- `StatusBar.setStyle({ style: Style.Light })`
- `StatusBar.setBackgroundColor({ color: '#ffffff' })`

The CSS top bar also includes `env(safe-area-inset-top)` padding as a second layer of protection for cutouts and status bars.
