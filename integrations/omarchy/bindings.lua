-- Use the resident global-shortcut connection for ordered press/release events.
local history_held = false

hl.bind("SUPER + ALT + V", function()
  history_held = true
  hl.dispatch(hl.dsp.global("companion:history"))
end, {
  description = "Companion utterance history (hold, select, release to paste)",
  -- Lua dispatchers otherwise become shadowed after an arrow binding fires,
  -- which suppresses the V release needed to finish the selection.
  transparent = true,
})

-- Release can precede the first overlay frame, and Alt/Super may already be up.
-- This non-consuming handler leaves ordinary V typing alone and only finishes
-- a chord which started with Super+Alt. No helper-process startup can race it.
hl.bind("V", function()
  if history_held then
    history_held = false
    hl.dispatch(hl.dsp.global("companion:finish"))
  end
end, { release = true, ignore_mods = true, non_consuming = true, transparent = true })

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
