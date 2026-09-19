-- Execute the shipped binding against a small compositor model. Release
-- callbacks see the released key as still down, just like Hyprland 0.56.2.
local bindings = {}
local down = {}
local events = {}
local pressed = true
local layers = {}
local removed = {}

hl = {
  dsp = {
    group = { next = function()
      return function() table.insert(events, { name = "group-next" }) end
    end },
    global = function(name)
      return function()
        table.insert(events, { name = name, pressed = pressed })
      end
    end,
  },
  bind = function(key, callback, options)
    local binding = { key = key, callback = callback, options = options }
    table.insert(bindings, binding)
    return { unbind = function() end }
  end,
  unbind = function(key) removed[key] = true end,
  get_layers = function() return layers end,
  dispatch = function(callback)
    callback()
  end,
  is_key_down = function(key)
    return down[key] == true
  end,
  layer_rule = function() end,
  on = function() end,
}

dofile(arg[1])

-- Other features may register shortcuts before history. Select the actual
-- chord rather than depending on its position in the adapter's source file.
local history_binding
local pause_binding
local focus_binding
local tab_binding
for _, binding in ipairs(bindings) do
  if binding.key == "SUPER + ALT + V" then
    history_binding = binding
  elseif binding.key == "SUPER + ALT + P" then
    pause_binding = binding
  elseif binding.key == "SUPER + ALT + D" then
    focus_binding = binding
  elseif binding.key == "SUPER + ALT + TAB" then
    tab_binding = binding
  end
end
assert(history_binding, "History shortcut must be registered")
assert(pause_binding, "Pause shortcut must be registered")
assert(focus_binding and focus_binding.options.transparent, "Focus shortcut must preserve releases")
assert(tab_binding and tab_binding.options.transparent, "Tab shortcut must preserve releases")
assert(removed["SUPER + ALT + TAB"], "Replace the stock Tab binding once, retaining its fallback")

local function event_count(name)
  local count = 0
  for _, event in ipairs(events) do
    if event.name == name then
      count = count + 1
    end
  end
  return count
end

local function release(key, history_release)
  pressed = false

  -- A nested hl.dsp.global call marks the original Lua history binding for a
  -- second callback on V-up. The QML service must ignore that history release.
  if key == "v" and history_release ~= false then
    history_binding.callback()
  end

  for _, binding in ipairs(bindings) do
    if binding.key:lower() == key:lower() and binding.options.release then
      assert(binding.options.non_consuming, "Ordinary typing must pass through")
      binding.callback()
    end
  end
  down[key] = false
end

local orders = {
  { 1, 2, 3 }, { 1, 3, 2 }, { 2, 1, 3 },
  { 2, 3, 1 }, { 3, 1, 2 }, { 3, 2, 1 },
}
for _, super in ipairs({ "Super_L", "Super_R" }) do
  for _, alt in ipairs({ "Alt_L", "Alt_R" }) do
    for _, order in ipairs(orders) do
      events = {}
      down = { v = true, [super] = true, [alt] = true }
      pressed = true
      history_binding.callback()
      assert(event_count("companion:history") == 1)

      local keys = { "v", super, alt }
      release(keys[order[1]])
      assert(event_count("companion:finish") == 0, "First release must not type")
      release(keys[order[2]])
      assert(event_count("companion:finish") == 0, "Second release must not type")
      release(keys[order[3]])
      assert(event_count("companion:finish") == 1, "Last release completes once")
      assert(events[#events].pressed == false, "Finish must be a released event")

      -- Further modifier releases cannot repeat recovery.
      release(super)
      release(alt)
      down.v = true
      release("v", false)
      assert(event_count("companion:finish") == 1)
    end
  end
end

-- Holding both left and right variants still waits for the final physical key.
events = {}
down = { v = true, Super_L = true, Super_R = true, Alt_L = true, Alt_R = true }
pressed = true
history_binding.callback()
for _, key in ipairs({ "v", "Super_L", "Alt_L", "Super_R" }) do
  release(key)
  assert(event_count("companion:finish") == 0)
end
release("Alt_R")
assert(event_count("companion:finish") == 1)
print("PASS all release permutations, both modifier sides, and exactly-once finish")

-- The pause chord has its own global event. Sharing modifiers with a held
-- history chord must leave the history completion path intact.
events = {}
down = { v = true, Super_L = true, Alt_L = true }
pressed = true
history_binding.callback()
pause_binding.callback()
assert(event_count("companion:pause") == 1, "Pause press dispatches its own global event")
assert(event_count("companion:finish") == 0, "Pause must not finish held history")
release("v")
release("Alt_L")
release("Super_L")
assert(event_count("companion:finish") == 1, "History still finishes on its final release")
assert(event_count("companion:pause") == 1, "History releases must not dispatch pause again")
print("PASS independent pause dispatch during a held history chord")

events = {}
down = { v = true, Super_L = true, Alt_L = true }
pressed = true
history_binding.callback()
focus_binding.callback()
assert(event_count("companion:focus") == 1, "Focus press dispatches its own event")
assert(event_count("companion:finish") == 0, "Focus must not finish held history")
release("v")
release("Alt_L")
release("Super_L")
assert(event_count("companion:finish") == 1, "History releases still finish exactly once")
assert(event_count("companion:focus") == 1, "History releases must not toggle focus")
print("PASS independent focus dispatch during a held history chord")

for _, mapped in ipairs({false, true}) do
  events = {}
  layers = {{namespace = "companion-panel", mapped = mapped}}
  tab_binding.callback()
  assert(event_count(mapped and "companion:next-tab" or "group-next") == 1)
  assert(#events == 1, "Tab takes exactly one path")
end
events = {}
layers = {}
tab_binding.callback()
assert(event_count("group-next") == 1, "Group navigation works without a running panel")
for _, binding in ipairs(bindings) do
  assert(not binding.key:match("^SUPER %+ ALT %+ %d$"), "Numbered shortcuts remain local")
end
print("PASS panel Tab routing and native fallback without global number bindings")
