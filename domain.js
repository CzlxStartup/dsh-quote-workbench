// Pure business rules extracted from the original quotation workbench.
// No DOM, storage, or runtime service dependencies.
const transportModes=['海运整柜','海运拼箱','空运','铁路','公路','快递','其他'];
const basic=[['cas','CAS 号','text'],['transportMode','运输方式',['',...transportModes]],['product','产品 / 规格','text'],['customer','客户','text'],['quoteCountry','报价国家 / 地区',['']],['creditMonths','账期（月）','number'],['creditPayment','信保付款方式',['','L/C','D/P','D/A 或 O/A']],['qty','数量 kg','number'],['sell','对客单价 USD/kg','number'],['customerTerm','Incoterm',['待确认','EXW','FCA','FOB','CFR','CIF','其他']],['place','交货地点 / 港口','text']];
const costs=[['buy','工厂采购单价','number'],['fx','买汇 / 成本汇率 RMB/USD','number'],['receive','收汇汇率 RMB/USD','number'],['sea','国际运费 USD/票','number'],['local','国内费用总额 RMB/票','number'],['tax','增值税率 %','number'],['rebate','退税率 %','number']];
const params=[['transport','运输保险费率 %','number'],['credit','信用保险费率 %','number'],['interest','年资金利率 %','number'],['months','资金占用月数','number']];
const factoryFields=[['cas','CAS 号','text'],['quoteDate','报价日期','date'],['name','产品','text'],['purity','含量 / 纯度','text'],['quality','其他关键质量指标','text'],['hazard','货物危险性','text'],['factory','工厂','text'],['details','报价明细','text'],['quantity','数量','text'],['validity','报价有效期','date'],['price','报价单价','number'],['currency','币种',['USD','RMB']],['tax','增值税率 %','number'],['rebate','退税率 %（不退税填 0）','number'],['unit','计价单位',['待确认','吨','公斤']],['incoterm','Incoterm',['待确认','EXW','FCA','FOB','CFR','CIF','其他']],['port','交货地点','text'],['loading','装柜量 / 柜型','text'],['packing','包装方式','text'],['delivery','交货期（含年份）','text'],['warehouse','进仓费承担方',['我方','工厂']],['portfee','港杂费承担方',['我方','工厂']]];
const productFields=[['name','产品名称','text'],['cas','CAS 号','text'],['hazard','货物危险性','text'],['tax','增值税率 %','number'],['rebate','退税率 %','number']];
const freightContainerTypes=['20GP','40GP','40HQ','45HQ'];
const freightUnits=['公斤','吨','CBM','票'];
const freightBulkyOptions=['否','是'];
const freightFields=[['agent','货代名称','text'],['origin','起运地','text'],['destination','目的地','text'],['transportMode','运输方式',['海运整柜','海运拼箱','空运']],['containerType','柜型',freightContainerTypes],['quantity','询价数量','number'],['quantityUnit','询价单位',freightUnits],['bulky','是否抛货',freightBulkyOptions],['volume','体积（CBM）','number'],['valid','有效期','date'],['sea','国际运费 USD/票','number'],['local','国内费用 RMB/票','number']];
const defaults={product:'',cas:'',customer:'',qty:null,sell:null,customerTerm:'待确认',place:'',buy:null,fx:6.75,receive:6.75,sea:null,local:null,tax:13,rebate:null,transport:.03,credit:null,interest:3.6,months:3};
function validRebate(rate){return Number.isFinite(rate)&&rate>=0&&rate<=100;}
function fcaCost(v){return (v.buy-v.buy/(1+v.tax/100)*(v.rebate/100))/v.fx;}
function calculate(v,m){const revenue=v.qty*v.sell,insurance=revenue*1.1*v.transport/100,credit=revenue*v.credit/100,interest=revenue*v.interest/100/12*v.months;if(m==='own'){const rate=v.receive,unit=v.sell-(insurance+credit+interest+v.sea+v.local/rate)/v.qty;return{unit,rmb:unit*(1+v.tax/100)/(1+(v.tax-v.rebate)/100)*rate,insurance,credit,interest}}const base=m==='rmb'?fcaCost(v):v.buy+v.local/v.fx/v.qty;const landed=base+v.sea/v.qty+(m==='rmb'?v.local/v.fx/v.qty:0);const profit=revenue-insurance-credit-interest-landed*v.qty;return{base,landed,profit,margin:base?v.qty?profit/(base*v.qty):0:0,rmb:revenue*v.receive-(insurance+credit+interest)*v.fx-landed*v.fx*v.qty,insurance,credit,interest}}
const samples={rmb:{product:'20IBC of DPG',qty:20000,sell:2.33,sea:5000,local:2000,fx:6.67,buy:14.2,rebate:13,credit:.441},usd:{product:'Florfenicol-Sea FCL',customer:'STIM',qty:8000,sell:24.5,sea:2900,local:8000,fx:6.85,receive:6.75,buy:21.5},own:{product:'DCP',customer:'Kingchem',qty:1000,sell:27.5,sea:0,seaMax:0,local:2000,receive:6.75,tax:13,rebate:13,credit:.422,months:6}};
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

