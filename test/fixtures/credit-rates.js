// Frozen baseline for the credit insurance rate table.
// Copied verbatim from the standalone app's dist/credit-rates.js: the 2018
// country/region classification and the 2026-2027.6 rate matrix. domain.js must
// reproduce these labels, period boundaries and rates exactly. Change this file
// only when the published rate table itself changes, never to match a bug.

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
