# ============================================================================
# VM Layer — Makefile
# Developer shortcuts for building, deploying, and managing the VM Layer.
# ============================================================================

.PHONY: help build-image-windows build-image-linux plan apply destroy test lint clean

# Default target
help: ## Show this help message
	@echo ""
	@echo "  VM Layer — Developer Commands"
	@echo "  =============================="
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-25s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ---------------------------------------------------------------------------
# Packer — Image Building
# ---------------------------------------------------------------------------

build-image-windows: ## Build the Windows Server AMI with Packer
	cd packer && packer init . && packer build -var-file=variables.pkr.hcl base-windows.pkr.hcl

build-image-linux: ## Build the Linux (Ubuntu) AMI with Packer
	cd packer && packer init . && packer build -var-file=variables.pkr.hcl base-linux.pkr.hcl

validate-packer: ## Validate all Packer templates
	cd packer && packer validate base-windows.pkr.hcl
	cd packer && packer validate base-linux.pkr.hcl

# ---------------------------------------------------------------------------
# Terraform — Infrastructure Management
# ---------------------------------------------------------------------------

ENV ?= dev

init: ## Initialize Terraform for the target environment (ENV=dev|prod)
	cd terraform/environments/$(ENV) && terraform init

plan: ## Run Terraform plan for the target environment (ENV=dev|prod)
	cd terraform/environments/$(ENV) && terraform plan -out=tfplan

apply: ## Apply Terraform changes for the target environment (ENV=dev|prod)
	cd terraform/environments/$(ENV) && terraform apply tfplan

destroy: ## Destroy all infrastructure in the target environment (ENV=dev|prod)
	cd terraform/environments/$(ENV) && terraform destroy -auto-approve

validate-terraform: ## Validate Terraform configuration
	cd terraform/environments/dev && terraform validate
	cd terraform/environments/prod && terraform validate

fmt: ## Format all Terraform files
	terraform fmt -recursive terraform/

# ---------------------------------------------------------------------------
# VM Manager — Node.js Service
# ---------------------------------------------------------------------------

install: ## Install VM Manager dependencies
	cd vm-manager && npm install

test: ## Run VM Manager unit tests
	cd vm-manager && npm test

test-coverage: ## Run tests with coverage report
	cd vm-manager && npm run test:coverage

lint: ## Lint VM Manager source code
	cd vm-manager && npm run lint

start-dev: ## Start VM Manager in development mode
	cd vm-manager && npm run dev

start: ## Start VM Manager in production mode
	cd vm-manager && npm start

# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

clean: ## Remove all generated files and caches
	rm -rf packer/packer_cache
	rm -rf terraform/environments/dev/.terraform
	rm -rf terraform/environments/prod/.terraform
	rm -rf terraform/environments/dev/tfplan
	rm -rf terraform/environments/prod/tfplan
	rm -rf vm-manager/node_modules
	rm -rf vm-manager/coverage

check-all: validate-packer validate-terraform lint test ## Run all validation checks
	@echo ""
	@echo "  ✅ All checks passed!"
	@echo ""
