-- Neovim ships parsers for only a handful of languages (c, lua, markdown,
-- query, vim, vimdoc); nvim-treesitter compiles the rest locally (gcc/cc
-- required) and puts them on the runtimepath.
--
-- Pinned to the `master` branch: `main` requires tree-sitter-cli 0.26+, which
-- Debian does not package (0.22.6). `master` is locked at Neovim 0.11, so it
-- needs the query-directive shim below on this system's 0.12.
return {
  {
    "nvim-treesitter/nvim-treesitter",
    branch = "master",
    lazy = false,
    build = ":TSUpdate",
    config = function()
      require("nvim-treesitter.configs").setup({
        ensure_installed = {
          "lua",
          "vim",
          "vimdoc",
          "query",
          "typescript",
          "javascript",
        },
        auto_install = true,
        highlight = { enable = true },
        indent = { enable = true },
      })

      require("config.ts-directive-compat")()
    end,
  },
}
