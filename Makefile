PUBLISHER := ignaciourbina
NAME      := custom-file-explorer
VERSION   := $(shell node -p "require('./package.json').version")
EXT_ROOT  := $(HOME)/.vscode/extensions
EXT_DIR   := $(EXT_ROOT)/$(PUBLISHER).$(NAME)-$(VERSION)

.PHONY: all compile deploy link uninstall clean reinstall print

all: deploy

compile:
	npm run compile

deploy: compile
	@mkdir -p "$(EXT_DIR)"
	@cp -R package.json README.md out "$(EXT_DIR)/"
	@echo "Deployed to $(EXT_DIR)"
	@echo "Reload VS Code window (Cmd/Ctrl+Shift+P -> 'Reload Window') to pick up changes."

link: compile
	@mkdir -p "$(EXT_ROOT)"
	@rm -rf "$(EXT_DIR)"
	@ln -s "$(CURDIR)" "$(EXT_DIR)"
	@echo "Symlinked $(CURDIR) -> $(EXT_DIR)"
	@echo "Reload VS Code window to pick up changes."

uninstall:
	@rm -rf "$(EXT_DIR)"
	@echo "Removed $(EXT_DIR)"

reinstall: uninstall deploy

clean:
	@rm -rf out

print:
	@echo "VERSION  = $(VERSION)"
	@echo "EXT_DIR  = $(EXT_DIR)"
