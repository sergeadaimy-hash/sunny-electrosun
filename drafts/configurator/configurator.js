'use strict';

// Sunny battery configurator engine, draft v0.
// Implements §9.0 / §9LV / §9HV from the v5.1 docx as deterministic JS.
// Single entry point: proposeBatterySystem(input, config).
//
// This is a self-contained sketch. Not connected to the live agent. Run
// test-cases.js to exercise it against the worked references in the docx.

// ---------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Compute a validated battery + inverter BOM.
 *
 * @param {Object} input
 * @param {number} input.load_kw         peak load in kW
 * @param {number} input.storage_kwh     total storage need in kWh
 * @param {string} [input.phase]         "1" or "3", customer site phase
 * @param {string} [input.voltage_pref]  "lv" | "hv" | "any" (default "any")
 * @param {boolean} [input.off_grid]     true if site has no grid
 * @param {boolean} [input.max_parallel] true ONLY when re-sizing LV at full
 *                                       parallel after Check 5 (customer
 *                                       insisted on LV)
 * @param {Object} config                see config.json
 *
 * @returns {Object} one of:
 *  { status: "need_input", missing: string[] }
 *  { status: "ok", voltage: "lv"|"hv", options, recommendation, audit }
 *  { status: "suggest_hv", reason, hv_bom, audit }
 *  { status: "no_lv_fit", message, audit }
 *  { status: "no_hv_fit", message, audit }
 *  { status: "no_fit", message, audit }
 */
function proposeBatterySystem(input, config) {
  const audit = [];

  // ---- Validate input
  const missing = [];
  if (typeof input.load_kw !== 'number' || input.load_kw <= 0) missing.push('load_kw');
  if (typeof input.storage_kwh !== 'number' || input.storage_kwh <= 0) missing.push('storage_kwh');
  if (!input.phase || (input.phase !== '1' && input.phase !== '3')) missing.push('phase');
  if (missing.length) return { status: 'need_input', missing };

  const voltagePref = (input.voltage_pref || 'any').toLowerCase();
  const offGrid = !!input.off_grid;
  const maxParallel = !!input.max_parallel;

  // ---- §9.0 Decision tree
  let voltage;
  if (voltagePref === 'lv') {
    voltage = 'lv';
    audit.push('§9.0 Check 1: customer named LV');
  } else if (voltagePref === 'hv') {
    voltage = 'hv';
    audit.push('§9.0 Check 1: customer named HV');
  } else if (input.load_kw <= config.lv.ceilings.load_kw_default_threshold) {
    voltage = 'lv';
    audit.push(`§9.0 Check 2: load ${input.load_kw}kW <= ${config.lv.ceilings.load_kw_default_threshold}kW threshold, LV default`);
  } else {
    audit.push(`§9.0 Check 3: load ${input.load_kw}kW > ${config.lv.ceilings.load_kw_default_threshold}kW threshold, testing LV ceilings`);
    const lvFit = checkLvCeilings(input, config);
    if (lvFit.fits) {
      voltage = 'lv';
      audit.push('§9.0 Check 3: LV ceilings hold, recommend LV');
    } else {
      audit.push(`§9.0 Check 3: LV ceilings fail (${lvFit.reason}), suggesting HV (Check 4)`);
      const hvBom = buildHvBom(input, config);
      hvBom.audit = audit.concat(hvBom.audit || []);
      return {
        status: 'suggest_hv',
        reason: lvFit.reason,
        message: config.messages?.suggest_hv || 'For your load and storage, HV is the cleaner fit.',
        hv_bom: hvBom,
        audit: audit.slice()
      };
    }
  }

  // ---- Build BOM for chosen voltage
  if (voltage === 'lv') {
    return buildLvBom({ ...input, max_parallel: maxParallel, off_grid: offGrid }, config, audit);
  } else {
    return buildHvBom(input, config, audit);
  }
}

// ---------------------------------------------------------------------------
// §9.0 Check 3: LV ceilings test
// ---------------------------------------------------------------------------

