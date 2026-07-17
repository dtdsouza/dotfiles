-- Debian's neovim package ships no bundled tree-sitter parsers, so the stock
-- ftplugin/lua.lua (vim.treesitter.start()) errors on every .lua buffer.
-- nvim-treesitter compiles parsers locally (gcc/cc required) and puts them on
-- the runtimepath, which resolves it.
--
-- Pinned to the `master` branch: nvim-treesitter `main` requires Neovim 0.11+,
-- and this system runs 0.10.4.
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
          "javascript"
        },
        auto_install = true,
        highlight = { enable = true },
        indent = { enable = true },
      })
    end,
  },
}
