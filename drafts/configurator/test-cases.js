'use strict';

// Run the worked references from the v5.1 §9 docx through the engine.
// node test-cases.js

const fs = require('fs');
const path = require('path');
const { proposeBatterySystem, sizePackCount } = require('./configurator');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

let passed = 0, failed = 0;

function show(label, input, expected) {
  const r = proposeBatterySystem(input, config);
  console.log('━'.repeat(78));
  console.log(`▸ ${label}`);
  console.log('  input: ', JSON.stringify(input));
  console.log('  status:', r.status, r.voltage ? `(${r.voltage})` : '');
  if (r.options) {
    r.options.forEach((o, i) => {
      const isRec = r.recommendation && r.recommendation.option_index === i ? ' ★' : '';
      console.log(`  ${o.label}: ${o.battery_series}${isRec}`);
      console.log(`    inverter: ${o.inverter.qty}× ${o.inverter.model}`);
      console.log(`    battery:  ${o.battery.qty}× ${o.battery.model} (${o.battery.total_kwh} kWh)`);
      if (o.cluster_split) console.log(`    clusters: ${o.cluster_split.join('+')}`);
      if (o.control_box) console.log(`    pdu:      ${o.control_box.qty}× ${o.control_box.model}`);
      if (o.racks && o.racks.length) {
        console.log(`    racks:    ${o.racks.map(rk => rk.model ? `${rk.qty}× ${rk.model}` : `${rk.qty}× ${rk.label}`).join(', ')}`);
      }
      if (o.parallel_kit) console.log(`    parallel: ${o.parallel_kit.qty}× kit`);
    });
  }
  if (r.message) console.log('  message:', r.message);

  // Expected check
  if (expected) {
    let ok = true;
    if (expected.status && r.status !== expected.status) ok = false;
    if (expected.voltage && r.voltage !== expected.voltage) ok = false;
    if (expected.option_count != null && (r.options || []).length !== expected.option_count) ok = false;
    if (expected.contains_series && r.options) {
      for (const want of expected.contains_series) {
        if (!r.options.find(o => o.battery_series === want)) { ok = false; break; }
      }
    }
    if (expected.recommended_series && r.options && r.recommendation) {
      const rec = r.options[r.recommendation.option_index];
      if (!rec || rec.battery_series !== expected.recommended_series) ok = false;
    }
    console.log(ok ? '  ✓ PASS' : '  ✗ FAIL');
    ok ? passed++ : failed++;
  }
}

console.log('\n═══ §9LV worked references ═══\n');

show('LV: 100kW / 80kWh, 3-phase commercial backup',
  { load_kw: 100, storage_kwh: 80, phase: '3' },
  { status: 'ok', voltage: 'lv', contains_series: ['SE-F16','SE-F12','SE-F5.12'], recommended_series: 'SE-F16' });

show('LV: 30kW / 50kWh, 3-phase',
  { load_kw: 30, storage_kwh: 50, phase: '3' },
  { status: 'ok', voltage: 'lv', contains_series: ['SE-F16','SE-F12','SE-F5.12'], recommended_series: 'SE-F16' });

show('LV: 10kW / 30kWh, 1-phase residential',
  { load_kw: 10, storage_kwh: 30, phase: '1' },
  { status: 'ok', voltage: 'lv', contains_series: ['SE-F16','SE-F12','SE-F5.12'], recommended_series: 'SE-F16' });

show('LV: 5kW / 15kWh, 1-phase residential (small-app default)',
  { load_kw: 5, storage_kwh: 15, phase: '1' },
  { status: 'ok', voltage: 'lv', contains_series: ['SE-F16','SE-F12','SE-F5.12'], recommended_series: 'SE-F16' });

show('LV: 6kW / 20kWh, off-grid',
  { load_kw: 6, storage_kwh: 20, phase: '1', off_grid: true },
  { status: 'ok', voltage: 'lv', contains_series: ['SE-F16','SE-F12'], recommended_series: 'SE-F16' });

show('LV: 150kW / 200kWh, borderline (only SE-F16 + SE-F12 fit, drop SE-F5.12)',
  { load_kw: 150, storage_kwh: 200, phase: '3' },
  { status: 'ok', voltage: 'lv', recommended_series: 'SE-F16' });

show('LV: 200kW / 600kWh, LV fails → suggest HV',
  { load_kw: 200, storage_kwh: 600, phase: '3' },
  { status: 'suggest_hv' });

console.log('\n═══ §9HV worked references ═══\n');

show('HV: 300kW / 480kWh on 4× SUN-80K (forced HV)',
  { load_kw: 300, storage_kwh: 480, phase: '3', voltage_pref: 'hv' },
  { status: 'ok', voltage: 'hv', contains_series: ['BOS-G','BOS-A','BOS-B'] });

show('HV: 150kW / 360kWh on 2× SUN-80K (forced HV)',
  { load_kw: 150, storage_kwh: 360, phase: '3', voltage_pref: 'hv' },
  { status: 'ok', voltage: 'hv', contains_series: ['BOS-G','BOS-A','BOS-B'] });

show('HV: 100kW / 230kWh on 2× SUN-50K (forced HV)',
  { load_kw: 100, storage_kwh: 230, phase: '3', voltage_pref: 'hv' },
  { status: 'ok', voltage: 'hv', contains_series: ['BOS-G','BOS-A','BOS-B'] });

show('HV: 80kW / 200kWh on 1× SUN-80K (BOS-B floor trap)',
  { load_kw: 80, storage_kwh: 200, phase: '3', voltage_pref: 'hv' },
  { status: 'ok', voltage: 'hv' });

show('HV: 60kW / 90kWh (engine picks 1× 80K, BOS-A + BOS-G fit; docx scenario assumed 2× 30K)',
  { load_kw: 60, storage_kwh: 90, phase: '3', voltage_pref: 'hv' },
  { status: 'ok', voltage: 'hv' });

console.log('\n═══ §9.0 routing edge cases ═══\n');

show('Customer says "LV", 50kW load (would normally pass to HV via Check 3)',
  { load_kw: 50, storage_kwh: 100, phase: '3', voltage_pref: 'lv' },
  { status: 'ok', voltage: 'lv' });

show('Customer says "HV", small 5kW / 15kWh: BOS-G/A/B all hit min-per-cluster floor, no HV fit',
  { load_kw: 5, storage_kwh: 15, phase: '3', voltage_pref: 'hv' },
  { status: 'no_hv_fit' });

show('Need-input: missing storage_kwh',
  { load_kw: 10, phase: '1' },
  { status: 'need_input' });

console.log('\n═══ 2% tolerance unit checks ═══\n');

console.log('80 / 16   = 5 packs (exact):                  ', sizePackCount(80, 16, 2));
console.log('82 / 16   = 6 packs (floor 5 = 80, 2.4% under): ', sizePackCount(82, 16, 2));
console.log('81 / 16   = 5 packs (floor 5 = 80, 1.2% under): ', sizePackCount(81, 16, 2));
console.log('230 / 16.08 = 15 modules (floor 14 = 225, 2.1% under, fails 2%): ', sizePackCount(230, 16.08, 2));
console.log('200 / 16.08 = 13 modules (floor 12 = 193, 3.5% under, fails 2%): ', sizePackCount(200, 16.08, 2));
console.log('196 / 16.08 = 12 modules (floor 12 = 193, 1.5% under, passes 2%): ', sizePackCount(196, 16.08, 2));

console.log('\n━'.repeat(39));
console.log(`Done. ${passed} passed, ${failed} failed.\n`);
