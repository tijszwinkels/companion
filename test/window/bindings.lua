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
active = {class = "companion"}
callbacks["SUPER + ALT + TAB"]()
assert(dispatched == "companion:next-tab")
callbacks["SUPER + code:20"]()
assert(dispatched == "companion:expand-width")
active = {class = "terminal"}
callbacks["SUPER + ALT + TAB"]()
assert(dispatched == "group-next")
callbacks["SUPER + code:20"]()
assert(dispatched == "resize:-100")
layers = {{namespace = "companion-panel", mapped = true}}
callbacks["SUPER + ALT + TAB"]()
assert(dispatched == "companion:next-tab")
print("BINDINGS_PASS")
