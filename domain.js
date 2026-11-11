// Pure business rules extracted from the original quotation workbench.
// No DOM, storage, or runtime service dependencies.
const transportModes=['海运整柜','海运拼箱','空运','铁路','公路','快递','其他'];
const basic=[['transportMode','运输方式',['',...transportModes]],['product','产品 / 规格','text'],['customer','客户','text'],['quoteCountry','报价国家 / 地区',['']],['creditMonths','账期（月）','number'],['creditPayment','信保付款方式',['','L/C','D/P','D/A 或 O/A']],['qty','数量 kg','number'],['sell','对客单价 USD/kg','number'],['term','工厂 Incoterm',['待确认','EXW','FCA','FOB','CFR','CIF','其他']],['place','交货地点 / 港口','text']];
const costs=[['buy','工厂采购单价','number'],['fx','买汇 / 成本汇率 RMB/USD','number'],['receive','收汇汇率 RMB/USD','number'],['sea','国际运费 USD/票','number'],['local','国内费用总额 RMB/票','number'],['tax','增值税率 %','number'],['rebate','退税率 %','number']];
const params=[['transport','运输保险费率 %','number'],['credit','信用保险费率 %','number'],['interest','年资金利率 %','number'],['months','资金占用月数','number']];
const factoryFields=[['name','产品','text'],['factory','工厂','text'],['details','报价明细','text'],['quantity','数量','text'],['validity','报价有效期','text'],['price','报价单价','number'],['currency','币种',['USD','RMB']],['rebate','退税率 %（不退税填 0）','number'],['unit','计价单位',['待确认','吨','公斤']],['incoterm','Incoterm',['待确认','EXW','FCA','FOB','CFR','CIF','其他']],['port','交货地点','text'],['loading','装柜量 / 柜型','text'],['packing','包装方式','text'],['delivery','交货期（含年份）','text'],['warehouse','进仓费承担方',['我方','工厂']],['portfee','港杂费承担方',['我方','工厂']]];
const freightFields=[['agent','货代名称','text'],['route','路线（起运地 → 目的地）','text'],['transportMode','运输方式',['海运整柜','海运拼箱','空运']],['basis','数量 / 柜型 / 费用范围','text'],['valid','有效期','date'],['sea','国际运费 USD/票','number'],['local','国内费用 RMB/票','number']];
const defaults={product:'',customer:'',qty:null,sell:null,term:'待确认',place:'',buy:null,fx:6.75,receive:6.75,sea:null,local:null,tax:13,rebate:null,transport:.03,credit:null,interest:3.6,months:3};
function validRebate(rate){return Number.isFinite(rate)&&rate>=0&&rate<=100;}
function fcaCost(v){return (v.buy-v.buy/(1+v.tax/100)*(v.rebate/100))/v.fx;}
function calculate(v,m){const revenue=v.qty*v.sell,insurance=revenue*1.1*v.transport/100,credit=revenue*v.credit/100,interest=revenue*v.interest/100/12*v.months;if(m==='own'){const unit=v.sell-insurance/v.qty-credit/v.qty-interest/v.qty-v.sea/v.qty-v.local/v.qty/v.fx;return{unit,rmb:unit*(1+v.tax/100)*v.fx,insurance,credit,interest}}const base=m==='rmb'?fcaCost(v):v.buy+v.local/v.fx/v.qty;const landed=base+v.sea/v.qty+(m==='rmb'?v.local/v.fx/v.qty:0);const profit=revenue-insurance-credit-interest-landed*v.qty;return{base,landed,profit,margin:base?v.qty?profit/(base*v.qty):0:0,rmb:revenue*v.receive-(insurance+credit+interest)*v.fx-landed*v.fx*v.qty,insurance,credit,interest}}
const samples={rmb:{product:'20IBC of DPG',qty:20000,sell:2.33,sea:5000,local:2000,fx:6.67,buy:14.2,rebate:13,credit:.441},usd:{product:'Florfenicol-Sea FCL',customer:'STIM',qty:8000,sell:24.5,sea:2900,local:8000,fx:6.85,receive:6.75,buy:21.5},own:{product:'DCP',customer:'Kingchem',qty:1000,sell:27.5,sea:0,local:2000,fx:6.75,credit:.422,months:6}};
costs.push(['seaMax','最高国际运费 USD/票','number']);

'use strict';