function checkLvCeilings(input, config) {
  // Find the smallest inverter count for any LV inverter that matches phase.
  const eligible = config.lv.inverters.filter(inv => inv.phase === input.phase);
  if (eligible.length === 0) {
    return { fits: false, reason: 'no LV inverter for the requested phase' };
  }

  // Min inverter count = ceil(load * headroom / max(eligible inverter kW))
  const headroom = config.lv.headroom_factor;
  const maxInverterKw = Math.max(...eligible.map(i => i.power_kw));
  const minInverterCount = Math.ceil((input.load_kw * headroom) / maxInverterKw);
  if (minInverterCount > config.lv.ceilings.max_inverters_paralleled) {
    return { fits: false, reason: `would need ${minInverterCount} LV inverters (cap ${config.lv.ceilings.max_inverters_paralleled})` };
  }

  // Min pack count = ceil(storage / largest pack), with 2% tolerance.
  const maxPackKwh = Math.max(...config.lv.packs.map(p => p.kwh));
  const minPackCount = sizePackCount(input.storage_kwh, maxPackKwh, config.lv.tolerance_percent);
  if (minPackCount > config.lv.ceilings.max_packs_per_system) {
    return { fits: false, reason: `would need ${minPackCount} largest LV packs (cap ${config.lv.ceilings.max_packs_per_system})` };
  }

  return { fits: true };
}

// ---------------------------------------------------------------------------
// §9LV BUILD
// ---------------------------------------------------------------------------

function buildLvBom(input, config, audit = []) {
  audit = audit.slice();
  audit.push('§9LV: building LV BOM');

  // Phase filter
  let eligibleInverters = config.lv.inverters.filter(inv => inv.phase === input.phase);

  // Off-grid hint: if customer says off_grid, prefer the OG model first;
  // otherwise hide OG from default list (only show if no hybrid fits).
  if (input.off_grid) {
    const og = eligibleInverters.find(inv => inv.type === 'off-grid');
    if (og) {
      eligibleInverters = [og].concat(eligibleInverters.filter(inv => inv !== og));
    }
  } else {
    eligibleInverters = eligibleInverters.filter(inv => inv.type !== 'off-grid');
  }

  if (eligibleInverters.length === 0) {
    return {
      status: 'no_lv_fit',
      message: `No LV inverter matches phase ${input.phase}.`,
      audit
    };
  }

  // For each pack, find the BEST inverter pick using §9LV.4 Step 1 tie-break
  // (lowest count, then closest power match).
  const options = [];
  for (const pack of config.lv.packs) {
    const pick = pickLvInverter(input, pack, eligibleInverters, config, audit);
    if (!pick) continue;

    // Step 2: total packs with 2% tolerance
    const totalPacks = sizePackCount(input.storage_kwh, pack.kwh, config.lv.tolerance_percent);
    if (totalPacks > config.lv.ceilings.max_packs_per_system) {
      audit.push(`§9LV.4: ${pack.model} needs ${totalPacks} packs > ${config.lv.ceilings.max_packs_per_system}, dropped`);
      continue;
    }

    // Step 3: total packs >= inverter count
    if (totalPacks < pick.count) {
      audit.push(`§9LV.4: ${pack.model} needs ${totalPacks} packs but ${pick.count} inverters, dropped`);
      continue;
    }

    options.push({
      label: `Option ${options.length + 1}`,
      battery_series: pack.model,
      inverter: { model: pick.inverter.model, qty: pick.count },
      battery: {
        model: pack.model,
        qty: totalPacks,
        total_kwh: round2(totalPacks * pack.kwh)
      },
      parallel_kit: { qty: pick.count, items: ['comm cable', 'power cable'] },
      cables: { items: ['battery comm bus', 'AC tie'] },
      _internal: { pack_kwh: pack.kwh, inverter_kw: pick.inverter.power_kw }
    });
  }

  if (options.length === 0) {
    if (!input.max_parallel) {
      // First pass failed. Caller may re-call with max_parallel=true after
      // §9.0 Check 5 (customer insisted on LV) — but we already tried max
      // parallel above. So actually no fit means truly no fit.
      audit.push('§9LV: no pack fits within both ceilings');
    }
    return {
      status: 'no_lv_fit',
      message: input.max_parallel
        ? config.messages?.lv_full_parallel_no_fit || 'LV does not fit even at full parallel.'
        : 'No LV configuration fits.',
      audit
    };
  }

  // Recommendation: prefer the option with the fewest TOTAL parts.
  const recommendation = pickLvRecommendation(options);

  return {
    status: 'ok',
    voltage: 'lv',
    options,
    recommendation,
    audit
  };
}

