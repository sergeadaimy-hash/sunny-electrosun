'use strict';

// Deterministic HV BOM validator. Runs as a guard AFTER the model generates a
// reply, BEFORE the reply is sent. Catches the recurring math failures the
// prompt cannot reliably prevent: BOS-B clusters below the 7-module floor,
// more clusters than the minimum needed, uneven splits. Invalid options are
// silently dropped from the reply (matching the prompt's "drop unviable
// silently" doctrine). If every option is invalid, the caller falls back to a
// deflection.
//
// Engineering constants are the single source of truth — the prompt mirrors
// them in §9 but the code is authoritative. If a constant ever changes,
// update it HERE first, then sync the prompt.

// Module energy (kWh) per battery series.
const MODULE_KWH = {
  'BOS-A': 7.68,
  'BOS-B': 16.08,
  'BOS-G': 5.12
};

// Minimum modules per cluster per series. BOS-A and BOS-B share a 7-floor;
// BOS-G floors at 5. Cluster below floor = drop the option silently.
const SERIES_MIN_PER_CLUSTER = {
  'BOS-A': 7,
  'BOS-B': 7,
  'BOS-G': 5
};

// Maximum modules per cluster per (inverter, series). The 80K opens up
// BOS-A to 21 and BOS-B to 16; the 30K/50K cap BOS-A at 16 and BOS-B at 13.
const MAX_PER_CLUSTER = {
  '30K': { 'BOS-G': 16, 'BOS-A': 16, 'BOS-B': 13 },
  '50K': { 'BOS-G': 16, 'BOS-A': 16, 'BOS-B': 13 },
  '80K': { 'BOS-G': 16, 'BOS-A': 21, 'BOS-B': 16 }
};

// PDU model per series (used when validating Control Box line, not yet enforced).
const SERIES_PDU = {
  'BOS-A': 'BOS-A-PDU-2',
  'BOS-B': 'BOS-B-PDU',
  'BOS-G': 'BOS-G-PDU-2'
};

// Header pattern. Tolerates em-dash, en-dash, ascii dash, optional asterisks.
const OPTION_HEADER_RE = /\*?\s*Option\s+(\d+)\s*[—–-]\s*(BOS-[ABG])\s*\*?/i;
const OPTION_HEADER_GLOBAL_RE = /\*?\s*Option\s+\d+\s*[—–-]\s*BOS-[ABG]\s*\*?/gi;

// Strip leading markdown emphasis so "**Inverter:**" parses the same as "Inverter:".
function cleanLine(line) {
  return String(line || '').replace(/^[\s*_>•⁠\-]+/, '').replace(/[*_]+/g, '');
}

