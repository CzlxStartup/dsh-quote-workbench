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
  for(const name of ['basic','costs','params','factoryFields','productFields','freightFields','defaults','samples','transportModes','creditCountries','lookupCreditRate','calculate','fcaCost','cfrCost','factoryQuantityKg','validRebate','englishText','validateCalculation','parseQuotes','validateRecord','validateDatabase','averageFreights','localDateString','validityDuration','addValidityDate','factoryValidity']) assert.ok(name in d,name);
  assert.ok(d.costs.some(([key])=>key==='seaMax'));
  assert.ok(d.factoryFields.some(([key])=>key==='purity'));
  assert.ok(d.factoryFields.some(([key])=>key==='quality'));
  assert.ok(d.factoryFields.some(([key])=>key==='hazard'));
  assert.ok(d.productFields.some(([key])=>key==='hazard'));
  const usa=d.creditCountries.find(country=>country.code==='USA');
  assert.equal(usa.iso2,'US'); assert.match(usa.english,/United States/);
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
test('USD freight refunds may be negative and reduce C&F cost and profit',()=>{
  const v={...input('usd'),sea:-50,seaMax:-50};
  assert.equal(d.validateCalculation(v,'usd'),true);
  const r=d.calculate(v,'usd');
  near(r.base,v.buy+v.local/v.fx/v.qty);
  near(r.landed,r.base-50/v.qty);
  near(d.cfrCost(v,'usd'),r.landed);
  near(r.profit,v.qty*v.sell-r.insurance-r.credit-r.interest-r.landed*v.qty);
  assert.equal(validateHistory(v,r),true);
});
function validateHistory(values,result){try{d.validateRecord('history',{mode:'usd',values,result,date:'2026-08-20T00:00:00Z'});return true;}catch{return false;}}
test('calculation rejects missing, nonfinite and negative amounts in every active mode',()=>{
  const required={rmb:['qty','fx','sell','sea','seaMax','local','tax','rebate','transport','credit','interest','months'],
    usd:['qty','fx','receive','sell','sea','seaMax','local','transport','credit','interest','months'],
    own:['qty','receive','sell','sea','seaMax','local','tax','rebate','transport','credit','interest','months']};
  for(const mode of ['rmb','usd','own']) {
    const v=input(mode); assert.equal(d.validateCalculation(v,mode),true);
    for(const key of required[mode]) {
      for(const invalid of [null,undefined,'',NaN,Infinity,-1]) {
        const refund = mode === 'usd' && (key === 'sea' || key === 'seaMax') && invalid === -1;
        const candidate = refund ? {...v,sea:-1,seaMax:-1} : {...v,[key]:invalid};
        assert.equal(d.validateCalculation(candidate,mode),refund,`${mode}/${key}/${invalid}`);
      }
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
  const source=readFileSync(new URL('test/fixtures/credit-rates.js',import.meta.url),'utf8');
  const baseline=vm.runInNewContext(source+'; ({creditCountries,lookupCreditRate})',{Intl});
  assert.equal(d.creditCountries.length,baseline.creditCountries.length);
  for(const country of d.creditCountries) for(const payment of ['L/C','D/P','D/A 或 O/A']) for(const months of [0,1,1.001,2,2.001,3,3.001,6,6.001,12,12.001,24,24.001]) {
    assert.equal(JSON.stringify(d.lookupCreditRate(country.code,months,payment)),JSON.stringify(baseline.lookupCreditRate(country.code,months,payment)));
  }
  assert.equal(d.lookupCreditRate('USA',3,'D/A 或 O/A').rate,.358);
  for(const args of [['XXX',1,'L/C'],['USA',null,'L/C'],['USA',-1,'L/C'],['USA',7,'D/P'],['USA',1,'?']]) assert.equal(d.lookupCreditRate(...args),null);
});
test('free text keeps raw details and identifies explicit currency, unit and trade terms',()=>{
  const raw='DPG 含量 99.5%，质量指标：水分≤0.5%，重金属≤10ppm。货物危险性：3类 UN1993。USD 1,250/MT FOB 青岛，20t/20GP，不打托，2026年12月交货，含进仓费';
  const [r]=d.parseQuotes(raw);
  assert.equal(r.details,raw); assert.equal(r.raw,raw); assert.equal(r.price,1250);
  assert.equal(r.currency,'USD'); assert.equal(r.unit,'吨'); assert.equal(r.incoterm,'FOB');
  assert.equal(r.purity,'99.5%'); assert.equal(r.quality,'水分≤0.5%，重金属≤10ppm'); assert.equal(r.hazard,'3类 UN1993');
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
test('cargo hazard recognizes class and UN formats from free text',()=>{
  const cases=[
    ['DPG class 9 UN3082','class 9 UN3082'],
    ['DPG Class 3 UN 1993','Class 3 UN 1993'],
    ['DPG CLASS 9.1 UN3082','CLASS 9.1 UN3082'],
    ['DPG class 3','class 3'],
    ['DPG class x','class x'],
    ['DPG UN 1993','UN 1993'],
    ['DPG UN3082','UN3082'],
    ['DPG UN No. 3082','UN No. 3082'],
    ['DPG UN XXXX','UN XXXX'],
    ['DPG 9类 UN3082','9类 UN3082'],
    ['DPG 危险品类别：class 9 UN3082。FOB 青岛','class 9 UN3082'],
    ['DPG 非危险品','非危险品'],
  ];
  for(const [raw,expected] of cases) assert.equal(d.parseQuotes(raw)[0].hazard,expected,raw);
  assert.equal(d.extractHazard('UN 3082 class 9'),'UN 3082 class 9');
  assert.equal(d.extractHazard(''),'');
});
test('header TSV returns every row and preserves multiline quoted details and explicit fields',()=>{
  const raw='产品\t工厂\t报价明细\t数量\t报价有效期\t交货期\t含量 / 纯度\t其他关键质量指标\t货物危险性\r\nDPG\t甲厂\t"USD 20/kg\n含进仓费，注明 ""现货"""\t1吨\t月底\t2026年12月\t99.5%\t水分≤0.5%，重金属≤10ppm\t3类 UN1993\r\nDCP\t乙厂\tUSD 21/kg 或 USD 22/kg\t2吨\t本周\t2027年1月\t98%\t外观：白色粉末\t非危险品';
  const rows=d.parseQuotes(raw);
  assert.equal(rows.length,2); assert.equal(rows[0].name,'DPG'); assert.equal(rows[0].factory,'甲厂');
  assert.equal(rows[0].details,'USD 20/kg\n含进仓费，注明 "现货"');
  assert.equal(rows[0].raw,rows[0].details); assert.equal(rows[0].price,20);
  assert.equal(rows[0].quantity,'1吨'); assert.equal(rows[0].delivery,'2026年12月');
  assert.equal(rows[0].purity,'99.5%'); assert.equal(rows[0].quality,'水分≤0.5%，重金属≤10ppm'); assert.equal(rows[0].hazard,'3类 UN1993');
  assert.equal(rows[1].price,''); assert.equal(rows[1].purity,'98%'); assert.equal(rows[1].quality,'外观：白色粉末'); assert.equal(rows[1].hazard,'非危险品');
  assert.deepEqual(d.parseQuotes('产品\t报价明细\n'),[]);
});
test('ETD is printable English text and is validated on history records',()=>{
  assert.equal(d.englishText('Mid Nov 2026'),true);
  assert.equal(d.englishText('11月'),false);
  const values={...input('rmb'), etd:'Mid Nov 2026'};
  const history={mode:'rmb',values,result:d.calculate(values,'rmb'),date:'2026-11-11T00:00:00Z'};
  assert.equal(d.validateRecord('history',history),history);
  assert.throws(()=>d.validateRecord('history',{...history,values:{...values,etd:'11月'}}),/ETD/);
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
  const rated={products:[{id:'manual',name:'手工名称',cas:'67-68-5',tax:9,rebate:4}],history:[{values:{product:'历史名称',cas:'67-68-5',tax:13,rebate:13}}]};
  assert.deepEqual(d.catalogProducts(rated),[{id:'manual',name:'手工名称',cas:'67-68-5',tax:9,rebate:4,manualIndex:0}]);
  assert.equal(d.validateRecord('products',{name:'产品',cas:'67-68-5',tax:13,rebate:0}).rebate,0);
  assert.throws(()=>d.validateRecord('products',{name:'产品',cas:'67-68-5',tax:101}),/增值税/);
  assert.throws(()=>d.validateRecord('products',{name:'产品',cas:'67-68-5',rebate:101}),/退税/);
  assert.equal(d.normalizeCas(' 67<br>–68&nbsp;–5 '),'67-68-5');
  assert.throws(()=>d.validateRecord('products',{name:'产品',cas:'bad'}),/CAS/);
  assert.throws(()=>d.validateDatabase({factories:[],freights:[],history:[],products:{}}),/产品目录/);
  assert.equal(d.defaults.customerTerm,'待确认');
  assert.ok(!d.basic.some(([key])=>key==='term'));
});
test('CAS catalog cargo hazard follows the newest factory quote and catalog values win',()=>{
  const catalog=d.catalogProducts({
    products:[{id:'manual',name:'手工名称',cas:'67-68-5',hazard:'Manual class 9'}],
    factories:[
      {name:'工厂产品',cas:'64-17-5',hazard:'Class 8 UN1814'},
      {name:'无危险性',cas:'7732-18-5'},
    ],
  });
  assert.equal(catalog.find(row=>row.cas==='67-68-5').hazard,'Manual class 9','manual catalog hazard wins');
  assert.equal(catalog.find(row=>row.cas==='64-17-5').hazard,'Class 8 UN1814','derived product keeps the quote hazard');
  assert.equal('hazard' in catalog.find(row=>row.cas==='7732-18-5'),false);
  const follows=d.catalogProducts({products:[{id:'manual',name:'DMSO',cas:'67-68-5'}],factories:[
    {name:'新报价',cas:'67-68-5',hazard:'Class 3 UN1993'},
    {name:'旧报价',cas:'67-68-5',hazard:'Class 9 UN3082'},
  ]});
  assert.equal(follows[0].hazard,'Class 3 UN1993','the first/newest quote binds an empty catalog hazard');
  assert.equal(d.validateRecord('products',{name:'产品',cas:'67-68-5',hazard:'Class 3'}).hazard,'Class 3');
  assert.throws(()=>d.validateRecord('products',{name:'产品',cas:'67-68-5',hazard:{}}),/货物危险性/);
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
test('quote validity is the quote date plus a stated period and ignores order-relative periods',()=>{
  const plan=(quoteDate,validity)=>d.factoryValidity(quoteDate,validity);
  assert.equal(plan('2026-11-17','30 days').date,'2026-12-17');
  assert.equal(plan('2026-11-17','30 days').label,'30 天');
  assert.equal(plan('2026-11-17','30 天').date,'2026-12-17','full-width and Chinese periods work');
  assert.equal(plan('2026-11-17','two weeks').date,'2026-12-01');
  assert.equal(plan('2026-11-17','三日内有效').date,'2026-11-20','spelled Chinese numbers work');
  assert.equal(plan('2026-11-17','一个月').date,'2026-12-17');
  assert.equal(plan('2026-01-31','1 month').date,'2026-02-28','month arithmetic clamps to the month end');
  assert.equal(plan('2026-11-17','2027/01/31'),null,'an absolute date needs no conversion');
  assert.equal(plan('2026-11-17','月底'),null);
  assert.equal(plan('2026-11-17','30 days after order'),null,'order-relative periods are not quote validity');
  assert.equal(plan('2026-11-17','收到订单后一周'),null);
  assert.equal(plan('2026-11-17','2026年12月'),null,'a calendar date must not be read as a period');
  assert.equal(plan('2026-02-30','30 days'),null,'an invalid quote date cannot seed a validity');
  assert.equal(plan('','30 days'),null);
  assert.equal(d.localDateString(new Date(2026,10,17,23,30)),'2026-11-17','components stay local, not UTC-shifted');
  assert.equal(d.localDateString(new Date('bad')),'');
  const [row]=d.parseQuotes('产品\t报价明细\t报价日期\t报价有效期\nProdA\tUSD 20/kg\t2026/11/17\t30 days');
  assert.equal(row.quoteDate,'2026-11-17');
  assert.equal(row.validity,'30 days','the stated period survives rule extraction for the form to convert');
  assert.equal(d.parseQuotes('产品\t报价明细\t报价有效期\nProdA\tUSD 20/kg\t2026.12.31')[0].validity,'2026-12-31');
});
