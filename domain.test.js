import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as d from './domain.js';

const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-9, `${actual} != ${expected}`);
const input = (mode='rmb') => ({...d.defaults,...d.samples[mode],credit:.441,seaMax:7000});
const freight = (extra={}) => ({agent:'货代甲',route:'上海 → 汉堡',transportMode:'海运整柜',basis:'20GP / 全包',valid:'2026-12-01',sea:1000,local:500,...extra});
const fclFreight = (extra={}) => ({agent:'货代甲',origin:'上海',destination:'汉堡',transportMode:'海运整柜',containerType:'40HQ',valid:'2026-12-01',sea:1000,local:500,...extra});
const lclFreight = (extra={}) => ({agent:'货代甲',origin:'上海',destination:'汉堡',transportMode:'海运拼箱',quantity:100,quantityUnit:'公斤',valid:'2026-12-01',sea:1000,local:500,...extra});
const bulkyFreight = (extra={}) => lclFreight({bulky:'是',volume:3,...extra});

test('exports the requested domain API and RMB freight maximum field',()=>{
  for(const name of ['basic','costs','params','factoryFields','freightFields','defaults','samples','transportModes','creditCountries','lookupCreditRate','calculate','fcaCost','cfrCost','factoryQuantityKg','validRebate','validateCalculation','parseQuotes','validateRecord','validateDatabase','averageFreights']) assert.ok(name in d,name);
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
test('factory quantity parsing and C&F cost need only cost inputs',()=>{
  assert.equal(d.factoryQuantityKg('8000','公斤'),8000);
  assert.equal(d.factoryQuantityKg('22','吨'),22000);
  assert.equal(d.factoryQuantityKg('22t','吨'),22000);
  assert.equal(d.factoryQuantityKg('1000kg','吨'),1000);
  assert.equal(d.factoryQuantityKg('22t/20GP','吨'),null);
  assert.equal(d.factoryQuantityKg('1-2吨','吨'),null);
  assert.equal(d.factoryQuantityKg('', '吨'),null);
  const rmb=input(), usd=input('usd');
  near(d.cfrCost(rmb,'rmb'),d.calculate({...rmb,sell:0},'rmb').landed);
  near(d.cfrCost({...rmb,seaMax:null},'rmb'),d.calculate({...rmb,sell:0},'rmb').landed);
  near(d.cfrCost(usd,'usd'),d.calculate(usd,'usd').landed);
  assert.equal(d.cfrCost({...rmb,qty:null},'rmb'),null);
  assert.equal(d.cfrCost({...rmb,sea:null},'rmb'),null);
  assert.equal(d.cfrCost({...rmb,rebate:null},'rmb'),null);
});
test('USD uses purchase and receipt FX separately; reverse mode uses receipt FX, VAT and rebate',()=>{
  const v=input('usd'), r=d.calculate(v,'usd');
  near(r.base,21.5+8000/6.85/8000);
  near(r.landed,r.base+2900/8000);
  near(r.rmb,8000*24.5*6.75-(r.insurance+r.credit+r.interest)*6.85-r.landed*6.85*8000);
  const own=input('own'), o=d.calculate(own,'own');
  near(o.unit,own.sell-(o.insurance+o.credit+o.interest+own.sea+own.local/own.receive)/own.qty);
  near(o.rmb,o.unit*(1+own.tax/100)/(1+(own.tax-own.rebate)/100)*own.receive);
  const fullRebate=d.calculate({...own,rebate:own.tax},'own');
  near(fullRebate.rmb,fullRebate.unit*1.13*own.receive);
  const noRebate=d.calculate({...own,rebate:0},'own');
  near(noRebate.rmb,noRebate.unit*own.receive);
});
test('calculation rejects missing, nonfinite and negative amounts in every active mode',()=>{
  const required={rmb:['qty','fx','sell','sea','seaMax','local','tax','rebate','transport','credit','interest','months'],
    usd:['qty','fx','receive','sell','sea','seaMax','local','transport','credit','interest','months'],
    own:['qty','receive','sell','sea','seaMax','local','tax','rebate','transport','credit','interest','months']};
  for(const mode of ['rmb','usd','own']) {
    const v=input(mode); assert.equal(d.validateCalculation(v,mode),true);
    for(const key of required[mode]) {
      for(const invalid of [null,undefined,'',NaN,Infinity,-1]) assert.equal(d.validateCalculation({...v,[key]:invalid},mode),false,`${mode}/${key}/${invalid}`);
    }
    assert.equal(d.validateCalculation({...v,qty:0},mode),false);
    assert.equal(d.validateCalculation({...v,sell:0,sea:0,seaMax:0,local:0},mode),true);
  }
  assert.equal(d.validateCalculation({...input(),rebate:null},'rmb'),false);
  assert.equal(d.validateCalculation({...input(),seaMax:4999},'rmb'),false);
  assert.equal(d.validateCalculation({...input(),receive:0},'rmb'),true,'receipt FX is irrelevant to RMB purchases');
  assert.equal(d.validateCalculation({...input('usd'),seaMax:null},'usd'),false);
  assert.equal(d.validateCalculation({...input('usd'),seaMax:2899},'usd'),false);
  assert.equal(d.validateCalculation({...input('usd'),seaMax:2900},'usd'),true);
  assert.equal(d.validateCalculation({...input('usd'),tax:null},'usd'),true,'VAT is irrelevant to USD purchases');
  assert.equal(d.validateCalculation({...input('usd'),receive:0},'usd'),false);
  assert.equal(d.validateCalculation({...input('own'),fx:null},'own'),true,'purchase FX is irrelevant to own-factory reverse mode');
  assert.equal(d.validateCalculation({...input('own'),receive:0},'own'),false);
  assert.equal(d.validateCalculation({...input('own'),seaMax:null},'own'),false);
  assert.equal(d.validateCalculation({...input('own'),sea:100,seaMax:0},'own'),false);
  assert.equal(d.validateCalculation({...input('own'),tax:null},'own'),false);
  assert.equal(d.validateCalculation({...input('own'),rebate:null},'own'),false);
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
  const usdValues={...input('usd')}; delete usdValues.seaMax;
  const usdHistory={mode:'usd',values:usdValues,result:d.calculate(usdValues,'usd'),date:'2026-11-11T00:00:00Z'};
  assert.equal(d.validateRecord('history',usdHistory),usdHistory);
  assert.doesNotThrow(()=>d.validateDatabase({...db,history:[usdHistory]}));
  // Own-factory records created before this change used the purchase FX and had no freight ceiling or rebate.
  const ownValues={...input('own')}; delete ownValues.seaMax; delete ownValues.receive; ownValues.rebate=null;
  const ownHistory={mode:'own',values:ownValues,result:{unit:1,rmb:1,insurance:0,credit:0,interest:0},date:'2026-11-11T00:00:00Z'};
  assert.equal(d.validateRecord('history',ownHistory),ownHistory);
  assert.equal(ownValues.seaMax,undefined,'validation backfill must not mutate stored values');
  assert.equal(ownValues.receive,undefined);
  assert.equal(d.validateCalculation(values,'rmb'),false);
  assert.throws(()=>d.validateDatabase({...db,history:[{...history,result:{}}]}),/核算记录第 1 条/);
  assert.throws(()=>d.validateDatabase({...db,history:{}}),/数组/);
  assert.throws(()=>d.validateRecord('unknown',{}),/未知/);
});
test('CAS catalog follows dist precedence, normalization and derived-entry rules',()=>{
  const db={products:[{id:'manual',name:'手工名称',cas:'67-68-5'}],history:[{values:{product:'历史名称',cas:' 67–68–5 '}},{values:{product:'历史产品',cas:'64-17-5'}}],factories:[{name:'重复工厂产品',cas:'64-17-5'},{name:'工厂产品',cas:'7732-18-5'},{name:'无效',cas:'bad'}]};
  const before=JSON.stringify(db);
  assert.deepEqual(d.catalogProducts(db),[{id:'manual',name:'手工名称',cas:'67-68-5',manualIndex:0},{name:'历史产品',cas:'64-17-5'},{name:'工厂产品',cas:'7732-18-5'}]);
  assert.equal(JSON.stringify(db),before);
  assert.equal(d.normalizeCas(' 67<br>–68&nbsp;–5 '),'67-68-5');
  assert.throws(()=>d.validateRecord('products',{name:'产品',cas:'bad'}),/CAS/);
  assert.throws(()=>d.validateDatabase({factories:[],freights:[],history:[],products:{}}),/产品目录/);
  assert.equal(d.defaults.customerTerm,'待确认');
  assert.ok(!d.basic.some(([key])=>key==='term'));
});
test('rule extraction preserves CAS and quote dates from Excel headers',()=>{
  for(const label of ['CAS','CAS 号','CAS号']) {
    const [row]=d.parseQuotes(`产品\t报价明细\t${label}\t报价日期\t报价有效期\n产品甲\tUSD 20/kg\t67–68–5\t2026/1/2\t2026.12.31`);
    assert.equal(row.cas,'67-68-5'); assert.equal(row.quoteDate,'2026-01-02'); assert.equal(row.validity,'2026-12-31');
    assert.equal(row.price,20);
  }
  assert.equal(d.normalizeFactoryDate('月底'),'');
});
test('freight average requires a shared route, transport, basis and current validity',()=>{
  const rows=[freight(),freight({agent:'乙',sea:3000,local:700})];
  assert.deepEqual(d.averageFreights(rows,'2026-12-01'),{sea:2000,local:600,seaMin:1000,seaMax:3000,transportMode:'海运整柜'});
  assert.equal(d.averageFreights(rows,'2026-12-02'),null);
  for(const change of [{route:'宁波 → 汉堡'},{transportMode:'空运'},{basis:'40HQ'},{sea:null},{local:-1},{valid:'bad'}]) assert.equal(d.averageFreights([rows[0],freight(change)],'2026-11-11'),null);
  assert.equal(d.averageFreights([],'2026-11-11'),null);
  assert.equal(d.averageFreights(rows,'2026-02-30'),null);
});
test('freight quotes split origin/destination and scope FCL by container, LCL by inquiry quantity',()=>{
  const fcl=fclFreight(), lcl=lclFreight(), bulky=bulkyFreight(), legacy=freight();
  assert.equal(d.validateRecord('freights',fcl),fcl);
  assert.equal(d.validateRecord('freights',lcl),lcl);
  assert.equal(d.validateRecord('freights',bulky),bulky);
  assert.equal(d.validateRecord('freights',lclFreight({quantityUnit:'CBM'})).quantityUnit,'CBM','old volume units stay accepted');
  assert.equal(d.validateRecord('freights',legacy),legacy,'legacy route/basis records must stay valid');
  assert.deepEqual(d.freightRoute(fcl),{origin:'上海',destination:'汉堡'});
  assert.deepEqual(d.freightRoute(legacy),{origin:'上海',destination:'汉堡'});
  assert.deepEqual(d.freightRoute(freight({route:'宁波'})),{origin:'宁波',destination:''});
  assert.equal(d.freightBasis(fcl),'40HQ');
  assert.equal(d.freightBasis(lcl),'100 公斤');
  assert.equal(d.freightBasis(bulky),'100 公斤 · 抛货 3 CBM');
  assert.equal(d.freightBasis(lclFreight({bulky:'否',volume:3})),'100 公斤','non-bulky cargo ignores a stale volume');
  assert.equal(d.freightBasis(legacy),'20GP / 全包');
  assert.equal(d.freightUnits[0],'公斤');
  assert.throws(()=>d.validateRecord('freights',fclFreight({containerType:''})),/柜型/);
  assert.throws(()=>d.validateRecord('freights',lclFreight({quantity:null})),/询价数量/);
  assert.throws(()=>d.validateRecord('freights',lclFreight({quantityUnit:'箱'})),/询价单位/);
  assert.throws(()=>d.validateRecord('freights',bulkyFreight({volume:null})),/体积/);
  assert.throws(()=>d.validateRecord('freights',lclFreight({bulky:'也许'})),/抛货/);
  assert.throws(()=>d.validateRecord('freights',fclFreight({destination:''})),/起运地和目的地/);
  assert.throws(()=>d.validateRecord('freights',fclFreight({transportMode:''})),/运输/);
  const modern=[fclFreight(),fclFreight({agent:'乙',sea:3000,local:700})];
  assert.deepEqual(d.averageFreights(modern,'2026-12-01'),{sea:2000,local:600,seaMin:1000,seaMax:3000,transportMode:'海运整柜'});
  assert.equal(d.averageFreights([modern[0],fclFreight({containerType:'20GP'})],'2026-12-01'),null);
  assert.equal(d.averageFreights([modern[0],fclFreight({origin:'宁波'})],'2026-12-01'),null);
  assert.equal(d.averageFreights([lclFreight(),lclFreight({quantity:3})],'2026-12-01'),null);
  assert.deepEqual(d.averageFreights([bulkyFreight(),bulkyFreight({agent:'乙',sea:3000,local:700})],'2026-12-01'),{sea:2000,local:600,seaMin:1000,seaMax:3000,transportMode:'海运拼箱'});
  assert.equal(d.averageFreights([bulkyFreight(),bulkyFreight({volume:4})],'2026-12-01'),null);
});
test('history filters match CAS or customer keywords anywhere in the stored values',()=>{
  const rows=[
    {values:{product:'DPG',cas:'67-68-5',customer:'STIM'}},
    {values:{product:'DCP',cas:'64-17-5',customer:'Kingchem'}},
    {values:{product:'旧记录',cas:'',customer:''}},
  ];
  const keep=filter=>rows.filter(row=>d.historyMatches(row,filter));
  assert.deepEqual(keep({}),rows,'blank filters keep every record');
  assert.deepEqual(keep({cas:'67-68'}),[rows[0]]);
  assert.deepEqual(keep({cas:'6768'}),[rows[0]],'separators may be omitted');
  assert.deepEqual(keep({cas:' 67–68–5 '}),[rows[0]],'en dashes and spaces are ignored');
  assert.deepEqual(keep({cas:'68-5'}),[rows[0]],'any CAS suffix matches');
  assert.deepEqual(keep({cas:'17'}),[rows[1]]);
  assert.deepEqual(keep({customer:'stim'}),[rows[0]],'customer matching is case-insensitive');
  assert.deepEqual(keep({customer:'CHEM'}),[rows[1]],'customer keywords match in the middle of a name');
  assert.deepEqual(keep({customer:'化学'}),[]);
  assert.deepEqual(keep({cas:'67',customer:'sti'}),[rows[0]]);
  assert.deepEqual(keep({cas:'67',customer:'king'}),[],'both filters must match');
  assert.deepEqual(keep({cas:'-',customer:'   '}),rows,'separator-only CAS and blank customer keep every record');
  assert.deepEqual(rows.filter(row=>d.historyMatches(row)),rows,'a missing filter keeps every record');
});
