# dotfiles

My personal configuration files, managed with [GNU Stow](https://www.gnu.org/software/stow/).
Each top-level directory is a Stow "package" whose contents mirror `$HOME`; running
`stow <package>` symlinks its files into place.

## What's included

| Package   | Symlinks                                             |
|-----------|------------------------------------------------------|
| `zsh`     | `~/.zshrc` (oh-my-zsh, `robbyrussell`)               |
| `tmux`    | `~/.tmux.conf` (prefix `C-a`, Everforest theme)      |
| `nvim`    | `~/.config/nvim/` (custom lazy.nvim config)          |
| `git`     | `~/.gitconfig`, `~/.config/git/ignore`               |
| `bash`    | `~/.bashrc`, `~/.profile`                            |
| `lazygit` | `~/.config/lazygit/config.yml`                       |
| `gh`      | `~/.config/gh/config.yml`                            |

## Install (new machine)

```sh
git clone https://github.com/<you>/dotfiles.git ~/dotfiles
cd ~/dotfiles
./install.sh          # seeds local files, installs oh-my-zsh + plugins, stows everything
exec zsh
```

`install.sh` requires GNU Stow (`sudo apt-get install stow` or `brew install stow`).
Neovim plugins install themselves via lazy.nvim on first `nvim` launch.

## Secrets & machine-local config (never committed)

Real secrets and non-portable config live in files under `$HOME` that are **git-ignored**
and seeded from `.example` templates on install:

| Local file (untracked) | Purpose                                             | Template |
|------------------------|-----------------------------------------------------|----------|
| `~/.zsh_secrets`       | secret exports (e.g. `VAULT_ADDR`, `VAULT_TOKEN`)   | `zsh/.zsh_secrets.example` |
| `~/.zshrc.local`       | work-specific aliases / private functions           | `zsh/.zshrc.local.example` |
| `~/.gitconfig.local`   | real git identity (name/email)                      | `git/.gitconfig.local.example` |

`~/.zshrc` sources `~/.zsh_secrets` and `~/.zshrc.local` at the end; `~/.gitconfig`
`[include]`s `~/.gitconfig.local`. Fill in the real values after install.

**gh note:** the `gh` package tracks `config.yml` only. Your auth token lives in
`~/.config/gh/hosts.yml`, which is git-ignored (`**/hosts.yml`). On a fresh machine,
after `gh auth login` writes `hosts.yml`, confirm it stays untracked (`git status`).

## Publishing this repo

All real secrets and machine-local config stay in the git-ignored `~/.zsh_secrets`,
`~/.zshrc.local`, and `~/.gitconfig.local` files (and `~/.config/gh/hosts.yml`) — never
in this repo. Before the first push to a public repo, still review `git diff --cached`
to confirm nothing sensitive is staged.

Commit author email is public on every commit; set a private/noreply address if desired
(`git config user.email "<id>+<user>@users.noreply.github.com"`).
