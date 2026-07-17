#!/usr/bin/env bash
#
# install.sh -- set up these dotfiles on a machine via GNU Stow.
#
# Idempotent: safe to re-run. It seeds machine-local template files (only if
# missing), bootstraps the zsh environment (oh-my-zsh + plugins), and stows
# every package so the configs are symlinked into $HOME.
#
# For the FIRST-TIME migration of an existing machine (moving your current
# ~/.zshrc etc. into this repo and extracting secrets), use bootstrap.sh once
# instead -- this script assumes the repo is already the source of truth.

set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DOTFILES_DIR"

PACKAGES=(zsh tmux nvim git lazygit bash gh)

echo "==> dotfiles: $DOTFILES_DIR"

# --- 1. Require GNU Stow -----------------------------------------------------
if ! command -v stow >/dev/null 2>&1; then
  echo "ERROR: GNU Stow is not installed."
  echo "  Debian/Ubuntu:  sudo apt-get install -y stow"
  echo "  macOS (brew):   brew install stow"
  exit 1
fi

# --- 2. Seed machine-local files (only if they don't already exist) ----------
seed() {  # seed <example-in-repo> <target-in-home>
  local src="$1" dst="$2"
  if [ -f "$src" ] && [ ! -e "$dst" ]; then
    cp "$src" "$dst"
    echo "    seeded $dst (fill in your real values)"
  fi
}
echo "==> seeding machine-local files"
seed "$DOTFILES_DIR/zsh/.zsh_secrets.example"      "$HOME/.zsh_secrets"
seed "$DOTFILES_DIR/zsh/.zshrc.local.example"      "$HOME/.zshrc.local"
seed "$DOTFILES_DIR/git/.gitconfig.local.example"  "$HOME/.gitconfig.local"

# --- 3. Bootstrap zsh environment (oh-my-zsh + hand-cloned plugins) ----------
echo "==> zsh environment"
if [ ! -d "$HOME/.oh-my-zsh" ]; then
  echo "    installing oh-my-zsh"
  RUNZSH=no KEEP_ZSHRC=yes sh -c \
    "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
fi
mkdir -p "$HOME/.zsh"
clone_plugin() {  # clone_plugin <name> <url>
  local dir="$HOME/.zsh/$1"
  if [ ! -d "$dir" ]; then
    echo "    cloning $1"
    git clone --depth 1 "$2" "$dir"
  fi
}
clone_plugin zsh-syntax-highlighting https://github.com/zsh-users/zsh-syntax-highlighting.git
clone_plugin zsh-autosuggestions     https://github.com/zsh-users/zsh-autosuggestions.git

# --- 4. Stow every package ---------------------------------------------------
echo "==> stowing packages: ${PACKAGES[*]}"
for pkg in "${PACKAGES[@]}"; do
  [ -d "$DOTFILES_DIR/$pkg" ] || { echo "    skip $pkg (missing)"; continue; }
  stow --restow --target="$HOME" "$pkg"
  echo "    stowed $pkg"
done

echo "==> done. Open a new shell (or: exec zsh)."
echo "    Neovim plugins install themselves via lazy.nvim on first launch."
