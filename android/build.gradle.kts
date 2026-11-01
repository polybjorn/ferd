plugins {
  id("com.android.application") version "9.5.0" apply false
  // Not applied: AGP 9 compiles Kotlin itself. Declaring it here pins the
  // Kotlin version AGP uses instead of the older one it bundles.
  id("org.jetbrains.kotlin.android") version "2.4.21" apply false
}
