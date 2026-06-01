# Configurator tool — draft

Architecture sketch for moving §9 (LV+HV battery configurator doctrine)
out of the master prompt and into a deterministic tool that Sunny calls.

This folder is a DRAFT, isolated from `src/`. Nothing here is wired into
the live agent yet. Review, tune, then we splice in.

## Why this exists

Recent failure pattern (see `docs/agent-improvement-brainstorm-2026-05-15.txt`):
prompt → model violates → patch with code → add another `Never X` to the
prompt. We've added 16 sequential post-generation cleanup passes. Each
exists because §9, a 550-line in-context program, leaks back to customers.
The doctrine itself ("§9.0 Check 2", "Step N", pre-send checklist labels)
is the model's mental model and it can't help echoing the structure.

The fix: **make §9 a tool the model calls**, not a script it reads. The
model can't leak what isn't in its prompt. Sizing math becomes 100%
deterministic. Edge cases (2% tolerance, equal modules per inverter,
BOS-B floor, BOS-A rack picking) execute in code.

## Components

```
drafts/configurator/
├── README.md             this file
├── config.json           tunable parameters (inverters, packs/series, ceilings, tolerances)
├── configurator.js       deterministic engine, exports proposeBatterySystem()
├── test-cases.js         runs the worked references from the v5.1 docx through the engine
├── admin-ui.html         mock admin page for editing config.json
└── new-section-9.md      what §9 becomes once the tool is live (~30 lines)
```

## How the model uses the tool

Anthropic's tool-use API. We register a `propose_battery_system` tool
with this signature in the `generateReply` call:

```js
{
  name: "propose_battery_system",
  description: "Compute a validated battery + inverter BOM given the customer's requirements.",
  input_schema: {
    type: "object",
    properties: {
      load_kw: { type: "number", description: "Peak load in kW" },
      storage_kwh: { type: "number", description: "Total storage need in kWh" },
      phase: { type: "string", enum: ["1", "3"] },
      voltage_pref: { type: "string", enum: ["lv", "hv", "any"] },
      off_grid: { type: "boolean", description: "Site has no grid connection" },
      max_parallel: { type: "boolean", description: "True only when re-sizing LV at full parallel after customer insisted on LV (Check 5)" }
    },
    required: ["load_kw", "storage_kwh", "phase"]
  }
}
```

The model decides WHEN to call the tool. The tool returns structured
JSON. The model's job after that is purely composition: render the BOM
options in warm Nigerian English, ask for any missing inputs, handle the
HV-suggestion / LV-insist / no-fit branches.

## What §9 becomes

See `new-section-9.md`. The 550-line section collapses to ~30 lines
covering: when to call the tool, how to interpret each `status` value,
how to ask for missing inputs, how to render options. No sizing math.
No decision tree. No worked references. No checklists.

## Tunable from admin

`config.json` holds every parameter the owner currently tunes by editing
prompt text:
- LV inverter list (10 models, with phase + type + power_kw)
- LV pack list (3 SKUs, with kWh + voltage)
- LV ceilings (max packs, max inverters paralleled, default-LV load threshold)
- LV tolerance percent and headroom factor
- HV inverter list (3 models, with max_clusters + max_charge_a + battery_v range)
- HV battery series (3 series, with module_kwh, min/max per cluster, PDU model)
- HV rack rules (3U capacity for BOS-G, RACK11/RACK14 capacity for BOS-A)
- HV tolerance percent
- Hard rules: equal_modules_per_inverter, drop_on_floor_violation

The admin UI mockup (`admin-ui.html`) shows what the editing surface
looks like. In production, edits would Save to GitHub and Deploy via
Railway exactly like the prompt editor today.

## Migration plan (for later)

1. Land this draft, owner reviews the engine logic and admin UI.
2. Move `configurator.js` and `config.json` into `src/` proper.
3. Add the tool definition to `src/claude.js > generateReply`.
4. Add a tool-result handler that re-prompts the model with the tool's
   response so it can compose the customer reply.
5. Replace `src/prompts/system.md` §9 (currently ~550 lines) with the
   slim 30-line version from `new-section-9.md`.
6. Retire most of `cleanupBomReply` (the doctrine-leak strippers
   become unnecessary).
7. Keep the existing `hv_validator.js` as a final-pass sanity check on
   the model's RENDERED output, but it should rarely fire because the
   numbers come straight from the tool.
8. Build the admin UI as a new tab in the SPA.

Estimated impact:
- Master prompt: 1033 lines → ~530 lines (50% reduction).
- Cleanup passes in claude.js: 16 → ~6 (the security guards stay).
- BOM math accuracy: deterministic, tested.
- New failure surface: the model must call the tool correctly with the
  right inputs. Mitigated by tight tool description + a fallback prompt
  when inputs are missing.
