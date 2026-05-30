plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

// Derive a unique, monotonic version from git so every build is identifiable
// (visible in Android app info and in-app via window.FerdAndroid.appVersion).
// CI must check out full history (fetch-depth: 0) for the commit count.
fun gitOutput(vararg args: String): String = try {
  providers.exec { commandLine("git", *args) }.standardOutput.asText.get().trim()
} catch (e: Exception) {
  ""
}
val commitCount = gitOutput("rev-list", "--count", "HEAD").toIntOrNull() ?: 1
// Track Ferd's own version (the app bundles its frontend); the commit count is
// the build identifier. Yields e.g. "1.0.1-dev+177", later "1.1.0+N".
val ferdVersion = try {
  rootProject.projectDir.parentFile.resolve("VERSION").readText().trim()
} catch (e: Exception) {
  "0.0.0"
}

android {
  namespace = "io.github.polybjorn.ferd"
  compileSdk = 34

  defaultConfig {
    applicationId = "io.github.polybjorn.ferd"
    minSdk = 26
    targetSdk = 34
    versionCode = commitCount
    versionName = "$ferdVersion+$commitCount"
  }

  buildFeatures {
    buildConfig = true
  }

  // Release signing reads a keystore from the environment (CI secrets). When
  // it's absent (local/dev builds), no release signing config is created and
  // assembleRelease produces an unsigned APK; only CI with the secrets emits a
  // distributable, consistently-signed build for Obtainium.
  val keystorePath = System.getenv("FERD_KEYSTORE_FILE")
  val hasKeystore = keystorePath != null && file(keystorePath).exists()
  signingConfigs {
    if (hasKeystore) {
      create("release") {
        storeFile = file(keystorePath!!)
        storePassword = System.getenv("FERD_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("FERD_KEY_ALIAS")
        keyPassword = System.getenv("FERD_KEY_PASSWORD")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
      signingConfig = signingConfigs.findByName("release")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }

  // The frontend shell is the single source of truth in the repo root; the app
  // bundles a build-time copy so it can never drift from source. Nothing under
  // android/ duplicates the web app in git.
  sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/web_assets"))
}

// Copy the served frontend (../index.html, ../sw.js, ../vendor, ../icons) into a
// generated assets dir, mapped to the WebView's app origin root at runtime.
val copyWebAssets by tasks.registering(Copy::class) {
  val repoRoot = rootProject.projectDir.parentFile
  into(layout.buildDirectory.dir("generated/web_assets"))
  from(repoRoot) {
    include("index.html", "sw.js", "catalog.json")
  }
  from(repoRoot.resolve("vendor")) { into("vendor") }
  from(repoRoot.resolve("icons")) { into("icons") }
}

tasks.named("preBuild") {
  dependsOn(copyWebAssets)
}

dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.activity:activity-ktx:1.9.0")
  implementation("androidx.webkit:webkit:1.11.0")
}
