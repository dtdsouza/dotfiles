return {
	{
		"nvim-neo-tree/neo-tree.nvim",
		branch = "v3.x",
		dependencies = {
			"nvim-lua/plenary.nvim",
			"MunifTanjim/nui.nvim",
			"nvim-tree/nvim-web-devicons", -- optional, but recommended
		},
		lazy = false, -- neo-tree will lazily load itself
		config = function()
			require("neo-tree").setup({
				filesystem = {
					follow_current_file = {
						enabled = true,
						leave_dirs_open = false,
					},
					filtered_items = {
						hide_dotfiles = false,
						hide_gitignored = true,
					},
				},
				window = {
					mappings = {
						["Y"] = {
							function(state)
								local node = state.tree:get_node()
								local abs_path = node:get_id()
								-- Get path relative to current working directory
								local rel_path = vim.fn.fnamemodify(abs_path, ":~:.")
								local filename = node.name

								local options = {
									"1. Copy Absolute Path",
									"2. Copy Relative Path",
									"3. Copy Filename",
								}

								vim.ui.select(options, { prompt = "Choose path format to copy:" }, function(choice)
									if not choice then
										return
									end

									local clipboard_val
									if choice:match("Absolute") then
										clipboard_val = abs_path
									elseif choice:match("Relative") then
										clipboard_val = rel_path
									else
										clipboard_val = filename
									end

									vim.fn.setreg("+", clipboard_val)
									vim.notify("Copied: " .. clipboard_val)
								end)
							end,
							desc = "Copy path options",
						},
					},
				},
			})
			vim.keymap.set("n", "<C-n>", ":Neotree toggle<CR>")
		end,
	},
}
