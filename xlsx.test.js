import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { buildQuotationWorkbook } from './xlsx.js';
import { calculate, defaults, samples } from './domain.js';

function unzip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, inflateRawSync(buffer.subarray(start, start + size)).toString('utf8'));
    offset = start + size;
  }
  return entries;
}

const factory = {
  factory: '青岛示例化工有限公司', name: '20IBC of DPG', cas: '67-68-5', purity: '99.5%', quality: '水分≤0.5%，重金属≤10ppm', hazard: '3类 UN1993',
  price: 14000, currency: 'RMB', unit: '吨',
  quoteDate: '2026-11-01', validity: '2026-11-30', incoterm: 'FOB', port: '青岛', loading: '22t/20GP',
  packing: '20IBC 托盘', delivery: '2026 年 11 月', tax: 13, rebate: 13, warehouse: '我方', portfee: '工厂',
  details: '14000 元/吨 青岛 FOB，22t/20GP，不打托，11 月交货',
};

function workbook(mode, overrides = {}, factoryOverride = factory, includeCosting = true) {
  const seed = samples[mode];
  const values = { ...defaults, ...seed, seaMax: seed.seaMax ?? (seed.sea ?? 0) + 500, ...overrides };
  return buildQuotationWorkbook({
    mode,
    values,
    result: calculate(values, mode),
    highFreightResult: calculate({ ...values, sea: values.seaMax }, mode),
    factory: factoryOverride,
    generatedAt: new Date('2026-11-16T12:03:57Z'),
    includeCosting,
  });
}

