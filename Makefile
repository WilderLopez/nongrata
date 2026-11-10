.PHONY: install test test-worker test-cli test-swift typecheck build-ios check no-instrumentation \
	mutation mutation-worker mutation-cli mutation-baseline docs

# Everything that must be green before calling something done. `mutation` runs after `test`:
# with a red suite, the score means nothing.
check: no-instrumentation docs typecheck test build-ios mutation

install:
	pnpm install --frozen-lockfile

test: test-worker test-cli test-swift

test-worker:
	pnpm --dir worker test

test-cli:
	pnpm --dir cli test

test-swift:
	swift test

typecheck:
	pnpm --dir worker typecheck
	pnpm --dir cli typecheck

build-ios:
	xcodebuild -quiet -scheme NonGrata-Package -destination 'generic/platform=iOS' build

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