function pickLvInverter(input, pack, eligibleInverters, config, audit) {
  const headroom = config.lv.headroom_factor;
  const maxInverters = config.lv.ceilings.max_inverters_paralleled;
  const offGridPref = !!input.off_grid;
  const candidates = [];

  for (const inv of eligibleInverters) {
    const count = Math.ceil((input.load_kw * headroom) / inv.power_kw);
    if (count > maxInverters) continue;
    candidates.push({
      inverter: inv,
      count,
      score: {
        count,
        oversize: (inv.power_kw * count) - (input.load_kw * headroom),
        // Off-grid preference: when site is off-grid, tie-break for the OG model.
        offGridMatch: offGridPref ? (inv.type === 'off-grid' ? 0 : 1) : 0
      }
    });
  }

  if (candidates.length === 0) return null;

  // Sort: lowest count wins; if tied, off-grid match wins (only when site is
  // off-grid); then smallest oversize wins. §9LV.4 Step 1 tie-break.
  candidates.sort((a, b) => {
    if (a.score.count !== b.score.count) return a.score.count - b.score.count;
    if (a.score.offGridMatch !== b.score.offGridMatch) return a.score.offGridMatch - b.score.offGridMatch;
    return a.score.oversize - b.score.oversize;
  });

  return candidates[0];
}

function pickLvRecommendation(options) {
  // Prefer the option with the FEWEST packs (cleanest install). On a tie,
  // prefer the LARGEST pack capacity (fewer SKUs to manage). On a further
  // tie, prefer the fewest inverters.
  const ranked = options.map((o, i) => ({ idx: i, o })).sort((a, b) => {
    if (a.o.battery.qty !== b.o.battery.qty) return a.o.battery.qty - b.o.battery.qty;
    const aCap = a.o._internal?.pack_kwh || 0;
    const bCap = b.o._internal?.pack_kwh || 0;
    if (aCap !== bCap) return bCap - aCap;
    return a.o.inverter.qty - b.o.inverter.qty;
  });
  return { option_index: ranked[0].idx, reason_internal: 'fewest packs, largest pack capacity, fewest inverters' };
}

// ---------------------------------------------------------------------------
// §9HV BUILD
// ---------------------------------------------------------------------------

function buildHvBom(input, config, audit = []) {
  audit = audit.slice();
  audit.push('§9HV: building HV BOM');

  // HV is 3-phase only. If customer site is 1-phase, HV doesn't apply.
  if (input.phase === '1') {
    return {
      status: 'no_hv_fit',
      message: 'HV inverters are 3-phase only; the site is single-phase.',
      audit
    };
  }

  // Build inverter candidates ranked by FEWEST inverter count (largest model
  // that fits the load wins). Matches the v5.1 docx worked references like
  // "300 kW / 480 kWh on 4× SUN-80K" instead of "10× SUN-30K".
  const candidates = config.hv.inverters
    .map(inv => ({ inv, count: Math.ceil(input.load_kw / inv.power_kw) }))
    .filter(c => c.count <= config.hv.ceilings.max_inverters_paralleled)
    .sort((a, b) => {
      if (a.count !== b.count) return a.count - b.count; // fewest inverters first
      // If tied, prefer larger model (less likely to need extra clusters).
      return b.inv.power_kw - a.inv.power_kw;
    });

  for (const { inv, count: inverterCount } of candidates) {
    audit.push(`§9HV: trying ${inv.model} × ${inverterCount}`);
    const result = sizeHvOnInverter(input, inv, inverterCount, config, audit);
    if (result.options.length > 0) {
      return {
        status: 'ok',
        voltage: 'hv',
        options: result.options,
        recommendation: pickHvRecommendation(result.options),
        audit
      };
    }
    audit.push(`§9HV: ${inv.model} × ${inverterCount} produced no viable series, trying next inverter pick`);
  }

  return {
    status: 'no_hv_fit',
    message: config.messages?.no_hv_fit || 'No HV configuration fits.',
    audit
  };
}

