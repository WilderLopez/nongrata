.PHONY: install test test-worker test-cli test-swift typecheck build-ios check no-instrumentation \
	mutation mutation-worker mutation-cli mutation-baseline docs

# Todo lo que debe estar en verde antes de dar algo por terminado. `mutation` va después de
# `test`: con la suite en rojo, el score no significa nada.
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

# Stryker muta src/ en su sitio (inPlace) y lo restaura al terminar. Si el proceso muere antes,
# el código instrumentado sigue pasando los tests: que no llegue a un commit.
no-instrumentation:
	@if grep -rlE 'stryMutAct_|stryNS_' worker/src cli/src; then \
		echo "Restos de Stryker en los ficheros de arriba: restáuralos con git."; exit 1; fi

# Mutation testing (Stryker). Falla si el score baja más de un punto respecto al baseline.
mutation: mutation-worker mutation-cli

mutation-worker:
	pnpm --dir worker run test:mutation
	node scripts/mutation-score.mjs worker

mutation-cli:
	pnpm --dir cli run test:mutation
	node scripts/mutation-score.mjs cli

# Tras un descenso intencionado (se borró un test obsoleto, módulo nuevo aún sin cubrir).
mutation-baseline:
	pnpm --dir worker run test:mutation
	node scripts/mutation-score.mjs worker --update
	pnpm --dir cli run test:mutation
	node scripts/mutation-score.mjs cli --update

# Enlaces de docs/ sin romper y, con un .public-terms local, ningún nombre privado en el repo.
docs:
	@node scripts/check-docs.mjs

# Objetivos locales de cada uno (por ejemplo, notas de trabajo fuera del repo). Git lo ignora.
-include local.mk
