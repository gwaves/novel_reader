# Legacy Mobile App

`mobile-app/` is deprecated.

This directory contains the older LAN-sync Android client. It is kept only as historical reference and should not receive new mobile features by default.

Use `gateway-android-app/` for the maintained Android client:

```bash
npm --prefix gateway-android-app run test
npm --prefix gateway-android-app run build
npm run gateway-android:android:build
```

Gateway APK publishing is handled from the repository root:

```bash
npm run gateway:publish-android-apk
```
