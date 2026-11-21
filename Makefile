.PHONY: install test test-worker test-cli test-swift test-android typecheck build-ios build-android check \
	no-instrumentation mutation mutation-worker mutation-cli mutation-baseline docs

# Android SDK for the Gradle builds: Android Studio's default location unless set (local.mk can).
ANDROID_HOME ?= $(HOME)/Library/Android/sdk
export ANDROID_HOME

# Everything that must be green before calling something done. `mutation` runs after `test`:
# with a red suite, the score means nothing.
check: no-instrumentation docs typecheck test build-ios build-android mutation

install:
	pnpm install --frozen-lockfile

test: test-worker test-cli test-swift test-android

test-worker:
	pnpm --dir worker test

test-cli:
	pnpm --dir cli test

test-swift:
	swift test

# JVM unit tests of the Android SDK (no emulator). The Gradle wrapper checks its own download and
# gradle/verification-metadata.xml every artifact.
test-android:
	cd android && ./gradlew --quiet :nongrata:testDebugUnitTest

typecheck:
	pnpm --dir worker typecheck
	pnpm --dir cli typecheck

build-ios:
	xcodebuild -quiet -scheme NonGrata-Package -destination 'generic/platform=iOS' build

# The Android demo app, which consumes the SDK from the repo with includeBuild.
build-android:
	cd Examples/NonGrataDemoAndroid && ./gradlew --quiet assembleDebug

# Stryker mutates src/ in place (inPlace) and restores it when it finishes. If the process dies
# first, the instrumented code still passes the tests: keep it out of any commit.
no-instrumentation:
	@if grep -rlE 'stryMutAct_|stryNS_' worker/src cli/src; then \
		echo "Stryker leftovers in the files above: restore them with git."; exit 1; fi

# Mutation testing (Stryker). Fails if the score drops more than one point below the baseline.
mutation: mutation-worker mutation-cli

mutation-worker:
	pnpm --dir worker run test:mutation
	node scripts/mutation-score.mjs worker

mutation-cli:
	pnpm --dir cli run test:mutation
	node scripts/mutation-score.mjs cli

# After an intentional drop (an obsolete test was deleted, a new module is not covered yet).
mutation-baseline:
	pnpm --dir worker run test:mutation
	node scripts/mutation-score.mjs worker --update
	pnpm --dir cli run test:mutation
	node scripts/mutation-score.mjs cli --update

# No broken links in docs/, English and Spanish docs linked to each other and, with a local
# .public-terms, no private names anywhere in the repo.
docs:
	@node scripts/check-docs.mjs

# Personal local targets (for example, work notes outside the repo). Git ignores it.
-include local.mk