function sizeHvOnInverter(input, inverter, inverterCount, config, audit) {
  const inverterCode = invCode(inverter.model);
  const options = [];

  for (const series of config.hv.series) {
    const result = sizeHvSeriesOnInverter(input, series, inverter, inverterCode, inverterCount, config, audit);
    if (result) options.push(result);
  }

  // Renumber labels
  options.forEach((o, i) => { o.label = `Option ${i + 1}`; });

  return { options };
}

function sizeHvSeriesOnInverter(input, series, inverter, inverterCode, inverterCount, config, audit) {
  // §9HV.4 Step 1: total modules with 2% tolerance.
  const totalModules = sizePackCount(input.storage_kwh, series.module_kwh, config.hv.tolerance_percent);
  audit.push(`§9HV.4 Step 1: ${series.name} needs ${totalModules} modules (target ${input.storage_kwh}kWh, module ${series.module_kwh}kWh)`);

  // §9HV.4 Step 2: minimum clusters.
  const maxPerCluster = series.max_per_cluster[inverterCode];
  if (!maxPerCluster) {
    audit.push(`§9HV.4: ${series.name} has no max_per_cluster for ${inverterCode}, dropped`);
    return null;
  }

  // §9HV.4 Step 3: equal modules per inverter (mandatory).
  // Round total UP to next multiple of inverter count.
  let finalModules = totalModules;
  if (totalModules % inverterCount !== 0) {
    finalModules = Math.ceil(totalModules / inverterCount) * inverterCount;
    audit.push(`§9HV.4 Step 3: ${series.name} bumped ${totalModules} → ${finalModules} for equal split across ${inverterCount} inverters`);
  }
  const modulesPerInverter = finalModules / inverterCount;

  // Clusters per inverter
  const clustersPerInverter = Math.ceil(modulesPerInverter / maxPerCluster);

  // Distribute evenly within an inverter (e.g. 23 modules in 2 clusters → 12+11)
  const clusterSplitPerInverter = distributeEven(modulesPerInverter, clustersPerInverter);

  // Total cluster pattern across all inverters: same pattern repeated
  const totalClusterSplit = [];
  for (let i = 0; i < inverterCount; i++) totalClusterSplit.push(...clusterSplitPerInverter);

  // §9HV.4 Step 4: floor check (drop, never bump)
  const minPerCluster = series.min_per_cluster;
  const violatesFloor = totalClusterSplit.some(c => c < minPerCluster);
  if (violatesFloor) {
    audit.push(`§9HV.4 Step 4: ${series.name} cluster ${Math.min(...totalClusterSplit)} < floor ${minPerCluster}, DROPPED (never bump)`);
    return null;
  }

  // Inverter cluster cap check. NOTE: the v5.1 docx table says
  // SUN-80K max_clusters = 2, but the worked reference 150kW/360kWh runs 3
  // clusters per 80K. Owner needs to clarify whether the table or the
  // examples are authoritative. For now we flag rather than drop, and let
  // the owner resolve via config.hv.enforce_max_clusters_per_inverter.
  if (clustersPerInverter > inverter.max_clusters_per_inverter) {
    if (config.hv.enforce_max_clusters_per_inverter) {
      audit.push(`§9HV.4: ${series.name} needs ${clustersPerInverter} clusters per inverter, exceeds ${inverter.model} cap of ${inverter.max_clusters_per_inverter}, dropped`);
      return null;
    }
    audit.push(`§9HV.4: ${series.name} uses ${clustersPerInverter} clusters per inverter (table cap ${inverter.max_clusters_per_inverter}, enforcement disabled, matches docx worked examples)`);
  }

  // §9HV.4 Step 5: PDUs and racks
  const totalClusters = totalClusterSplit.length;
  const pdus = { model: series.pdu, qty: totalClusters };
  const racks = computeRacks(series, clusterSplitPerInverter, inverterCount, audit);

  return {
    label: 'Option',
    battery_series: series.name,
    inverter: { model: inverter.model, qty: inverterCount },
    battery: {
      model: series.name,
      qty: finalModules,
      total_kwh: round2(finalModules * series.module_kwh)
    },
    cluster_split: totalClusterSplit,
    cluster_split_per_inverter: clusterSplitPerInverter,
    control_box: pdus,
    racks,
    cables: { items: ['power kit', 'comm kit'], qty: totalClusters },
    _internal: { modules_per_inverter: modulesPerInverter, clusters_per_inverter: clustersPerInverter }
  };
}

