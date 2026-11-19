-- Execute the shipped rules with inert Hyprland objects; no compositor/input.
local callbacks = {}
local active = nil
local layers = {}
local dispatched = nil
local window_rules = {}
hl = {
  bind = function(key, callback) callbacks[key] = callback; return { unbind = function() end } end,
  unbind = function() end,
  get_active_window = function() return active end,
  get_layers = function() return layers end,
  dispatch = function(value) dispatched = value end,
  window_rule = function(value) table.insert(window_rules, value) end,
  layer_rule = function() end,
  on = function() end,
  is_key_down = function() return false end,
  dsp = {
    global = function(name) return name end,
    group = { next = function() return "group-next" end },
    window = { resize = function(options) return "resize:" .. options.x end },
  },
}
dofile(arg[1])
-- Every Companion window keeps the foreground application's focus; only the
-- main Window floats. Pop-out windows (another title) are tiled normally.
assert(#window_rules == 2)
local focus_rule = window_rules[1]
assert(focus_rule.match.class == "^companion$" and focus_rule.match.title == nil)
assert(focus_rule.no_initial_focus and not focus_rule.float and not focus_rule.center)
local float_rule = window_rules[2]
assert(float_rule.match.class == "^companion$" and float_rule.match.title == "^Companion$")
assert(float_rule.float and float_rule.center and float_rule.no_initial_focus == nil)
-- Hyprland matches titles with RE2 regular expressions. This anchored,
-- literal pattern means the same as a Lua pattern, so check it against the
-- titles the host gives its windows: the main window, the sidebar surface and
-- pop-outs, including one whose conversation is itself called "Companion".
local function matches(pattern, title)
  return string.find(title, pattern) ~= nil
end
assert(matches(float_rule.match.title, "Companion"))
assert(not matches(float_rule.match.title, "Companion sidebar"))
assert(not matches(float_rule.match.title, "Release notes — Companion"))
assert(not matches(float_rule.match.title, "Companion — Companion"))
assert(not matches(float_rule.match.title, "Conversation — Companion"))
-- A normal Companion window belongs to the compositor, whether floating or
-- tiled. Its content must follow the compositor's resize, including when an
-- unrelated Companion layer is also mapped.
for _, floating in ipairs({true, false}) do
  active = {class = "companion", floating = floating}
  for _, visible_layers in ipairs({{}, {{namespace = "companion-panel", mapped = true}}}) do
    layers = visible_layers
    callbacks["SUPER + ALT + TAB"]()
    assert(dispatched == "companion:next-tab")
    callbacks["SUPER + code:20"]()
    assert(dispatched == "resize:-100", "ordinary window resize must go through Hyprland")
    callbacks["SUPER + code:21"]()
    assert(dispatched == "resize:100")
  end
end
layers = {}
active = {class = "terminal"}
callbacks["SUPER + ALT + TAB"]()
assert(dispatched == "group-next")
callbacks["SUPER + code:20"]()
assert(dispatched == "resize:-100")
callbacks["SUPER + code:21"]()
assert(dispatched == "resize:100")
layers = {{namespace = "companion-panel", mapped = true}}
callbacks["SUPER + ALT + TAB"]()
assert(dispatched == "companion:next-tab")
callbacks["SUPER + code:20"]()
assert(dispatched == "companion:expand-width")
callbacks["SUPER + code:21"]()
assert(dispatched == "companion:shrink-width")
active = nil
callbacks["SUPER + code:20"]()
assert(dispatched == "companion:expand-width")
layers = {{namespace = "companion-panel", mapped = false}}
callbacks["SUPER + code:20"]()
assert(dispatched == "resize:-100")
print("BINDINGS_PASS")
