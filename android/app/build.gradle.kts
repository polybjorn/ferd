import javax.inject.Inject

plugins {
  id("com.android.application")
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
// A release build passes its tag's version (-PferdVersion=1.5.0-beta.1),
// because a beta is cut without bumping VERSION.
val ferdVersion = providers.gradleProperty("ferdVersion").orNull ?: try {
  rootProject.projectDir.parentFile.resolve("VERSION").readText().trim()
} catch (e: Exception) {
  "0.0.0"
}
// A beta installs as its own app beside the stable one, so a broken beta never
// touches the data a tester keeps in the stable app.
val isBeta = ferdVersion.contains("-beta.")

android {
  namespace = "io.github.polybjorn.ferd"
  compileSdk = 37

  defaultConfig {
    applicationId = "io.github.polybjorn.ferd"
    minSdk = 26
    targetSdk = 36
    versionCode = commitCount
    versionName = "$ferdVersion+$commitCount"
    if (isBeta) applicationIdSuffix = ".beta"
    manifestPlaceholders["appLabel"] = if (isBeta) "Ferd beta" else "@string/app_name"
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
}

// AGP 9 compiles Kotlin itself; the root build pins the Kotlin version.
kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
  }
}

// Copy the served frontend (../index.html, ../ui.css, ../sw.js, ../vendor, ../icons) into a
// generated assets dir, mapped to the WebView's app origin root at runtime.
abstract class CopyWebAssets @Inject constructor(
  private val fs: FileSystemOperations,
) : DefaultTask() {
  @get:Internal
  abstract val repoRoot: DirectoryProperty

  @get:InputFiles
  @get:PathSensitive(PathSensitivity.RELATIVE)
  val webSources: FileCollection
    get() = repoRoot.get().asFileTree.matching {
      include("index.html", "ui.css", "sw.js", "catalog.json", "vendor/**", "icons/**")
    }

  @get:OutputDirectory
  abstract val outputDir: DirectoryProperty

  @TaskAction
  fun copy() {
    fs.sync {
      from(webSources)
      into(outputDir)
    }
  }
}

val copyWebAssets = tasks.register<CopyWebAssets>("copyWebAssets") {
  repoRoot.set(rootProject.layout.projectDirectory.dir(".."))
}

// The frontend shell is the single source of truth in the repo root; the app
// bundles a build-time copy so it can never drift from source. Nothing under
// android/ duplicates the web app in git.
androidComponents {
  onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(copyWebAssets, CopyWebAssets::outputDir)
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.19.1")
  implementation("androidx.appcompat:appcompat:1.8.0")
  implementation("androidx.activity:activity-ktx:1.13.0")
  implementation("androidx.webkit:webkit:1.18.0")
}
