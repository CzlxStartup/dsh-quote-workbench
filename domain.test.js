import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as d from './domain.js';

const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-9, `${actual} != ${expected}`);
const input = (mode='rmb') => ({...d.defaults,...d.samples[mode],credit:.441,seaMax:7000});
const freight = (extra={}) => ({agent:'货代甲',route:'上海 → 汉堡',transportMode:'海运整柜',basis:'20GP / 全包',valid:'2026-12-01',sea:1000,local:500,...extra});

test('exports the requested domain API and RMB freight maximum field',()=>{
  for(const name of ['basic','costs','params','factoryFields','freightFields','defaults','samples','transportModes','creditCountries','lookupCreditRate','calculate','fcaCost','validRebate','validateCalculation','parseQuotes','validateRecord','validateDatabase','averageFreights']) assert.ok(name in d,name);
  assert.ok(d.costs.some(([key])=>key==='seaMax'));
});
test('RMB rebate, insurance, interest and freight bounds retain original formulas',()=>{
  const v=input(), low=d.calculate(v,'rmb'), high=d.calculate({...v,sea:v.seaMax},'rmb');
  near(d.fcaCost(v),14.2/1.13/6.67);
  near(low.insurance,20000*2.33*1.1*.03/100);
  near(low.credit,20000*2.33*.441/100);
  near(low.interest,20000*2.33*.036/12*3);
  near(high.landed-low.landed,.1);
  near(low.profit-high.profit,2000);
  near(low.margin,low.profit/(low.base*v.qty));
  near(d.fcaCost({...v,rebate:0}),v.buy/v.fx);
});
test('USD uses purchase and receipt FX separately; reverse mode preserves original formula',()=>{
  const v=input('usd'), r=d.calculate(v,'usd');
  near(r.base,21.5+8000/6.85/8000);
  near(r.landed,r.base+2900/8000);
  near(r.rmb,8000*24.5*6.75-(r.insurance+r.credit+r.interest)*6.85-r.landed*6.85*8000);
  const own=input('own'), o=d.calculate(own,'own');
  near(o.unit,own.sell-(o.insurance+o.credit+o.interest+own.sea+own.local/own.fx)/own.qty);
  near(o.rmb,o.unit*1.13*own.fx);
});
test('calculation rejects missing, nonfinite and negative amounts in every active mode',()=>{
  for(const mode of ['rmb','usd','own']) {
    const v=input(mode); assert.equal(d.validateCalculation(v,mode),true);
    for(const key of ['qty','fx','sell','sea','local','tax','transport','credit','interest','months',...(mode==='own'?[]:['buy'])]) {
      for(const invalid of [null,undefined,'',NaN,Infinity,-1]) assert.equal(d.validateCalculation({...v,[key]:invalid},mode),false,`${mode}/${key}/${invalid}`);
    }
    assert.equal(d.validateCalculation({...v,qty:0},mode),false);
    assert.equal(d.validateCalculation({...v,sell:0,sea:0,local:0},mode),true);
  }
  assert.equal(d.validateCalculation({...input(),rebate:null},'rmb'),false);
  assert.equal(d.validateCalculation({...input(),seaMax:4999},'rmb'),false);
  assert.equal(d.validateCalculation({...input('usd'),receive:0},'usd'),false);
  for(const n of [null,undefined,'0',-1,101,Infinity]) assert.equal(d.validRebate(n),false);
  for(const n of [0,13,100]) assert.equal(d.validRebate(n),true);
});
test('credit rate table exactly matches original country/payment/period boundaries',()=>{
  const source=readFileSync(new URL('../dist/credit-rates.js',import.meta.url),'utf8');
  const baseline=vm.runInNewContext(source+'; ({creditCountries,lookupCreditRate})',{Intl});
  assert.equal(d.creditCountries.length,baseline.creditCountries.length);
  for(const country of d.creditCountries) for(const payment of ['L/C','D/P','D/A 或 O/A']) for(const months of [0,1,1.001,2,2.001,3,3.001,6,6.001,12,12.001,24,24.001]) {
    assert.equal(JSON.stringify(d.lookupCreditRate(country.code,months,payment)),JSON.stringify(baseline.lookupCreditRate(country.code,months,payment)));
  }
  assert.equal(d.lookupCreditRate('USA',3,'D/A 或 O/A').rate,.358);
  for(const args of [['XXX',1,'L/C'],['USA',null,'L/C'],['USA',-1,'L/C'],['USA',7,'D/P'],['USA',1,'?']]) assert.equal(d.lookupCreditRate(...args),null);
});
test('free text keeps raw details and identifies explicit currency, unit and trade terms',()=>{
  const raw='DPG USD 1,250/MT FOB 青岛，20t/20GP，不打托，2026年12月交货，含进仓费';
  const [r]=d.parseQuotes(raw);
  assert.equal(r.details,raw); assert.equal(r.raw,raw); assert.equal(r.price,1250);
  assert.equal(r.currency,'USD'); assert.equal(r.unit,'吨'); assert.equal(r.incoterm,'FOB');
  assert.equal(r.warehouse,'工厂'); assert.equal(r.rebate,null);
  assert.equal(d.parseQuotes('单价 14.2 元/公斤')[0].price,14.2);
  assert.equal(d.parseQuotes('USD 20/kg 或 USD 18/kg')[0].price,'');
  assert.equal(d.parseQuotes('请询价')[0].price,'');
  assert.equal(d.parseQuotes('USD 20–22/kg')[0].price,'');
  assert.equal(d.parseQuotes('20-22 元/公斤')[0].price,'');
  assert.equal(d.parseQuotes('-20 USD/kg')[0].price,'');
  assert.equal(d.parseQuotes('USD 20/kg，交货期 2026-12-01')[0].price,20);
  assert.deepEqual(d.parseQuotes('  '),[]);
});
test('header TSV returns every row and preserves multiline quoted details and explicit fields',()=>{
  const raw='产品\t工厂\t报价明细\t数量\t报价有效期\t交货期\r\nDPG\t甲厂\t"USD 20/kg\n含进仓费，注明 ""现货"""\t1吨\t月底\t2026年12月\r\nDCP\t乙厂\tUSD 21/kg 或 USD 22/kg\t2吨\t本周\t2027年1月';
  const rows=d.parseQuotes(raw);
  assert.equal(rows.length,2); assert.equal(rows[0].name,'DPG'); assert.equal(rows[0].factory,'甲厂');
  assert.equal(rows[0].details,'USD 20/kg\n含进仓费，注明 "现货"');
  assert.equal(rows[0].raw,rows[0].details); assert.equal(rows[0].price,20);
  assert.equal(rows[0].quantity,'1吨'); assert.equal(rows[0].delivery,'2026年12月');
  assert.equal(rows[1].price,'');
  assert.deepEqual(d.parseQuotes('产品\t报价明细\n'),[]);
});
test('record and backup validators throw Chinese errors and preserve legacy histories',()=>{
  const factory={name:'DPG',price:1200,currency:'RMB',unit:'吨',rebate:0};
  assert.equal(d.validateRecord('factories',factory),factory);
  assert.throws(()=>d.validateRecord('factories',{...factory,rebate:null}),/退税/);
  assert.throws(()=>d.validateRecord('freights',freight({sea:-1})),/非负/);
  assert.throws(()=>d.validateRecord('freights',freight({valid:'2026-02-30'})),/日期/);
  assert.throws(()=>d.validateRecord('freights',freight({transportMode:''})),/运输/);
  const values=input(); const history={mode:'rmb',values,result:d.calculate(values,'rmb'),date:'2026-11-11T00:00:00Z'};
  delete values.seaMax; delete values.rebate;
  const db={factories:[factory],freights:[freight()],history:[history]};
  const before=JSON.stringify(db); assert.equal(d.validateDatabase(db),db); assert.equal(JSON.stringify(db),before);
  assert.equal(d.validateCalculation(values,'rmb'),false);
  assert.throws(()=>d.validateDatabase({...db,history:[{...history,result:{}}]}),/核算记录第 1 条/);
  assert.throws(()=>d.validateDatabase({...db,history:{}}),/数组/);
  assert.throws(()=>d.validateRecord('unknown',{}),/未知/);
});
test('freight average requires a shared route, transport, basis and current validity',()=>{
  const rows=[freight(),freight({agent:'乙',sea:3000,local:700})];
  assert.deepEqual(d.averageFreights(rows,'2026-12-01'),{sea:2000,local:600,seaMin:1000,seaMax:3000,transportMode:'海运整柜'});
  assert.equal(d.averageFreights(rows,'2026-12-02'),null);
  for(const change of [{route:'宁波 → 汉堡'},{transportMode:'空运'},{basis:'40HQ'},{sea:null},{local:-1},{valid:'bad'}]) assert.equal(d.averageFreights([rows[0],freight(change)],'2026-11-11'),null);
  assert.equal(d.averageFreights([],'2026-11-11'),null);
  assert.equal(d.averageFreights(rows,'2026-02-30'),null);
});