// "× N" / "x N" / "X N" matcher; returns the captured integer or null.
function parseQtyTimes(text) {
  if (!text) return null;
  const m = String(text).match(/[×xX]\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// "12+12" or "8+8 across 2 inverters" or just "16" → [12,12] / [8,8] / [16].
function parseClusterSplit(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/across\s+\d+\s+inverters?/gi, '').trim();
  const parts = cleaned
    .split(/\s*\+\s*/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts : null;
}

// Extract the inverter capacity code (30K / 50K / 80K) from a full SKU.
function detectInverterCode(text) {
  if (!text) return null;
  const m = String(text).match(/SUN-(30|50|80)K/i);
  return m ? `${m[1]}K` : null;
}

// Compute the ideal cluster split per §9.4 rules: minimum clusters, balanced
// evenly within and across inverters.
function computeExpectedClusterSplit(series, totalModules, inverterCode, inverterQty) {
  const maxPerCluster = MAX_PER_CLUSTER[inverterCode] && MAX_PER_CLUSTER[inverterCode][series];
  if (!maxPerCluster || !totalModules || !inverterQty) return null;

  // Step 1: floor on the minimum number of clusters needed.
  let minClusters = Math.ceil(totalModules / maxPerCluster);

  // Step 2: if multiple inverters, round UP to a multiple of inverterQty so the
  // load splits evenly across inverters. 1 cluster on 2 inverters bumps to 2.
  if (inverterQty > 1) {
    if (minClusters < inverterQty) {
      minClusters = inverterQty;
    } else if (minClusters % inverterQty !== 0) {
      minClusters = Math.ceil(minClusters / inverterQty) * inverterQty;
    }
  }

  // Step 3: distribute modules as evenly as possible. Remainder spreads across
  // the first `extra` clusters (each one gets +1).
  const base = Math.floor(totalModules / minClusters);
  const extra = totalModules % minClusters;
  const split = [];
  for (let i = 0; i < minClusters; i++) {
    split.push(i < extra ? base + 1 : base);
  }
  return split;
}

// Locate every option block in the reply. Returns [{start, end, text}, ...]
// in source order.
function splitIntoOptionBlocks(text) {
  if (!text) return [];
  const indices = [];
  let m;
  // Reset regex state because lastIndex persists across calls.
  OPTION_HEADER_GLOBAL_RE.lastIndex = 0;
  while ((m = OPTION_HEADER_GLOBAL_RE.exec(text)) !== null) {
    indices.push(m.index);
  }
  if (indices.length === 0) return [];
  const blocks = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : text.length;
    blocks.push({ start, end, text: text.slice(start, end) });
  }
  return blocks;
}

// Parse one option block into a structured shape. Returns null if the header
// doesn't match (caller should skip).
function parseOptionBlock(blockText) {
  const headerMatch = blockText.match(OPTION_HEADER_RE);
  if (!headerMatch) return null;
  const optionNum = parseInt(headerMatch[1], 10);
  const series = headerMatch[2].toUpperCase();

  const lines = blockText.split('\n').map(cleanLine);
  let inverterLine = null;
  let batteryLine = null;
  let clusterSplitLine = null;
  let pduLine = null;
  let racksLine = null;
  let cablesLine = null;

  for (const line of lines) {
    if (/^Inverter\s*:/i.test(line)) inverterLine = line;
    else if (/^Battery\s*:/i.test(line)) batteryLine = line;
    else if (/^Cluster\s*split\s*:/i.test(line)) clusterSplitLine = line;
    else if (/^Control\s*Box\s*:/i.test(line) || /^PDU\s*:/i.test(line)) pduLine = line;
    else if (/^Racks?\s*:/i.test(line)) racksLine = line;
    else if (/^Cables?\s*:/i.test(line)) cablesLine = line;
  }

  const inverterCode = detectInverterCode(inverterLine);
  const inverterQty = parseQtyTimes(inverterLine);

  let totalModules = null;
  let totalKwh = null;
  if (batteryLine) {
    const mm = batteryLine.match(/[×xX]\s*(\d+)\s*modules?/i);
    if (mm) totalModules = parseInt(mm[1], 10);
    const mk = batteryLine.match(/\(\s*([\d.]+)\s*kWh\s*\)/i);
    if (mk) totalKwh = parseFloat(mk[1]);
  }

  const splitValue = clusterSplitLine
    ? clusterSplitLine.replace(/^Cluster\s*split\s*:\s*/i, '')
    : null;
  const actualSplit = parseClusterSplit(splitValue);

  const pduQty = pduLine ? parseQtyTimes(pduLine) : null;

  return {
    optionNum,
    series,
    inverterCode,
    inverterQty,
    totalModules,
    totalKwh,
    actualSplit,
    pduQty,
    inverterLine,
    batteryLine,
    clusterSplitLine,
    pduLine,
    racksLine,
    cablesLine
  };
}

// Validate a parsed option against the §9 rules. Returns:
//   { drop: true,  reason, errors }    — option must be removed from the reply
//   { drop: false, passthrough: true } — incomplete parse, leave alone
//   { drop: false }                    — valid, send as-is
function validateOption(parsed) {
  const errors = [];
  // If the parser couldn't read the inverter, battery, or split, we can't
  // validate confidently. Don't risk false positives.
  if (!parsed.inverterCode || !parsed.inverterQty || !parsed.totalModules || !parsed.actualSplit) {
    return { drop: false, passthrough: true, errors: ['incomplete_parse'] };
  }

  const expected = computeExpectedClusterSplit(
    parsed.series,
    parsed.totalModules,
    parsed.inverterCode,
    parsed.inverterQty
  );
  if (!expected) {
    return { drop: false, passthrough: true, errors: ['no_expected_calculable'] };
  }

  const seriesMin = SERIES_MIN_PER_CLUSTER[parsed.series];

  // Floor check (drop on violation, no exceptions).
  if (parsed.actualSplit.some(c => c < seriesMin)) {
    errors.push(
      `${parsed.series} has cluster(s) below floor ${seriesMin}: ${parsed.actualSplit.join('+')}`
    );
    return { drop: true, reason: 'floor_violated_actual', errors };
  }

  // If the math FORCES a sub-floor cluster on the chosen inverter pairing,
  // this series doesn't fit. Drop the option.
  if (expected.some(c => c < seriesMin)) {
    errors.push(
      `${parsed.series} floor ${seriesMin} infeasible at ${parsed.totalModules} modules on ${parsed.inverterCode}× ${parsed.inverterQty}`
    );
    return { drop: true, reason: 'floor_infeasible', errors };
  }

  // Min-clusters check. Actual must NOT exceed expected.
  if (parsed.actualSplit.length > expected.length) {
    errors.push(
      `Too many clusters: actual=${parsed.actualSplit.length} expected=${expected.length} ` +
      `(${parsed.totalModules} ${parsed.series} on ${parsed.inverterCode} × ${parsed.inverterQty})`
    );
    return { drop: true, reason: 'too_many_clusters', errors };
  }

  // Same count but distribution differs → unbalanced split.
  if (parsed.actualSplit.length === expected.length) {
    const sortedActual = [...parsed.actualSplit].sort((a, b) => a - b);
    const sortedExpected = [...expected].sort((a, b) => a - b);
    const matches = sortedActual.every((v, i) => v === sortedExpected[i]);
    if (!matches) {
      errors.push(
        `Uneven split: actual=${parsed.actualSplit.join('+')} expected=${expected.join('+')}`
      );
      return { drop: true, reason: 'uneven_split', errors };
    }
  }

  // PDU count must equal cluster count (1 PDU per cluster).
  if (parsed.pduQty != null && parsed.pduQty !== parsed.actualSplit.length) {
    errors.push(
      `PDU mismatch: pdu_qty=${parsed.pduQty} clusters=${parsed.actualSplit.length}`
    );
    return { drop: true, reason: 'pdu_mismatch', errors };
  }

  return { drop: false, errors };
}

// Renumber surviving "*Option N —" headers sequentially starting at 1, so the
// customer never sees "Option 1, Option 3".
function renumberRemainingOptions(text) {
  let counter = 0;
  return text.replace(
    /(\*?\s*Option\s+)(\d+)(\s*[—–-]\s*BOS-[ABG]\s*\*?)/gi,
    (_match, p1, _p2, p3) => {
      counter++;
      return `${p1}${counter}${p3}`;
    }
  );
}

// Strip a single block from the full reply text. Collapse the gap so we don't
// leave a double blank line.
function stripBlockFromText(fullText, block) {
  const before = fullText.slice(0, block.start).replace(/\s+$/, '');
  const after = fullText.slice(block.end).replace(/^\s+/, '');
  if (!before) return after;
  if (!after) return before;
  return `${before}\n\n${after}`;
}

// Main entry. Returns one of:
//   { ok: true,  text, changed: false }                         — no BOM in reply, or all options valid
//   { ok: true,  text, changed: true, drops, survivors }        — some options stripped, rest sent
//   { ok: false, text: null, droppedAll: true, drops }          — every option invalid; caller deflects
function validateAndFixHvBom(replyText) {
  if (!replyText) return { ok: true, text: replyText, changed: false };

  const blocks = splitIntoOptionBlocks(replyText);
  if (blocks.length === 0) {
    return { ok: true, text: replyText, changed: false };
  }

  const enriched = blocks
    .map(b => ({ ...b, parsed: parseOptionBlock(b.text) }))
    .filter(b => b.parsed);

  if (enriched.length === 0) {
    return { ok: true, text: replyText, changed: false };
  }

  const decisions = enriched.map(b => ({ block: b, validation: validateOption(b.parsed) }));
  const drops = decisions.filter(d => d.validation.drop);
  const survivors = decisions.filter(d => !d.validation.drop);

  if (drops.length === 0) {
    return { ok: true, text: replyText, changed: false };
  }

  if (survivors.length === 0) {
    return {
      ok: false,
      text: null,
      changed: true,
      droppedAll: true,
      drops: drops.map(d => ({
        series: d.block.parsed.series,
        reason: d.validation.reason,
        errors: d.validation.errors
      }))
    };
  }

  // Strip blocks back-to-front so indices stay valid.
  let workingText = replyText;
  const dropsDesc = drops.slice().sort((a, b) => b.block.start - a.block.start);
  for (const d of dropsDesc) {
    workingText = stripBlockFromText(workingText, d.block);
  }

  workingText = renumberRemainingOptions(workingText);

  // Repoint any "Recommended: Option N" line. If only one option survives,
  // it's now Option 1. If two or more survive but the recommendation pointed
  // at a dropped option, neutralize it.
  const droppedNumbers = new Set(drops.map(d => d.block.parsed.optionNum));
  const recRe = /\*?\s*Recommended\s*:\s*\*?\s*Option\s+(\d+)[^\n]*/i;
  const recMatch = workingText.match(recRe);
  if (recMatch) {
    const recOldNum = parseInt(recMatch[1], 10);
    if (survivors.length === 1) {
      workingText = workingText.replace(recRe, '*Recommended:* Option 1');
    } else if (droppedNumbers.has(recOldNum)) {
      workingText = workingText.replace(
        recRe,
        '*Recommended:* the team will confirm the best fit on follow-up.'
      );
    } else {
      // Remap the old number to the new renumbered position.
      const survivorOldNums = survivors.map(s => s.block.parsed.optionNum).sort((a, b) => a - b);
      const newIndex = survivorOldNums.indexOf(recOldNum);
      if (newIndex >= 0) {
        workingText = workingText.replace(recRe, `*Recommended:* Option ${newIndex + 1}`);
      }
    }
  }

  return {
    ok: true,
    text: workingText.trim() + '\n',
    changed: true,
    drops: drops.map(d => ({
      series: d.block.parsed.series,
      reason: d.validation.reason,
      errors: d.validation.errors
    })),
    survivors: survivors.map(s => s.block.parsed.series)
  };
}

module.exports = {
  validateAndFixHvBom,
  // exported for tests / future use
  parseOptionBlock,
  splitIntoOptionBlocks,
  validateOption,
  computeExpectedClusterSplit,
  MODULE_KWH,
  MAX_PER_CLUSTER,
  SERIES_MIN_PER_CLUSTER,
  SERIES_PDU
};
