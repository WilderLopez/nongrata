// The NonGrata Android SDK. One module, `nongrata`; an app consumes it from the repo with
// `includeBuild` (see Examples/NonGrataDemoAndroid).

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
}

rootProject.name = "nongrata-android"
include(":nongrata")