function normalizeCas(value) {
  return String(value ?? '').replace(/<br\s*\/?>|&nbsp;|&#x20;/gi, ' ').trim().replace(/[‐‑–—－]/g, '-').replace(/\s+/g, '');
}
function normalizeFactoryDate(value) {
  const match = String(value ?? '').trim().match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : '';
}
/** Local calendar date for form defaults; unlike toISOString this never shifts across midnight or time zones. */
function localDateString(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const chineseNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const spelledNumbers = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, sixty: 60, ninety: 90 };
function durationAmount(raw) {
  const text = String(raw ?? '').toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (spelledNumbers[text] !== undefined) return spelledNumbers[text];
  if (!/^[一二两三四五六七八九十]+$/.test(text)) return null;
  if (text.length === 1) return chineseNumbers[text];
  if (text[0] === '十') return 10 + (chineseNumbers[text[1]] ?? 0);
  if (text[1] === '十') return chineseNumbers[text[0]] * 10 + (chineseNumbers[text[2]] ?? 0);
  return null;
}
/** "30 days", "two weeks", "三日内有效" and "有效期一个月" all describe a period measured from the quote date. */
function validityDuration(value) {
  const text = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  if (!text) return null;
  // A period that starts after an order, payment or shipment is not a quote validity period.
  if (/订单|合同|交货|装运|发货|付款|开证|生产|排产|order|purchase\s+order|\bPO\b|delivery|shipment|payment|production/i.test(text)) return null;
  const match = text.match(/(\d+(?:\.\d+)?|[a-z]+|[一二两三四五六七八九十]+)\s*[- ]?\s*(days?|weeks?|months?|years?|天|日|周|星期|个?月|年)/i);
  if (!match) return null;
  const amount = durationAmount(match[1]);
  if (!Number.isFinite(amount) || amount <= 0 || amount % 1 !== 0) return null;
  const unit = /^(?:days?|天|日)$/.test(match[2]) ? 'day'
    : /^(?:weeks?|周|星期)$/.test(match[2]) ? 'week'
    : /^(?:months?|个?月)$/.test(match[2]) ? 'month'
    : /^(?:years?|年)$/.test(match[2]) ? 'year' : null;
  const limits = { day: 3650, week: 520, month: 120, year: 10 };
  if (!unit || amount > limits[unit]) return null;
  return { amount, unit };
}
const durationLabels = { day: '天', week: '周', month: '个月', year: '年' };
function addValidityDate(quoteDate, duration) {
  const base = normalizeFactoryDate(quoteDate);
  if (!base || !validDate(base) || !duration || !Number.isFinite(duration.amount) || duration.amount <= 0) return '';
  const date = new Date(`${base}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return '';
  if (duration.unit === 'day' || duration.unit === 'week') {
    date.setUTCDate(date.getUTCDate() + duration.amount * (duration.unit === 'week' ? 7 : 1));
  } else {
    const months = duration.amount * (duration.unit === 'year' ? 12 : 1);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  const result = date.toISOString().slice(0, 10);
  return validDate(result) ? result : '';
}
/** Quote validity = quote date + the period stated in the quote; already-absolute dates need no conversion. */
function factoryValidity(quoteDate, value) {
  const base = normalizeFactoryDate(quoteDate);
  if (!base || !validDate(base) || !String(value ?? '').trim() || normalizeFactoryDate(value)) return null;
  const duration = validityDuration(value);
  if (!duration) return null;
  const date = addValidityDate(base, duration);
  return date ? { date, duration, label: `${duration.amount} ${durationLabels[duration.unit]}` } : null;
}
const filterText = value => String(value ?? '').normalize('NFKC').trim();
/** CAS filtering only keeps digits and letters so separators and full-width characters do not matter. */
const casKey = value => filterText(value).replace(/[^0-9a-z]/gi, '').toLowerCase();
/** Calculation history matches a CAS or customer keyword anywhere in the stored value; blank filters match everything. */
function historyMatches(row, filter) {
  const cas = casKey(filter?.cas), customer = filterText(filter?.customer).toLowerCase();
  const values = row?.values ?? {};
  if (cas && !casKey(values.cas).includes(cas)) return false;
  if (customer && !filterText(values.customer).toLowerCase().includes(customer)) return false;
  return true;
}
function catalogProducts(db) {
  const products = (db.products ?? []).map((product, manualIndex) => ({ ...product, manualIndex }));
  const known = new Map(products.map((product, index) => [normalizeCas(product.cas), index]));
  // CAS binds the product name to its VAT/rebate rates: the newest saved calculation wins, factories fall back to rebate.
  const rates = new Map();
  const learn = (cas, tax, rebate) => {
    const entry = rates.get(cas) ?? {};
    if (entry.tax === undefined && nonnegative(tax)) entry.tax = tax;
    if (entry.rebate === undefined && validRebate(rebate)) entry.rebate = rebate;
    rates.set(cas, entry);
  };
  // Factory quotes also bind the cargo hazard. The newest quote for a CAS wins; a catalog override wins over it.
  const hazards = new Map();
  for (const record of db.history ?? []) {
    if (record?.mode === 'usd') continue; // USD calculations hide VAT/rebate; keep the last RMB/own binding
    const values = record?.values ?? {};
    const cas = normalizeCas(values.cas);
    if (cas) learn(cas, values.tax, values.rebate);
  }
  for (const quote of db.factories ?? []) {
    const cas = normalizeCas(quote?.cas);
    if (!cas) continue;
    learn(cas, quote.tax, quote.rebate);
    const hazard = filterText(quote.hazard);
    if (hazard && !hazards.has(cas)) hazards.set(cas, hazard);
  }
  for (const [cas, entry] of rates) {
    const index = known.get(cas);
    if (index === undefined) continue;
    // Explicit catalog values win; otherwise keep following the latest calculation/quote.
    const product = products[index];
    if (!Number.isFinite(product.tax) && Number.isFinite(entry.tax)) product.tax = entry.tax;
    if (!Number.isFinite(product.rebate) && Number.isFinite(entry.rebate)) product.rebate = entry.rebate;
  }
  for (const [cas, hazard] of hazards) {
    const index = known.get(cas);
    if (index !== undefined && !filterText(products[index].hazard)) products[index].hazard = hazard;
  }
  const saved = [...(db.history ?? []).map(record => record.values), ...(db.factories ?? []).map(quote => ({ product: quote.name, cas: quote.cas }))];
  for (const values of saved) {
    const cas = normalizeCas(values?.cas), name = values?.product?.trim();
    if (!name || !/^\d{2,7}-\d{2}-\d$/.test(cas) || known.has(cas)) continue;
    products.push({ name, cas, ...(rates.get(cas) ?? {}), ...(hazards.has(cas) ? { hazard: hazards.get(cas) } : {}) });
    known.set(cas, products.length - 1);
  }
  return products;
}
const nonnegative = n => Number.isFinite(n) && n >= 0;
const positive = n => Number.isFinite(n) && n > 0;
// 结构化文本只允许英文、数字和标点；工厂名称是中文字段的唯一例外。
const chinesePattern = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const hasChinese = value => typeof value === 'string' && chinesePattern.test(value);
const text = s => typeof s === 'string' && s.trim().length > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const modes = ['rmb', 'usd', 'own'];

/** A bare quantity follows the quote unit; an explicit kg/t suffix wins. Ranges and loading specs stay unknown. */
function factoryQuantityKg(value, unit) {
  const match = String(value ?? '').replaceAll(',', '').trim().match(/^(\d+(?:\.\d+)?)\s*(kg|公斤|千克|t|吨|mt)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const tons = match[2] ? /^(t|吨|mt)$/i.test(match[2]) : unit === '吨';
  return amount * (tons ? 1000 : 1);
}
/** C&F (CFR) unit cost only needs cost inputs, not selling price or credit terms. */
function cfrCost(v, mode) {
  if (!object(v) || !['rmb', 'usd'].includes(mode) || !positive(v.qty) || !positive(v.fx)) return null;
  if (![v.buy, v.sea, v.local].every(nonnegative)) return null;
  if (mode === 'rmb' && (!nonnegative(v.tax) || !validRebate(v.rebate))) return null;
  const base = mode === 'rmb' ? fcaCost(v) : v.buy;
  return base + v.sea / v.qty + v.local / v.fx / v.qty;
}

/** New calculations require explicit amounts; zero means confirmed no cost. */
function validateCalculation(v, mode) {
  if (!object(v) || !modes.includes(mode) || !positive(v.qty)) return false;
  if (mode === 'own' ? !positive(v.receive) : !positive(v.fx)) return false;
  if (mode === 'usd' && !positive(v.receive)) return false;
  if (!['sell','sea','seaMax','local','transport','credit','interest','months'].every(k => nonnegative(v[k]))) return false;
  if (mode !== 'usd' && !nonnegative(v.tax)) return false;
  if (mode !== 'own' && !nonnegative(v.buy)) return false;
  if (v.seaMax < v.sea) return false;
  if (mode !== 'usd' && !validRebate(v.rebate)) return false;
  if (mode === 'own' && v.rebate - v.tax >= 100) return false; // 退税率不能达到 100% + 增值税率
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
  if (kind === 'products') {
    if (!text(r.name) || typeof r.cas !== 'string' || !/^\d{2,7}-\d{2}-\d$/.test(normalizeCas(r.cas))) throw new Error('请填写产品名称和 CAS 号，格式如 67-68-5。');
    if (r.hazard != null && typeof r.hazard !== 'string') throw new Error('货物危险性须为文本。');
    if (r.tax != null && !validRebate(r.tax)) throw new Error('请填写 0–100 的增值税率。');
    if (r.rebate != null && !validRebate(r.rebate)) throw new Error('请填写 0–100 的退税率。');
  } else if (kind === 'factories') {
    if (!text(r.name) || !positive(r.price)) throw new Error('工厂报价须填写产品名称和有效正数价格。');
    if (!['RMB','USD'].includes(r.currency) || !['吨','公斤'].includes(r.unit)) throw new Error('工厂报价须确认币种和计价单位。');
    if ((r.currency === 'RMB' || r.rebate != null) && !validRebate(r.rebate)) throw new Error('请填写 0–100 的退税率，不退税填 0。');
    if (r.tax != null && !validRebate(r.tax)) throw new Error('请填写 0–100 的增值税率。');
  } else if (kind === 'freights') {
    if (!text(r.agent)) throw new Error('货代报价须填写货代名称。');
    // New records store origin/destination separately and scope FCL by container, LCL/air by inquiry quantity.
    // Records created before this change keep one route text and one basis text, and must stay valid.
    const scoped = text(r.origin) || text(r.destination) || text(r.containerType) || text(r.quantityUnit) || positive(r.quantity);
    if (scoped) {
      if (!text(r.origin) || !text(r.destination)) throw new Error('货代报价须分别填写起运地和目的地。');
      if (!transportModes.includes(r.transportMode)) throw new Error('货代报价须确认有效运输方式。');
      if (r.transportMode === '海运整柜') {
        if (!freightContainerTypes.includes(r.containerType)) throw new Error('整柜报价须选择有效柜型。');
      } else {
        if (!positive(r.quantity)) throw new Error('拼箱或空运报价须填写询价数量。');
        if (!freightUnits.includes(r.quantityUnit)) throw new Error('拼箱或空运报价须选择询价单位。');
        if (r.transportMode === '海运拼箱' && r.bulky !== undefined && r.bulky !== null && r.bulky !== '') {
          if (!freightBulkyOptions.includes(r.bulky)) throw new Error('拼箱报价须选择是否抛货。');
          if (r.bulky === '是' && !positive(r.volume)) throw new Error('抛货报价须填写体积（CBM）。');
        }
      }
    } else {
      if (!['route','basis'].every(k => text(r[k]))) throw new Error('货代报价须填写货代、路线和费用口径。');
      if (!transportModes.includes(r.transportMode)) throw new Error('货代报价须确认有效运输方式。');
    }
    if (!validDate(r.valid)) throw new Error('货代报价须填写有效日期（年-月-日）。');
    if (!nonnegative(r.sea) || !nonnegative(r.local)) throw new Error('运费和国内费用须为非负数，无费用填 0。');
  } else if (kind === 'history') {
    if (!modes.includes(r.mode) || !object(r.values) || !text(r.values.product)) throw new Error('核算记录须包含有效模式、产品和核算数据。');
    // Original exports may predate rebate and seaMax. Never mutate their data.
    const v = {...r.values};
    if (r.mode === 'rmb') v.rebate ??= v.tax;
    if (r.mode === 'own') {
      // Older own-factory records used the purchase FX and had no freight ceiling or rebate.
      v.seaMax ??= v.sea;
      v.receive ??= v.fx;
      v.rebate ??= 0;
    } else v.seaMax ??= v.sea;
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
  if (data.products !== undefined) {
    if (!Array.isArray(data.products)) throw new Error('产品目录须为数组。');
    data.products.forEach((r, i) => {
      try { validateRecord('products', r); }
      catch (e) { throw new Error(`产品目录第 ${i + 1} 条：${e.message}`); }
    });
  }
  return data;
}
/** New records store origin and destination separately; legacy records keep one route string. */
function freightRoute(row) {
  const origin = String(row?.origin ?? '').trim(), destination = String(row?.destination ?? '').trim();
  if (origin || destination) return { origin, destination };
  const parts = String(row?.route ?? '').trim().split(/\s*(?:→|->|—|–|至|到|\bto\b)\s*/i).filter(Boolean);
  return parts.length > 1
    ? { origin: parts[0], destination: parts.slice(1).join(' → ') }
    : { origin: parts[0] || '', destination: '' };
}
/** FCL compares by container type; LCL/air by inquiry quantity and unit; bulky LCL also by volume; legacy records keep their basis. */
function freightBasis(row) {
  if (row?.transportMode === '海运整柜' && text(row.containerType)) return row.containerType.trim();
  if (row?.transportMode !== '海运整柜' && positive(row.quantity) && text(row.quantityUnit)) {
    const base = `${row.quantity} ${String(row.quantityUnit).trim()}`;
    return row.transportMode === '海运拼箱' && row.bulky === '是' && positive(row.volume) ? `${base} · 抛货 ${row.volume} CBM` : base;
  }
  return text(row?.basis) ? row.basis.trim() : '';
}
/** Invalid, incompatible, or expired selections return null. today is local YYYY-MM-DD or Date. */
function averageFreights(rows, today = new Date()) {
  if (today instanceof Date) {
    if (!Number.isFinite(today.getTime())) return null;
    today = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  }
  if (!validDate(today) || !Array.isArray(rows) || !rows.length) return null;
  try { rows.forEach(r => validateRecord('freights',r)); } catch { return null; }
  const key = r => { const route = freightRoute(r); return JSON.stringify([route.origin, route.destination, r.transportMode, freightBasis(r)]); };
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
/** "class 9 UN3082", "class 3", "UN 1993" and labeled hazard text all describe cargo hazard. */
function extractHazard(value) {
  const details = String(value ?? '');
  const labeled = details.match(/(?:货物危险性|危险(?:性|品|货物)?(?:类别|等级|分类)?|hazard(?:ous\s+goods)?|danger(?:ous\s+goods)?)\s*[:：]\s*([^。\n;；]+)/i)?.[1]?.trim();
  if (labeled) return labeled;
  const classMatch = details.match(/\bclass\s*[:：]?\s*(\d+(?:\.\d+)?|[xX])\b/i)
    || details.match(/第?\s*(\d+(?:\.\d+)?)\s*类/);
  const unMatch = details.match(/\bUN\s*(?:No\.?|Number|编号)?\s*[:：]?\s*(\d{4}|[xX]{4})\b/i);
  const clean = text => text.replace(/\s+/g, ' ').trim();
  if (classMatch && unMatch && Math.abs(classMatch.index - unMatch.index) <= 48) {
    return classMatch.index <= unMatch.index
      ? `${clean(classMatch[0])} ${clean(unMatch[0])}`
      : `${clean(unMatch[0])} ${clean(classMatch[0])}`;
  }
  if (classMatch) return clean(classMatch[0]);
  if (unMatch) return clean(unMatch[0]);
  return details.match(/(?:^|[，,。；;\s])(非危险品|非危险货物|危险品|危险货物)(?=$|[，,。；;\s])/)?.[1]
    || (/(?:非危险品|非危险货物|not dangerous goods|non-hazardous)/i.test(details) ? '非危险品' : '');
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
  const purity = (details.match(/(?:含量|纯度|purity|assay)\s*[:：]?\s*[≥>]?\s*(\d{1,3}(?:\.\d+)?\s*%)/i)
    || details.match(/(\d{1,3}(?:\.\d+)?\s*%)\s*(?:min\b|以上)?\s*(?:含量|纯度|purity|assay)/i))?.[1]?.trim() || '';
  const quality = details.match(/(?:其他关键质量指标|其他质量指标|质量指标|quality indicators?)\s*[:：]\s*([^。\n;；]+)/i)?.[1]?.trim() || '';
  const hazard = extractHazard(details);
  return {
    name:'', purity, quality, hazard, factory:'', details, raw:details,
    price:single ? Number((single[1] || single[2]).replaceAll(',','')) : '',
    currency:single && /USD|美金|美元|\$/i.test(single[0]) ? 'USD' : 'RMB',
    tax:null, rebate:null, unit:ton === kg ? '待确认' : ton ? '吨' : '公斤',
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
  const keys={'产品':'name','工厂':'factory','报价明细':'details','数量':'quantity','CAS':'cas','CAS 号':'cas','CAS号':'cas','报价日期':'quoteDate','报价有效期':'validity','交货期':'delivery','含量':'purity','纯度':'purity','含量/纯度':'purity','含量 / 纯度':'purity','其他关键质量指标':'quality','质量指标':'quality','货物危险性':'hazard','危险性':'hazard','危险品':'hazard','危险货物':'hazard','危险品类别':'hazard','危险品等级':'hazard','危险货物类别':'hazard','hazard':'hazard'};
  return rows.slice(1).map(row=>{
    const explicit=Object.fromEntries(header.flatMap((key,i)=>keys[key]?[[keys[key],row[i]||'']]:[]));
    return {...parseQuote(explicit.details),...explicit,
      cas:normalizeCas(explicit.cas), quoteDate:normalizeFactoryDate(explicit.quoteDate),
      // Keep a stated period such as "30 days"; the form turns it into quoteDate + 30 days.
      validity:normalizeFactoryDate(explicit.validity) || String(explicit.validity ?? '').trim()};
  });
}
export {normalizeCas,normalizeFactoryDate,localDateString,validityDuration,addValidityDate,factoryValidity,historyMatches,catalogProducts,basic,costs,params,factoryFields,productFields,freightFields,defaults,samples,transportModes,creditCountries,lookupCreditRate,calculate,fcaCost,cfrCost,factoryQuantityKg,validRebate,hasChinese,validateCalculation,parseQuotes,extractHazard,validateRecord,validateDatabase,averageFreights,freightRoute,freightBasis,freightContainerTypes,freightUnits,freightBulkyOptions};
