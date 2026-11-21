plugins {
    alias(libs.plugins.android.library)
}

// Coordinates an app's `includeBuild` substitutes: `implementation("io.github.wilderlopez:nongrata")`.
group = "io.github.wilderlopez"
version = "0.2.0"

android {
    namespace = "io.github.wilderlopez.nongrata"
    compileSdk = 36
    // Pinned so AGP never downloads its default build tools on its own.
    buildToolsVersion = "37.0.0"
    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.all {
            // The tests read spec/hash-vectors.json from the repo, not a copy.
            it.systemProperty("nongrata.specDir", rootProject.file("../spec").absolutePath)
        }
    }
}

kotlin {
    explicitApi()
}

dependencies {
    testImplementation(libs.junit)
}