function distributeEven(total, buckets) {
  const base = Math.floor(total / buckets);
  const extra = total % buckets;
  const split = [];
  for (let i = 0; i < buckets; i++) {
    split.push(i < extra ? base + 1 : base);
  }
  return split;
}

function computeRacks(series, clusterSplitPerInverter, inverterCount, audit) {
  const rack = series.rack;
  if (rack.kind === 'team_confirmed') {
    return [{ label: rack.label, qty: clusterSplitPerInverter.length * inverterCount }];
  }

  if (rack.kind === 'single_type') {
    // BOS-G: 12 modules per 3U rack. 13-16 → 2 racks.
    let totalRacks = 0;
    for (let i = 0; i < inverterCount; i++) {
      for (const clusterModules of clusterSplitPerInverter) {
        totalRacks += clusterModules <= rack.modules_per_rack ? 1 : 2;
      }
    }
    return [{ model: rack.model, qty: totalRacks }];
  }

  if (rack.kind === 'two_type') {
    // BOS-A pick rules per cluster
    const racks = {};
    for (let i = 0; i < inverterCount; i++) {
      for (const clusterModules of clusterSplitPerInverter) {
        const rule = rack.pick_rules.find(r => clusterModules >= r.modules_min && clusterModules <= r.modules_max);
        if (!rule) {
          audit.push(`computeRacks: BOS-A cluster of ${clusterModules} modules has no rack rule, skipping`);
          continue;
        }
        for (const item of rule.result) {
          const refRack = item.ref === 'rack_a' ? rack.rack_a : rack.rack_b;
          racks[refRack.model] = (racks[refRack.model] || 0) + item.qty;
        }
      }
    }
    return Object.entries(racks).map(([model, qty]) => ({ model, qty }));
  }

  return [];
}

function pickHvRecommendation(options) {
  // Prefer the option with the FEWEST modules (cleanest install). Tie-break:
  // fewest clusters.
  let bestIdx = 0;
  let best = options[0];
  for (let i = 1; i < options.length; i++) {
    const o = options[i];
    if (o.battery.qty < best.battery.qty
        || (o.battery.qty === best.battery.qty && o.cluster_split.length < best.cluster_split.length)) {
      best = o;
      bestIdx = i;
    }
  }
  return { option_index: bestIdx, reason_internal: 'fewest modules' };
}

// ---------------------------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------------------------

/**
 * §9LV.4 Step 2 / §9HV.4 Step 1: 2% tolerance.
 * Use floor count if it's within 2% below the storage target. Else ceil.
 */
function sizePackCount(storageKwh, packKwh, tolerancePercent) {
  if (storageKwh <= 0 || packKwh <= 0) return 0;
  const ceil = Math.ceil(storageKwh / packKwh);
  const floor = Math.floor(storageKwh / packKwh);
  if (floor <= 0) return ceil;
  const floorKwh = floor * packKwh;
  const underByFraction = (storageKwh - floorKwh) / storageKwh;
  return underByFraction <= (tolerancePercent / 100) ? floor : ceil;
}

function invCode(model) {
  const m = String(model).match(/SUN-(\d+)K/i);
  return m ? `${m[1]}K` : null;
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  proposeBatterySystem,
  // exported for tests
  sizePackCount,
  distributeEven,
  checkLvCeilings,
  buildLvBom,
  buildHvBom,
  pickLvInverter
};