test('quotation workbook is a valid two-sheet XLSX with an English editable quotation', () => {
  const file = workbook('rmb', { customer: 'Polar Feed', customerTerm: 'CIF', place: 'Oslo', transportMode: '海运整柜', creditMonths: 3, creditPayment: 'L/C' });
  assert.equal(file.filename, 'Quotation_20IBC of DPG_20261116.xlsx');
  assert.equal(file.quoteNo, 'SA-PF-20261116');
  assert.equal(file.buffer.subarray(0, 2).toString(), 'PK');
  const entries = unzip(file.buffer);
  assert.ok(entries.has('[Content_Types].xml'));
  assert.ok(entries.has('xl/workbook.xml'));
  assert.ok(entries.has('xl/worksheets/sheet1.xml'));
  assert.ok(entries.has('xl/worksheets/sheet2.xml'));
  assert.match(entries.get('xl/workbook.xml'), /<sheet name="Quotation"[^>]*\/>/);
  assert.match(entries.get('xl/workbook.xml'), /<sheet name="Costing \(Internal\)"[^>]*\/>/);
  assert.match(entries.get('xl/workbook.xml'), /fullCalcOnLoad="1"/);

  const quote = entries.get('xl/worksheets/sheet1.xml');
  assert.match(quote, /SUNRISE ASIA LIMITED/);
  assert.match(quote, /QUOTATION/);
  for (const label of ['Buyer', 'Quotation No.', 'Date', 'Delivery term', 'Item', 'Product', 'Quantity', 'Specification / Packing', 'Unit Price (USD/kg)', 'Factory', 'Estimated Shipment', 'Remark', 'Currency', 'Validity', 'Payment', 'Notes']) {
    assert.ok(quote.includes(label), `quotation must contain ${label}`);
  }
  assert.ok(!quote.includes('Qty per FCL'));
  assert.ok(!quote.includes('Price basis'));
  assert.match(quote, /<c r="C8" s="39"><v>20000<\/v>/);
  assert.match(entries.get('xl/styles.xml'), /#,##0\.00&quot; kg&quot;/);
  assert.match(quote, /Polar Feed/);
  assert.match(quote, /SA-PF-20261116/);
  assert.match(quote, /16 November 2026/);
  assert.match(quote, /CIF Oslo, BY SEA IN FCL/);
  assert.match(quote, /20IBC of DPG/);
  assert.match(quote, /99\.5%; 20IBC 托盘/);
  assert.match(quote, /3类 UN1993; 水分≤0\.5%，重金属≤10ppm/);
  assert.match(quote, /2\.33/);
  assert.match(quote, /Until 14:00 Beijing time, 30 November 2026/);
  assert.match(quote, /L\/C at 90 days/);
  assert.match(quote, /The credit term validity is subject to Sinosure approval\./);
  assert.doesNotMatch(quote, /报价单|产品 \/ 规格|待确认|SUM\(/);
  assert.match(quote, /<dataValidation[^>]*sqref="E8:E13"/);
  assert.doesNotMatch(quote, /sheetProtection/);

  const cost = entries.get('xl/worksheets/sheet2.xml');
  assert.match(cost, /成本核算与定价依据/);
  assert.match(cost, /青岛示例化工有限公司/);
  assert.match(cost, /03 \/ 成本与利润/);
  assert.match(cost, /1\.1\*\$B\$28\/100/);
  assert.doesNotMatch(cost, /sheetProtection/);
});

test('customer-only export omits every Costing sheet', () => {
  const file = workbook('rmb', { customer: 'Polar Feed', customerTerm: 'CIF', place: 'Oslo', transportMode: '海运整柜', creditMonths: 3, creditPayment: 'L/C' }, factory, false);
  const entries = unzip(file.buffer);
  assert.match(entries.get('xl/workbook.xml'), /<sheet name="Quotation"[^>]*\/>/);
  assert.doesNotMatch(entries.get('xl/workbook.xml'), /Costing/);
  assert.ok(!entries.has('xl/worksheets/sheet2.xml'));
  assert.match(entries.get('xl/worksheets/sheet1.xml'), /CIF Oslo, BY SEA IN FCL/);
  assert.match(entries.get('xl/worksheets/sheet1.xml'), /The credit term validity is subject to Sinosure approval\./);
});

test('multiple products share one quotation with the shortest factory validity', () => {
  const base = { ...defaults, ...samples.rmb, customer: 'Polar Feed', customerTerm: 'CIF', place: 'Oslo', transportMode: '海运拼箱', creditMonths: 3, creditPayment: 'L/C' };
  const items = [
    { product: 'MCP 22%', sell: 0.99, purity: '22% P', quality: 'Water ≤0.5%', packing: '25 kg / bag, without pallets', factoryName: 'YUN TIAN HUA', validity: '2026-11-20', delivery: 'November 2026' },
    { product: 'DAP 18-46', sell: 1.08, purity: '18% N / 46% P2O5', quality: 'Granular', packing: '50 kg / bag', factoryName: 'CHUAN JIN NUO', validity: '2026-11-25', delivery: 'December 2026' },
    { product: 'Urea 46%', sell: 0.72, purity: '46% N', quality: 'Prilled', packing: '50 kg / bag', factoryName: 'HANYONG', validity: '2026-12-05', delivery: 'January 2027' },
  ].map((row, index) => {
    const values = { ...base, product: row.product, sell: row.sell };
    const itemFactory = { ...factory, id: `f-${index}`, name: row.product, factory: row.factoryName, purity: row.purity, quality: row.quality, packing: row.packing, validity: row.validity, delivery: row.delivery };
    return { mode: 'rmb', values, result: calculate(values, 'rmb'), highFreightResult: calculate({ ...values, sea: values.seaMax }, 'rmb'), factory: itemFactory };
  });
  const file = buildQuotationWorkbook({ items, generatedAt: new Date('2026-11-16T12:03:57Z') });
  assert.equal(file.filename, 'Quotation_MCP 22%_3items_20261116.xlsx');
  assert.equal(file.quoteNo, 'SA-PF-20261116');
  const entries = unzip(file.buffer);
  const workbookXml = entries.get('xl/workbook.xml');
  assert.match(workbookXml, /<sheet name="Quotation"/);
  assert.match(workbookXml, /<sheet name="Costing 1"/);
  assert.match(workbookXml, /<sheet name="Costing 2"/);
  assert.match(workbookXml, /<sheet name="Costing 3"/);
  assert.ok(entries.has('xl/worksheets/sheet4.xml'));
  const quote = entries.get('xl/worksheets/sheet1.xml');
  assert.match(quote, /MCP 22%/);
  assert.match(quote, /DAP 18-46/);
  assert.match(quote, /Urea 46%/);
  assert.match(quote, /YUN TIAN HUA/);
  assert.match(quote, /CHUAN JIN NUO/);
  assert.match(quote, /HANYONG/);
  assert.match(quote, /22% P; 25 kg \/ bag, without pallets/);
  assert.match(quote, /Water ≤0\.5%/);
  assert.match(quote, /CIF Oslo, BY SEA IN LCL/);
  assert.match(quote, /Until 14:00 Beijing time, 20 November 2026/);
  assert.match(quote, /L\/C at 90 days/);
  assert.ok(!quote.includes('Qty per FCL'));
  assert.ok(!quote.includes('Price basis'));
});

test('delivery term appends the English transport mode', () => {
  for (const [mode, phrase] of [
    ['海运整柜', 'BY SEA IN FCL'],
    ['海运拼箱', 'BY SEA IN LCL'],
    ['空运', 'BY AIR'],
    ['铁路', 'BY RAIL'],
    ['公路', 'BY ROAD'],
    ['快递', 'BY COURIER'],
  ]) {
    const quote = unzip(workbook('rmb', { customerTerm: 'CIF', place: 'Oslo', transportMode: mode }).buffer).get('xl/worksheets/sheet1.xml');
    assert.ok(quote.includes(`CIF Oslo, ${phrase}`), `${mode} must render ${phrase}`);
  }
  const untagged = unzip(workbook('rmb', { customerTerm: 'CIF', place: 'Oslo', transportMode: '' }).buffer).get('xl/worksheets/sheet1.xml');
  assert.ok(untagged.includes('CIF Oslo'));
  assert.ok(!untagged.includes('CIF Oslo,'));
});

test('missing buyer, terms and factory data stay blank for the salesperson', () => {
  const file = workbook('rmb', { customer: '', customerTerm: '待确认', place: '', creditPayment: '', creditMonths: null }, null);
  const quote = unzip(file.buffer).get('xl/worksheets/sheet1.xml');
  assert.match(quote, /<c r="B4" s="33"\/>/);
  assert.match(quote, /Buyer/);
  assert.match(quote, /<c r="E5" s="33"\/>/);
  assert.match(quote, /<c r="C8" s="39"><v>20000<\/v>/);
  assert.match(quote, /<c r="D8" s="35"\/>/);
  assert.match(quote, /<c r="E8" s="38"><v>2\.33<\/v>/);
  assert.match(quote, /<c r="F8" s="36"\/>/);
  assert.match(quote, /<c r="G8" s="36"\/>/);
  assert.match(quote, /<c r="H8" s="35"\/>/);
  assert.doesNotMatch(quote, /待确认|CIF Oslo|L\/C at/);
  assert.match(quote, /<c r="E16" s="33"\/>/);
  assert.match(quote, /<c r="C17" s="33"[^>]*>.*The credit term validity is subject to Sinosure approval\./s);
});

test('own-factory quotation keeps reverse-price formulas and does not show purchase inputs', () => {
  const file = workbook('own', { sea: 100, seaMax: 300 });
  const cost = unzip(file.buffer).get('xl/worksheets/sheet2.xml');
  assert.match(cost, /人民币含税倒推价/);
  assert.match(cost, /美元不含税倒推价/);
  assert.match(cost, /1\+\$B\$24\/100/);
  assert.doesNotMatch(cost, /<t xml:space="preserve">含税采购单价<\/t>/);
  assert.doesNotMatch(cost, /<t xml:space="preserve">买汇 \/ 成本汇率<\/t>/);
});

test('USD quotation shifts formula references and omits VAT/rebate inputs', () => {
  const file = workbook('usd', { sea: 2900, seaMax: 3500, credit: 0.441 });
  const cost = unzip(file.buffer).get('xl/worksheets/sheet2.xml');
  assert.doesNotMatch(cost, /<t xml:space="preserve">增值税率<\/t>/);
  assert.doesNotMatch(cost, /<t xml:space="preserve">退税率<\/t>/);
  assert.match(cost, /\$B\$26\/100/);
  assert.match(cost, /\$B\$29/);
  assert.match(cost, /人民币利润/);
});
