.DEFAULT_GOAL := help

APP := apps/menubar/build/ClaudeTelemetry.app

.PHONY: help install start dev app build open release test typecheck check clean

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies
	bun install

start: ## Run collector and dashboard on http://127.0.0.1:4318
	bun run start

dev: ## Run collector in development mode
	bun run dev

build: ## Build the menu bar app
	apps/menubar/scripts/build.sh

open: ## Open the built menu bar app
	open $(APP)

app: build open ## Build and open the menu bar app

release: ## Build and notarize the menu bar DMG (publish via the GitHub workflow)
	apps/menubar/scripts/release.sh

test: ## Run tests
	bun test

typecheck: ## Type-check TypeScript
	bun run typecheck

check: typecheck test ## Type-check and run tests

clean: ## Remove menu bar build output
	rm -rf apps/menubar/build
