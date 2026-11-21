import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

// Worker values: nongrata.local.properties (ignored by git), else the committed placeholders.
val nonGrataValues = Properties().apply {
    val local = rootProject.file("nongrata.local.properties")
    val source = if (local.exists()) local else rootProject.file("nongrata.local.properties.example")
    source.reader(Charsets.UTF_8).use { load(it) }
}

fun nonGrataValue(key: String): String {
    val value = nonGrataValues.getProperty(key)?.trim()
    require(!value.isNullOrEmpty()) { "Missing $key in nongrata.local.properties" }
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}

android {
    namespace = "io.github.wilderlopez.nongrata.demo"
    compileSdk = 36
    buildToolsVersion = "37.0.0"
    defaultConfig {
        applicationId = "io.github.wilderlopez.nongrata.demo"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.2.0"
        buildConfigField("String", "NONGRATA_WORKER_URL", nonGrataValue("nongrata.workerUrl"))
        buildConfigField("String", "NONGRATA_APP_ID", nonGrataValue("nongrata.appId"))
        buildConfigField("String", "NONGRATA_HASH_PREFIX", nonGrataValue("nongrata.hashPrefix"))
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // No version: the included build ../../android provides it.
    implementation("io.github.wilderlopez:nongrata")
}
