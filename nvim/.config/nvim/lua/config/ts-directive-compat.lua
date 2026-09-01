-- nvim-treesitter's locked `master` branch predates Neovim 0.11's query API
-- change: a match now maps a capture id to a LIST of nodes, but master's
-- handlers still index it as a single node. The `all = false` compat opt they
-- relied on was dropped in 0.12, so they receive a table where a TSNode is
-- expected and die with "attempt to call method 'range'/'type' (a nil value)".
-- That breaks markdown buffers (fenced code blocks) and TypeScript/JavaScript
-- indentation, among others. Re-register every node-consuming predicate and
-- directive with a list-aware lookup.
--
-- Neovim resolves `not-<name>?` through the same handler, so fixing `kind-eq?`
-- also fixes the `not-kind-eq?` used by the C and ecma indent queries.
--
-- Drop this file once the plugin moves to `main` (needs tree-sitter-cli 0.26+,
-- which Debian does not package yet).

local query = require("vim.treesitter.query")

local HTML_SCRIPT_TYPE_LANGUAGES = {
  ["importmap"] = "json",
  ["module"] = "javascript",
  ["application/ecmascript"] = "javascript",
  ["text/ecmascript"] = "javascript",
}

local INFO_STRING_ALIASES = {
  ex = "elixir",
  pl = "perl",
  sh = "bash",
  uxn = "uxntal",
  ts = "typescript",
}

local OPTS = { force = true }

---@param match table<integer, TSNode[]>
---@param captureId integer
---@return TSNode|nil
local function firstCapturedNode(match, captureId)
  local captured = match[captureId]
  if type(captured) == "table" then
    return captured[1]
  end
  return captured
end

---@param infoString string
---@return string
local function languageFromInfoString(infoString)
  local matched = vim.filetype.match({ filename = "a." .. infoString })
  return matched or INFO_STRING_ALIASES[infoString] or infoString
end

return function()
  -- Load the plugin's own registrations first so these overrides win.
  require("nvim-treesitter.query_predicates")

  query.add_predicate("nth?", function(match, _, _, pred)
    local node = firstCapturedNode(match, pred[2])
    local index = tonumber(pred[3])
    local parent = node and node:parent()
    if not parent or not index or parent:named_child_count() <= index then
      return false
    end

    return parent:named_child(index) == node
  end, OPTS)

  query.add_predicate("is?", function(match, _, source, pred)
    local node = firstCapturedNode(match, pred[2])
    if not node then
      return true
    end

    -- Required lazily: nvim-treesitter.locals pulls this module back in.
    local locals = require("nvim-treesitter.locals")
    local _, _, kind = locals.find_definition(node, source)

    return vim.tbl_contains({ unpack(pred, 3) }, kind)
  end, OPTS)

  query.add_predicate("kind-eq?", function(match, _, _, pred)
    local node = firstCapturedNode(match, pred[2])
    if not node then
      return true
    end

    return vim.tbl_contains({ unpack(pred, 3) }, node:type())
  end, OPTS)

  query.add_directive("set-lang-from-mimetype!", function(match, _, source, pred, metadata)
    local node = firstCapturedNode(match, pred[2])
    if not node then
      return
    end

    local mimetype = vim.treesitter.get_node_text(node, source)
    local configured = HTML_SCRIPT_TYPE_LANGUAGES[mimetype]
    if configured then
      metadata["injection.language"] = configured
      return
    end

    local parts = vim.split(mimetype, "/", {})
    metadata["injection.language"] = parts[#parts]
  end, OPTS)

  query.add_directive("set-lang-from-info-string!", function(match, _, source, pred, metadata)
    local node = firstCapturedNode(match, pred[2])
    if not node then
      return
    end

    local infoString = vim.treesitter.get_node_text(node, source):lower()
    metadata["injection.language"] = languageFromInfoString(infoString)
  end, OPTS)

  query.add_directive("downcase!", function(match, _, source, pred, metadata)
    local captureId = pred[2]
    local node = firstCapturedNode(match, captureId)
    if not node then
      return
    end

    local text = vim.treesitter.get_node_text(node, source, { metadata = metadata[captureId] }) or ""
    metadata[captureId] = metadata[captureId] or {}
    metadata[captureId].text = text:lower()
  end, OPTS)
end
