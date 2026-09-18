-- Use the resident global-shortcut connection for ordered press/release events.
local history_held = false

hl.bind("SUPER + ALT + D", hl.dsp.global("companion:focus"), {
  description = "Companion conversation input focus",
  -- Focusing the composer while history is held must not shadow key releases.
  transparent = true,
})

hl.bind("SUPER + ALT + P", hl.dsp.global("companion:pause"), {
  description = "Companion pause/resume listening",
  -- Pausing while history is held must not shadow its final key releases.
  transparent = true,
})

hl.bind("SUPER + ALT + C", hl.dsp.global("companion:panel"), {
  description = "Companion side panel",
  -- Switching away from held history must preserve its final key releases.
  transparent = true,
})

-- The panel owns its horizontal reveal animation, including a quick reversal
-- if the toggle is pressed again before the first animation finishes.
hl.layer_rule({ match = { namespace = "companion-panel" }, no_anim = true, animation = "none" })

hl.bind("SUPER + ALT + V", function()
  history_held = true
  hl.dispatch(hl.dsp.global("companion:history"))
end, {
  description = "Companion utterance history (hold, select, release to paste)",
  -- Lua dispatchers otherwise become shadowed after an arrow binding fires,
  -- which suppresses the V release needed to finish the selection.
  transparent = true,
})

-- V can be released before either modifier. Starting wtype at that point lets
-- Hyprland combine its text with the still-held Super/Alt keys: letters become
-- shortcuts, and later physical releases change the active keyboard mid-text.
-- Complete on the last chord release, however briefly the chord was held.
local history_keys = { "v", "Super_L", "Super_R", "Alt_L", "Alt_R" }

local function finish_history(released_key)
  if not history_held then
    return
  end

  for _, key in ipairs(history_keys) do
    -- Hyprland removes the released key from is_key_down *after* this callback.
    -- Account for this event explicitly; the other keys still reflect reality.
    if key ~= released_key and hl.is_key_down(key) then
      return
    end
  end

  history_held = false
  hl.dispatch(hl.dsp.global("companion:finish"))
end

for _, key in ipairs(history_keys) do
  -- Keep ordinary V/modifier input intact. These resident callbacks also work
  -- when a tap finishes before the first picker frame or modifiers go up first.
  hl.bind(key, function()
    finish_history(key)
  end, { release = true, ignore_mods = true, non_consuming = true, transparent = true })
end

-- Match Omarchy's other keyboard-driven overlays: map immediately, so a short
-- hold does not lose navigation/release events during a compositor fade.
hl.layer_rule({ match = { namespace = "companion-history" }, no_anim = true, animation = "none" })

-- Keep keyboard focus in the destination application. Only the navigation keys
-- are captured while the picker is visible; closing it removes these bindings.
-- This also keeps the original chord's release on the same compositor path.
local navigation = {}

hl.on("layer.opened", function(layer)
  if layer.namespace ~= "companion-history" or #navigation > 0 then
    return
  end

  navigation = {
    hl.bind("UP", hl.dsp.global("companion:previous"), { ignore_mods = true, transparent = true }),
    hl.bind("DOWN", hl.dsp.global("companion:next"), { ignore_mods = true, transparent = true }),
    hl.bind("ESCAPE", hl.dsp.global("companion:cancel"), { ignore_mods = true, transparent = true }),
  }
end)

hl.on("layer.closed", function(layer)
  if layer.namespace ~= "companion-history" then
    return
  end

  for _, binding in ipairs(navigation) do
    binding:unbind()
  end
  navigation = {}
end)