// 2018 country/region classification, in source row order.
const creditGroups = {
 A1:'LUX SGP CHE', A2:'AUS AUT BEL CAN DNK FIN FRA DEU JPN NZL NOR SWE GBR USA',
 B1:'AND CHL CZE ISL IRL ISR LIE MCO NLD ESP HKG TWN',
 B2:'BHR BRB BWA BRN HRV EST HUN ITA KOR KWT LTU MYS MLT MUS MEX OMN POL PRT QAT ROU SMR SAU SVK SVN THA ARE MAC REU VAT ABW GUF CYM PRI VGB BMU 912 913 CHN',
 C1:'ALB ARM BHS BIH BGR CPV CRI CYP DMA GEO GRC IND JAM JOR LVA MKD MDA MAR NAM PAN PER PHL SRB ZAF TTO URY VNM VIR GRL',
 C2:'DZA ATG AZE BGD BLR BLZ BOL BRA KHM COL DOM EGY SLV FJI GRD GTM GUY IDN IRN KAZ LAO LBN MDV MNE NPL NIC PNG PRY RUS WSM SYC LKA TON TUN TUR GIB ANT',
 D1:'AGO ARG BEN BTN CMR CIV DJI ECU GNQ ERI ETH GAB GHA HND IRQ KEN KIR LSO MDG FSM MNG MMR NRU PAK KNA LCA VCT SEN SUR SWZ TZA TKM UGA UKR UZB VUT ZMB 903 PYF NCL',
 D2:'AFG BFA BDI TCD COM COG COD CUB TMP GMB GIN GNB HTI PRK KGZ LBR LBY MWI MLI MHL MRT MOZ NER NGA PLW RWA STP SLE SLB SSD SDN SYR TJK TGO TUV VEN PSE 901 ESH 902 904 905 GLP 906 MTQ MSR 907 908 TCA 909 COK NFK 910 911',
 E:'CAF SOM YEM ZWE'
};
const creditNames = {
 TMP:'东帝汶',ANT:'荷属安地列斯群岛',HKG:'香港',MAC:'澳门',TWN:'台湾',PSE:'巴勒斯坦',CHN:'中国（买方/开证行参考）',
 901:'塞卜泰（休达）',902:'马约特岛',903:'加那利群岛',904:'梅利利亚',905:'博内尔',906:'库腊索岛',
 907:'萨巴',908:'圣马丁岛',909:'盖比群岛',910:'社会群岛',911:'土阿莫土群岛',912:'马恩岛',913:'诺曼底群岛'
};
const creditRegions = new Intl.DisplayNames(["zh-CN"], {type:"region"});
const creditCodes = {"MMR":"MM","SAU":"SA","SVN":"SI","TLS":"TL","AUT":"AT","CYM":"KY","MYT":"YT","KWT":"KW","BDI":"BI","URY":"UY","QAT":"QA","CHN":"CN","MKD":"MK","KEN":"KE","DJI":"DJ","PSE":"PS","JEY":"JE","HUN":"HU","SGP":"SG","KOR":"KR","COD":"CD","GEO":"GE","LSO":"LS","ASM":"AS","PAK":"PK","DNK":"DK","ITA":"IT","ROU":"RO","GLP":"GP","FLK":"FK","JOR":"JO","UGA":"UG","LBY":"LY","LVA":"LV","BGD":"BD","TCA":"TC","NRU":"NR","KHM":"KH","KIR":"KI","GRD":"GD","DZA":"DZ","MNE":"ME","MDV":"MV","SDN":"SD","SOM":"SO","FRO":"FO","COK":"CK","HRV":"HR","TWN":"TW","MNP":"MP","GRL":"GL","FIN":"FI","MSR":"MS","UZB":"UZ","JAM":"JM","CPV":"CV","JPN":"JP","LTU":"LT","":"001","NGA":"NG","AIA":"AI","USA":"US","CAF":"CF","SEN":"SN","BHR":"BH","AFG":"AF","ARM":"AM","GMB":"GM","LBN":"LB","SXM":"SX","TJK":"TJ","SLE":"SL","PLW":"PW","LCA":"LC","TUN":"TN","DMA":"DM","PRI":"PR","PRY":"PY","NLD":"NL","TKL":"TK","NER":"NE","CUB":"CU","AND":"AD","RWA":"RW","ERI":"ER","PRT":"PT","ZMB":"ZM","GNQ":"GQ","HTI":"HT","HND":"HN","CMR":"CM","GTM":"GT","COG":"CG","BEL":"BE","PER":"PE","BEN":"BJ","TCD":"TD","CCK":"CC","BES":"BQ","SJM":"SJ","SHN":"SH","ARG":"AR","BLM":"BL","NFK":"NF","CHL":"CL","NIC":"NI","ALA":"AX","EST":"EE","SLB":"SB","MTQ":"MQ","REU":"RE","NPL":"NP","ECU":"EC","SWZ":"SZ","VGB":"VG","RUS":"RU","MHL":"MH","POL":"PL","OMN":"OM","MLT":"MT","IRL":"IE","MCO":"MC","FSM":"FM","MWI":"MW","IDN":"ID","GNB":"GW","MUS":"MU","DOM":"DO","ISL":"IS","TKM":"TM","GBR":"GB","MLI":"ML","CAN":"CA","CIV":"CI","TUR":"TR","IND":"IN","BRN":"BN","SWE":"SE","GUF":"GF","PNG":"PG","KAZ":"KZ","VUT":"VU","CXR":"CX","ATG":"AG","NOR":"NO","GIB":"GI","ALB":"AL","KGZ":"KG","IOT":"IO","BLZ":"BZ","SPM":"PM","SSD":"SS","AGO":"AO","LIE":"LI","NCL":"NC","HKG":"HK","KNA":"KN","IRQ":"IQ","ZAF":"ZA","CUW":"CW","GUY":"GY","MAC":"MO","UMI":"UM","LKA":"LK","THA":"TH","BLR":"BY","ETH":"ET","MAF":"MF","SUR":"SR","VIR":"VI","ARE":"AE","LUX":"LU","EGY":"EG","CHE":"CH","BGR":"BG","AUS":"AU","GUM":"GU","YEM":"YE","MRT":"MR","PAN":"PA","MEX":"MX","SVK":"SK","NZL":"NZ","ABW":"AW","PCN":"PN","WSM":"WS","TON":"TO","MDA":"MD","BHS":"BS","MNG":"MN","IMN":"IM","WLF":"WF","FRA":"FR","BFA":"BF","VNM":"VN","COM":"KM","CZE":"CZ","STP":"ST","VEN":"VE","PRK":"KP","NIU":"NU","COL":"CO","XKK":"XK","PHL":"PH","TTO":"TT","UKR":"UA","MDG":"MG","BRB":"BB","BOL":"BO","GRC":"GR","TGO":"TG","ESP":"ES","SYC":"SC","SYR":"SY","TZA":"TZ","AZE":"AZ","BRA":"BR","FJI":"FJ","SMR":"SM","LAO":"LA","ZWE":"ZW","CYP":"CY","BWA":"BW","BIH":"BA","VAT":"VA","DEU":"DE","TUV":"TV","GAB":"GA","PYF":"PF","GIN":"GN","SLV":"SV","MAR":"MA","GHA":"GH","MOZ":"MZ","BMU":"BM","VCT":"VC","ESH":"EH","LBR":"LR","GGY":"GG","IRN":"IR","NAM":"NA","SRB":"RS","MYS":"MY","CRI":"CR","ISR":"IL","BTN":"BT"};
const creditCountries = Object.entries(creditGroups).flatMap(([group,codes])=>codes.split(' ').map(code=>({
 code, group, label: creditNames[code] || (creditCodes[code] ? creditRegions.of(creditCodes[code]) : code)
}))).sort((a,b)=>a.label.localeCompare(b.label,'zh-CN'));
const creditPeriods = [[30,'0–30 天'],[60,'31–60 天'],[90,'61–90 天'],[180,'91–180 天'],[360,'181 天–1 年'],[720,'1–2 年']];
const creditRates = {
 'L/C':[[.031,.041,.043,.169,.172],[.107,.113,.135,.530,.534],[.154,.189,.307,.717,.753],[.223,.257,.390,1,1.034],[.271,.325,.475,1.187,1.243],[.317,.393,.558,1.373,1.451]],
 'D/P':[[.051,.069,.073,.284,.288],[.181,.189,.227,.889,.898],[.259,.318,.515,1.198,1.259],[.338,.440,.668,1.509,1.610]],
 'D/A 或 O/A':[[.072,.097,.101,.393,.398],[.249,.263,.314,1.226,1.238],[.358,.441,.711,1.647,1.731],[.520,.599,.905,2.294,2.374],[.628,.757,1.099,2.717,2.847],[.736,.915,1.293,3.140,3.318]]
};
function lookupCreditRate(country, months, payment) {
 const group = creditCountries.find(row=>row.code===country)?.group;
 if(!group || !Number.isFinite(months) || months<0) return null;
 const index = creditPeriods.findIndex(([days])=>months<=days/30);
 const rate = creditRates[payment]?.[index]?.['ABCDE'.indexOf(group[0])];
 return rate===undefined ? null : {rate, group, period:creditPeriods[index][1]};
}

