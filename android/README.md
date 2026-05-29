# Ferd for Android

A thin WebView wrapper around the Ferd frontend, packaged as an installable
Android app. The web UI (`index.html`, `vendor/`, `icons/`, `sw.js` from the
repo root) is bundled into the APK at build time and served from a secure
in-app origin (`https://appassets.androidplatform.net/`).

Because that origin is cross-origin to whichever server you connect to, the app
uses the frontend's built-in **server picker** and **bearer-token auth**: on
first launch you enter your Ferd server's address, sign in, and the app talks to
it over the API. Nothing about the server is baked into the APK, so one build
works for any self-hosted instance.

## Transport / certificates

- **Valid HTTPS** (Let's Encrypt, Caddy, reverse proxy, Tailscale): works with
  no prompts.
- **Self-signed HTTPS**: you're shown the certificate's SHA-256 fingerprint once
  and asked to trust it. The choice is pinned per host, so a later silent
  certificate change re-prompts instead of being accepted blindly.
- **Plain HTTP**: allowed (common on a LAN), but the picker warns that your
  sign-in token is sent unencrypted. Use it only on a network you trust.

## Build

Requires JDK 17 and the Android SDK (platform 34). From this `android/`
directory:

```
./gradlew assembleDebug
```

The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk`. Or open the
`android/` folder in Android Studio and Run.

The bundled frontend is copied from the repo root by the `copyWebAssets` Gradle
task on every build, so the app never drifts from the web source.

Export uses a small JS bridge (`window.FerdAndroid`): the frontend hands the
export blob to native, which saves it through the system document picker
(WebView drops blob downloads on its own).

## Known limitations (v1)

- **Launcher icon** is a placeholder map pin. Replace it via Android Studio's
  Image Asset Studio (generated from the Ferd favicon) before any public release.

## License

GPL-3.0-or-later, same as Ferd. The APK bundles and distributes the GPL-licensed
Ferd frontend, so the whole app is GPL.
