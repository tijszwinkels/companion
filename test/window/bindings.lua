-- Execute the shipped rules with inert Hyprland objects; no compositor/input.
local callbacks = {}
local active = nil
local layers = {}
local dispatched = nil
local window_rule = nil
hl = {
  bind = function(key, callback) callbacks[key] = callback; return { unbind = function() end } end,
  unbind = function() end,
  get_active_window = function() return active end,
  get_layers = function() return layers end,
  dispatch = function(value) dispatched = value end,
  window_rule = function(value) window_rule = value end,
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
assert(window_rule.match.class == "^companion$")
assert(window_rule.float and window_rule.center and window_rule.no_initial_focus)
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