const nonnegative = n => Number.isFinite(n) && n >= 0;
const positive = n => Number.isFinite(n) && n > 0;
const text = s => typeof s === 'string' && s.trim().length > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const modes = ['rmb', 'usd', 'own'];

/** New calculations require explicit amounts; zero means confirmed no cost. */
function validateCalculation(v, mode) {
  if (!object(v) || !modes.includes(mode) || !positive(v.qty) || !positive(v.fx)) return false;
  if (!['sell','sea','local','transport','credit','interest','months','tax'].every(k => nonnegative(v[k]))) return false;
  if (mode !== 'own' && !nonnegative(v.buy)) return false;
  if (mode === 'usd' && !positive(v.receive)) return false;
  if (mode === 'rmb' && (!validRebate(v.rebate) || !nonnegative(v.seaMax) || v.seaMax < v.sea)) return false;
  return true;
}
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
}
/** Return the same record or throw an Error with a Chinese explanation. */
function validateRecord(kind, r) {
  if (!object(r)) throw new Error('记录必须是有效对象。');
  if (kind === 'factories') {
    if (!text(r.name) || !positive(r.price)) throw new Error('工厂报价须填写产品名称和有效正数价格。');
    if (!['RMB','USD'].includes(r.currency) || !['吨','公斤'].includes(r.unit)) throw new Error('工厂报价须确认币种和计价单位。');
    if ((r.currency === 'RMB' || r.rebate != null) && !validRebate(r.rebate)) throw new Error('请填写 0–100 的退税率，不退税填 0。');
  } else if (kind === 'freights') {
    if (!['agent','route','basis'].every(k => text(r[k]))) throw new Error('货代报价须填写货代、路线和费用口径。');
    if (!transportModes.includes(r.transportMode)) throw new Error('货代报价须确认有效运输方式。');
    if (!validDate(r.valid)) throw new Error('货代报价须填写有效日期（年-月-日）。');
    if (!nonnegative(r.sea) || !nonnegative(r.local)) throw new Error('运费和国内费用须为非负数，无费用填 0。');
  } else if (kind === 'history') {
    if (!modes.includes(r.mode) || !object(r.values) || !text(r.values.product)) throw new Error('核算记录须包含有效模式、产品和核算数据。');
    // Original exports may predate rebate and seaMax. Never mutate their data.
    const v = {...r.values};
    if (r.mode === 'rmb') { v.rebate ??= v.tax; v.seaMax ??= v.sea; }
    if (!validateCalculation(v,r.mode)) throw new Error('核算记录中的数量、费用、汇率或退税率无效。');
    const keys = r.mode === 'own' ? ['unit','rmb','insurance','credit','interest'] : ['base','landed','profit','margin','rmb','insurance','credit','interest'];
    const resultOK = result => object(result) && keys.every(k => Number.isFinite(result[k]));
    if (!resultOK(r.result)) throw new Error('核算记录缺少有效计算结果。');
    if (r.highFreightResult != null && !resultOK(r.highFreightResult)) throw new Error('核算记录的最高运费计算结果无效。');
    if (!text(r.date) || !Number.isFinite(Date.parse(r.date))) throw new Error('核算记录缺少有效保存时间。');
  } else throw new Error('未知记录类型。');
  return r;
}
function validateDatabase(data) {
  if (!object(data)) throw new Error('备份必须是有效数据对象。');
  for (const kind of ['factories','freights','history']) {
    if (!Array.isArray(data[kind])) throw new Error('备份须包含工厂报价、货代报价和核算记录数组。');
    data[kind].forEach((r,i) => {
      try { validateRecord(kind,r); }
      catch (e) { throw new Error(`${({factories:'工厂报价',freights:'货代报价',history:'核算记录'})[kind]}第 ${i+1} 条：${e.message}`); }
    });
  }
  return data;
}
/** Invalid, incompatible, or expired selections return null. today is local YYYY-MM-DD or Date. */
function averageFreights(rows, today = new Date()) {
  if (today instanceof Date) {
    if (!Number.isFinite(today.getTime())) return null;
    today = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  }
  if (!validDate(today) || !Array.isArray(rows) || !rows.length) return null;
  try { rows.forEach(r => validateRecord('freights',r)); } catch { return null; }
  const key = r => JSON.stringify([r.route.trim(),r.transportMode,r.basis.trim()]);
  if (rows.some(r => key(r) !== key(rows[0]) || r.valid < today)) return null;
  return {sea:rows.reduce((s,r)=>s+r.sea/rows.length,0), local:rows.reduce((s,r)=>s+r.local/rows.length,0), seaMin:Math.min(...rows.map(r=>r.sea)), seaMax:Math.max(...rows.map(r=>r.sea)), transportMode:rows[0].transportMode};
}
// TSV with quoted fields, escaped quotes, CRLF and embedded newlines.
function quoteRows(raw) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i=0;i<raw.length;i++) {
    const c = raw[i];
    if (c === '"' && (quoted || !value)) {
      if (quoted && raw[i+1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === '\t' || c === '\n')) {
      row.push(value.replace(/\r$/,'')); value = '';
      if (c === '\n') { rows.push(row); row=[]; }
    } else value += c;
  }
  row.push(value.replace(/\r$/,'')); rows.push(row);
  return rows.filter(r=>r.some(s=>s.trim()));
}
function parseQuote(details) {
  const amount = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
  const prices = [...details.matchAll(new RegExp(`(?:USD|RMB|CNY|人民币|美金|美元|[$￥¥])\\s*(${amount})|(${amount})\\s*(?:美金|美元|人民币|USD|RMB|CNY|元)`, 'gi'))];
  // A single currency token may still introduce a price range or alternatives.
  const currencyToken = '(?:USD|RMB|CNY|人民币|美金|美元|元|[$￥¥])';
  const rangeToken = `${amount}\\s*(?:[-–—~～至]|或|到|/)\\s*${amount}`;
  const priceRange = new RegExp(`${currencyToken}\\s*${rangeToken}|${rangeToken}\\s*${currencyToken}`, 'i').test(details);
  const negativePrice = /(?:USD|RMB|CNY|人民币|美金|美元|[$￥¥])\s*-\s*\d|-\s*\d+(?:\.\d+)?\s*(?:USD|RMB|CNY|元|美元|美金)/i.test(details);
  const single = prices.length === 1 && !priceRange && !negativePrice ? prices[0] : null;
  const ton = /每吨|\/\s*吨|\/\s*MT\b|\/\s*TON(?:NE)?S?\b/i.test(details);
  const kg = /每公斤|每千克|\/\s*kg\b|\/\s*公斤|\/\s*千克/i.test(details);
  return {
    name:'', factory:'', details, raw:details,
    price:single ? Number((single[1] || single[2]).replaceAll(',','')) : '',
    currency:single && /USD|美金|美元|\$/i.test(single[0]) ? 'USD' : 'RMB',
    rebate:null, unit:ton === kg ? '待确认' : ton ? '吨' : '公斤',
    incoterm:details.match(/\b(EXW|FCA|FOB|CFR|CIF)\b/i)?.[1].toUpperCase() || '待确认',
    port:details.match(/青岛|上海|宁波|天津|深圳/)?.[0] || '',
    loading:details.match(/\d+(?:\.\d+)?\s*t\s*\/\s*\d+\s*(?:GP|HQ)/i)?.[0] || '',
    packing:/不打托/.test(details) ? '不打托' : '',
    delivery:details.match(/(?:\d{4}年)?\d+月[^，,\n|]*/)?.[0] || '',
    warehouse:/工厂承担进仓|含进仓费/.test(details) ? '工厂' : '我方',
    portfee:/工厂承担港杂|含港杂/.test(details) ? '工厂' : '我方',
  };
}
/** Returns records directly; multiple candidate prices remain blank. */
function parseQuotes(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const rows=quoteRows(raw), header=(rows[0]||[]).map(s=>s.replace(/^\uFEFF/,'').trim());
  if (!header.includes('产品') || !header.includes('报价明细')) return [parseQuote(raw)];
  const keys={'产品':'name','工厂':'factory','报价明细':'details','数量':'quantity','报价有效期':'validity','交货期':'delivery'};
  return rows.slice(1).map(row=>{
    const explicit=Object.fromEntries(header.flatMap((key,i)=>keys[key]?[[keys[key],row[i]||'']]:[]));
    return {...parseQuote(explicit.details),...explicit};
  });
}
export {basic,costs,params,factoryFields,freightFields,defaults,samples,transportModes,creditCountries,lookupCreditRate,calculate,fcaCost,validRebate,validateCalculation,parseQuotes,validateRecord,validateDatabase,averageFreights};
