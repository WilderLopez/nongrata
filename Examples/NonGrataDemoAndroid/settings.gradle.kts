// A minimal app that consumes the NonGrata Android SDK straight from the repo: `includeBuild`
// substitutes `io.github.wilderlopez:nongrata` with the module in ../../android.

pluginManagement {
    repositories {
        // Android's own groups only from Google's repository, and nothing else from it. Every
        // other artifact, Google's libraries such as Guava or Protobuf included, is on Maven Central.
        exclusiveContent {
            forRepository { google() }
            filter {
                includeGroupByRegex("com\\.android(\\..*)?")
                includeGroupByRegex("androidx\\..*")
            }
        }
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        // Android's own groups only from Google's repository, and nothing else from it. Every
        // other artifact, Google's libraries such as Guava or Protobuf included, is on Maven Central.
        exclusiveContent {
            forRepository { google() }
            filter {
                includeGroupByRegex("com\\.android(\\..*)?")
                includeGroupByRegex("androidx\\..*")
            }
        }
        mavenCentral()
    }
    // The same pinned versions as the SDK.
    versionCatalogs {
        create("libs") {
            from(files("../../android/gradle/libs.versions.toml"))
        }
    }
}

rootProject.name = "NonGrataDemoAndroid"
includeBuild("../../android")
include(":app")
