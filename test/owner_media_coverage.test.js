'use strict';
// Run with: node --test test/owner_media_coverage.test.js
//
// Guards the 2026-07-12 Owner Q&A capability fix: Sunny told the owner it
// could not send datasheets/photos automatically and asked for "a media
// library endpoint", when the datasheet and photo fast-paths have been live
// since May. The flagged requests were items with NO file uploaded (all three
// solar panels, racks, PDUs). buildMediaCoverageSummary gives the Owner Q&A
// snapshot the real picture: the capability exists, and exactly which items
// are missing files.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = process.env.DB_PATH || path.join(os.tmpdir(), 'sunny-media-cov-test-' + process.pid + '.db');

const { buildMediaCoverageSummary } = require('../src/owner_qa.js');

function item(brand, model, hasDs, photoCount) {
  return {
    brand,
    model,
    datasheet_path: hasDs ? `/data/warehouse_datasheets/${model}.pdf` : null,
    photos: Array.from({ length: photoCount }, (_, i) => ({ id: i + 1, status: 'active' }))
  };
}

test('counts items with datasheets and photos', () => {
  const cov = buildMediaCoverageSummary([
    item('Deye', 'SE-F5.12', true, 1),
    item('Jinko', '720 watt', false, 0),
    item('Longi', '650 watt', false, 0)
  ]);
  assert.equal(cov.items_total, 3);
  assert.equal(cov.items_with_datasheet, 1);
  assert.equal(cov.items_with_photos, 1);
});

test('lists the models missing datasheets and photos', () => {
  const cov = buildMediaCoverageSummary([
    item('Deye', 'SE-F5.12', true, 1),
    item('Jinko', '720 watt', false, 0)
  ]);
  assert.deepEqual(cov.missing_datasheet, ['Jinko 720 watt']);
  assert.deepEqual(cov.missing_photos, ['Jinko 720 watt']);
});

test('caps the missing lists and reports the remainder', () => {
  const items = Array.from({ length: 20 }, (_, i) => item('Brand', `Model-${String(i).padStart(2, '0')}`, false, 0));
  const cov = buildMediaCoverageSummary(items);
  assert.equal(cov.missing_datasheet.length, 15);
  assert.match(cov.missing_datasheet[14], /and 6 more/);
});

test('states the capability exists so the model cannot claim otherwise', () => {
  const cov = buildMediaCoverageSummary([]);
  assert.match(cov.how_it_works, /already/i);
  assert.match(cov.how_it_works, /Warehouse Stock/);
});

test('tolerates null input', () => {
  const cov = buildMediaCoverageSummary(null);
  assert.equal(cov.items_total, 0);
});
