plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "io.github.polybjorn.ferd"
  compileSdk = 34

  defaultConfig {
    applicationId = "io.github.polybjorn.ferd"
    minSdk = 26
    targetSdk = 34
    versionCode = 1
    versionName = "0.1.0"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
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
    include("index.html", "sw.js")
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
