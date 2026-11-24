// Small, dependency-free XLSX writer for the editable quotation workbook.
// The workbook intentionally uses inline strings and live formulas so it opens
// in Excel/WPS/LibreOffice without shared-string or calculation side files.
import { deflateRawSync } from 'node:zlib';
import { normalizeFactoryDate } from './domain.js';

const TZ = 'Asia/Shanghai';
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MODE_LABELS = { rmb: '人民币采购', usd: '美元采购', own: '自有工厂倒推' };
const SELLER = 'SUNRISE ASIA LIMITED';

function xml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '&#10;');
}
const numberText = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number * 1e10) / 1e10);
};
const colName = index => {
  let value = '', number = index;
  while (number > 0) { const digit = (number - 1) % 26; value = String.fromCharCode(65 + digit) + value; number = Math.floor((number - 1) / 26); }
  return value;
};
const cellName = (row, col) => `${colName(col)}${row}`;

function dateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function longDate(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}
function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}
function buyerCode(name) {
  const words = String(name ?? '').match(/[A-Za-z0-9]+/g) ?? [];
  if (words.length > 1) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase().padEnd(2, 'X');
  return 'GEN';
}
function dayKey(date) {
  const parts = dateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function longDateFromKey(key) {
  return longDate(new Date(`${key}T12:00:00+08:00`));
}
function quoteValidity(items, generatedAt) {
  const today = dayKey(generatedAt);
  const fallback = dayKey(addDays(generatedAt, 30));
  const dates = items.map(item => {
    const validity = normalizeFactoryDate(item.factory?.validity);
    return validity && validity >= today ? validity : fallback;
  });
  return `Until 14:00 Beijing time, ${longDateFromKey(dates.sort()[0] || fallback)}`;
}
function paymentText(values) {
  const type = values.creditPayment === 'D/A 或 O/A' ? 'D/A or O/A' : values.creditPayment || '';
  const days = Number.isFinite(values.creditMonths) && values.creditMonths > 0 ? Math.round(values.creditMonths * 30) : null;
  if (type && days) return `${type} at ${days} days`;
  if (type) return type;
  if (days) return `${days} days`;
  return '';
}
function transportPhrase(mode) {
  return ({
    '海运整柜': 'BY SEA IN FCL',
    '海运拼箱': 'BY SEA IN LCL',
    '空运': 'BY AIR',
    '铁路': 'BY RAIL',
    '公路': 'BY ROAD',
    '快递': 'BY COURIER',
  })[mode] || '';
}

// ---- ZIP container -------------------------------------------------------
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
function zip(files, date = new Date()) {
  const stamp = dosTime(date), locals = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, packed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);
    offset += local.length + nameBuffer.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ---- Styles --------------------------------------------------------------
const STYLE = {
  normal: 0, title: 1, subtitle: 2, label: 3, text: 4, inputText: 5,
  inputNum: 6, inputDecimal: 7, formulaNum: 8, formulaDecimal: 9, formulaMoney: 10,
  formulaPercent: 11, totalLabel: 12, totalMoney: 13, section: 14, note: 15,
  formulaInt: 16, inputPercent: 17, inputRate: 18, inputCenter: 19, textCenter: 20,
  formulaRmb: 21, tableHead: 22, noteBox: 23, formulaDecimal4: 24, totalPercent: 25,
  totalRmb: 26, inputMoney: 27, inputInt: 28, totalNum: 29, company: 30,
  quoteSubtitle: 31, metaLabel: 32, metaValue: 33, rule: 34, bodyLeft: 35,
  bodyCenter: 36, bodyRight: 37, unitPrice: 38, bodyQty: 39,
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="13">
<numFmt numFmtId="164" formatCode="#,##0.00"/>
<numFmt numFmtId="165" formatCode="#,##0.000"/>
<numFmt numFmtId="166" formatCode="0.00"/>
<numFmt numFmtId="167" formatCode="0.00&quot;%&quot;"/>
<numFmt numFmtId="168" formatCode="0.000&quot;%&quot;"/>
<numFmt numFmtId="169" formatCode="&quot;USD &quot;#,##0.00"/>
<numFmt numFmtId="170" formatCode="0.00%"/>
<numFmt numFmtId="171" formatCode="#,##0"/>
<numFmt numFmtId="172" formatCode="&quot;RMB &quot;#,##0.00"/>
<numFmt numFmtId="173" formatCode="#,##0.0000"/>
<numFmt numFmtId="174" formatCode="0.00"/>
<numFmt numFmtId="175" formatCode="&quot;$&quot;#,##0.00"/>
<numFmt numFmtId="176" formatCode="#,##0.00&quot; kg&quot;"/>
</numFmts>
<fonts count="10">
<font><sz val="11"/><color rgb="FF1F2937"/><name val="Microsoft YaHei"/><charset val="134"/></font>
<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Microsoft YaHei"/><charset val="134"/></font>
<font><b/><sz val="20"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><charset val="134"/></font>
<font><sz val="9"/><color rgb="FF6B7280"/><name val="Microsoft YaHei"/><charset val="134"/></font>
<font><b/><sz val="11"/><color rgb="FF1F4E78"/><name val="Microsoft YaHei"/><charset val="134"/></font>
<font><b/><sz val="12"/><color rgb="FF1F4E78"/><name val="Microsoft YaHei"/><charset val="134"/></font>
<font><sz val="10"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><charset val="134"/></font>
<font><b/><sz val="9"/><color rgb="FF6B7280"/><name val="Microsoft YaHei"/><charset val="134"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><charset val="134"/></font>
<font><b/><sz val="22"/><color rgb="FF1F4E78"/><name val="Microsoft YaHei"/><charset val="134"/></font>
</fonts>
<fills count="8">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="4">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFB4C6E7"/></left><right style="thin"><color rgb="FFB4C6E7"/></right><top style="thin"><color rgb="FFB4C6E7"/></top><bottom style="thin"><color rgb="FFB4C6E7"/></bottom><diagonal/></border>
<border><left/><right/><top/><bottom style="medium"><color rgb="FF1F4E78"/></bottom><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFD9E2F3"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="40">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1" indent="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1" indent="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1" indent="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="169" fontId="0" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="170" fontId="0" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="169" fontId="5" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="171" fontId="0" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="167" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="168" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="172" fontId="0" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="8" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="173" fontId="0" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="170" fontId="5" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="172" fontId="5" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="169" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="171" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="164" fontId="5" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="9" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="7" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1" indent="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="7" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="7" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="175" fontId="0" fillId="7" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="176" fontId="0" fillId="7" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

class Sheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map();
    this.merges = [];
    this.widths = [];
    this.heights = new Map();
    this.validations = [];
    this.freezeRow = 0;
    this.landscape = false;
    this.selected = false;
  }
  key(row, col) { return `${row}:${col}`; }
  cell(row, col, value, style = STYLE.normal) {
    this.cells.set(this.key(row, col), { row, col, value, style });
  }
  blank(row, col, style = STYLE.normal) {
    if (!this.cells.has(this.key(row, col))) this.cells.set(this.key(row, col), { row, col, value: undefined, style });
  }
  formula(row, col, formula, style = STYLE.formulaNum, cached) {
    this.cells.set(this.key(row, col), { row, col, formula, value: cached, style });
  }
  merge(row1, col1, row2, col2, style = STYLE.normal) {
    this.merges.push({ row1, col1, row2, col2 });
    for (let row = row1; row <= row2; row++) for (let col = col1; col <= col2; col++) this.blank(row, col, style);
  }
  width(col, value) { this.widths[col - 1] = value; }
  height(row, value) { this.heights.set(row, value); }
  validation(range, options = {}) { this.validations.push({ range, ...options }); }
  maxRow() { return Math.max(1, ...[...this.cells.values()].map(cell => cell.row), ...this.merges.map(range => range.row2)); }
  maxCol() { return Math.max(1, ...[...this.cells.values()].map(cell => cell.col), ...this.merges.map(range => range.col2)); }
  xml() {
    const rows = [...this.cells.values()].sort((a, b) => a.row - b.row || a.col - b.col);
    const grouped = new Map();
    for (const cell of rows) {
      if (!grouped.has(cell.row)) grouped.set(cell.row, []);
      grouped.get(cell.row).push(cell);
    }
    for (const row of this.heights.keys()) if (!grouped.has(row)) grouped.set(row, []);
    const rowXml = [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([row, cells]) => {
      const height = this.heights.get(row);
      const attrs = `r="${row}"${height ? ` ht="${height}" customHeight="1"` : ''}`;
      const content = cells.sort((a, b) => a.col - b.col).map(cell => this.cellXml(cell)).join('');
      return `<row ${attrs}>${content}</row>`;
    }).join('');
    const cols = this.widths.map((width, index) => width ? `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>` : '').join('');
    const merges = this.merges.map(range => `<mergeCell ref="${cellName(range.row1, range.col1)}:${cellName(range.row2, range.col2)}"/>`).join('');
    const validations = this.validations.length ? `<dataValidations count="${this.validations.length}">${this.validations.map(validation => `<dataValidation type="decimal" allowBlank="1" showErrorMessage="1" errorTitle="${xml(validation.title || 'Invalid input')}" error="${xml(validation.message || 'Enter a number greater than or equal to zero.')}" sqref="${validation.range}"><formula1>0</formula1></dataValidation>`).join('')}</dataValidations>` : '';
    const freeze = this.freezeRow ? `<pane ySplit="${this.freezeRow}" topLeftCell="A${this.freezeRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${this.freezeRow + 1}" sqref="A${this.freezeRow + 1}"/>` : '<selection activeCell="A1" sqref="A1"/>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${cellName(this.maxRow(), this.maxCol())}"/>
<sheetViews><sheetView showGridLines="0"${this.selected ? ' tabSelected="1"' : ''} workbookViewId="0">${freeze}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${rowXml}</sheetData>
${merges ? `<mergeCells count="${this.merges.length}">${merges}</mergeCells>` : ''}
${validations}
<printOptions horizontalCentered="1"/>
<pageMargins left="0.35" right="0.35" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
<pageSetup paperSize="9" orientation="${this.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;L${xml(this.name)}&amp;C&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>
</worksheet>`;
  }
  cellXml(cell) {
    const ref = cellName(cell.row, cell.col);
    const style = cell.style ? ` s="${cell.style}"` : '';
    if (cell.formula) {
      const cached = Number.isFinite(cell.value) ? `<v>${numberText(cell.value)}</v>` : '';
      return `<c r="${ref}"${style}><f>${xml(String(cell.formula).replace(/^=/, ''))}</f>${cached}</c>`;
    }
    if (cell.value === undefined || cell.value === null) return `<c r="${ref}"${style}/>`;
    if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return `<c r="${ref}"${style}><v>${numberText(cell.value)}</v></c>`;
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(cell.value)}</t></is></c>`;
  }
}

function quoteSheet({ items, quoteNo, generatedAt, dateText }) {
  const sheet = new Sheet('Quotation');
  sheet.selected = true;
  sheet.landscape = true;
  sheet.widths = [7, 24, 16, 40, 18, 22, 28, 28];
  sheet.height(1, 34); sheet.height(2, 18); sheet.height(3, 4);
  sheet.merge(1, 1, 1, 8, STYLE.company); sheet.cell(1, 1, SELLER, STYLE.company);
  sheet.merge(2, 1, 2, 8, STYLE.quoteSubtitle); sheet.cell(2, 1, 'QUOTATION', STYLE.quoteSubtitle);
  sheet.merge(3, 1, 3, 8, STYLE.rule); sheet.blank(3, 1, STYLE.rule);

  const metaLabel = (row, col, text) => sheet.cell(row, col, text, STYLE.metaLabel);
  const metaValue = (row, col1, col2, text) => {
    sheet.merge(row, col1, row, col2, STYLE.metaValue);
    if (text) sheet.cell(row, col1, text, STYLE.metaValue);
  };
  const firstValues = items[0].values;
  const termItem = items.find(item => item.values.customerTerm && item.values.customerTerm !== '待确认') || items[0];
  const term = termItem.values.customerTerm && termItem.values.customerTerm !== '待确认' ? termItem.values.customerTerm : '';
  const place = termItem.values.place || '';
  const transport = [...new Set(items.map(item => transportPhrase(item.values.transportMode)).filter(Boolean))].join(' / ');
  const deliveryTerm = term ? [`${term}${place ? ` ${place}` : ''}`, transport].filter(Boolean).join(', ') : '';
  const paymentItem = items.find(item => item.values.creditPayment || (Number.isFinite(item.values.creditMonths) && item.values.creditMonths > 0)) || items[0];
  const payment = paymentText(paymentItem.values);
  const buyer = firstValues.customer || '';

  sheet.height(4, 22); sheet.height(5, 22); sheet.height(6, 10);
  metaLabel(4, 1, 'Buyer'); metaValue(4, 2, 3, buyer);
  metaLabel(4, 4, 'Quotation No.'); metaValue(4, 5, 8, quoteNo);
  metaLabel(5, 1, 'Date'); metaValue(5, 2, 3, dateText);
  metaLabel(5, 4, 'Delivery term'); metaValue(5, 5, 8, deliveryTerm);

  const headerRow = 7;
  sheet.height(headerRow, 34);
  ['Item', 'Product', 'Quantity', 'Specification / Packing', 'Unit Price (USD/kg)', 'Factory', 'Estimated Shipment', 'Remark']
    .forEach((text, index) => sheet.cell(headerRow, index + 1, text, STYLE.tableHead));

  const firstItem = 8;
  const lastItem = firstItem + Math.max(6, items.length) - 1;
  for (let row = firstItem; row <= lastItem; row++) {
    sheet.height(row, 34);
    for (let col = 1; col <= 8; col++) {
      const style = col === 1 || col === 6 || col === 7 ? STYLE.bodyCenter : col === 3 ? STYLE.bodyQty : col === 5 ? STYLE.unitPrice : STYLE.bodyLeft;
      sheet.blank(row, col, style);
    }
    sheet.cell(row, 1, row - firstItem + 1, STYLE.bodyCenter);
  }
  items.forEach((item, index) => {
    const row = firstItem + index;
    const factory = item.factory;
    const specification = [factory?.purity, factory?.packing].filter(Boolean).join('; ');
    const factoryName = factory?.factory || (item.mode === 'own' ? 'Own factory' : '');
    const remark = [factory?.hazard, factory?.quality].filter(Boolean).join('; ');
    const etdText = String(item.values.etd ?? '').trim();
    const set = (col, value, style) => {
      if (value !== undefined && value !== null && value !== '') sheet.cell(row, col, value, style);
    };
    set(2, item.values.product || '', STYLE.bodyLeft);
    set(3, Number.isFinite(item.values.qty) ? item.values.qty : '', STYLE.bodyQty);
    set(4, specification, STYLE.bodyLeft);
    set(5, Number.isFinite(item.values.sell) ? item.values.sell : '', STYLE.unitPrice);
    set(6, factoryName, STYLE.bodyCenter);
    set(7, etdText, STYLE.bodyCenter);
    set(8, remark, STYLE.bodyLeft);
  });

  const footer = lastItem + 2;
  sheet.height(footer, 26); sheet.height(footer + 1, 24); sheet.height(footer + 2, 48); sheet.height(footer + 3, 8);
  sheet.merge(footer, 1, footer, 2, STYLE.note); sheet.cell(footer, 1, 'Currency', STYLE.note);
  sheet.cell(footer, 3, 'USD', STYLE.metaValue);
  sheet.cell(footer, 4, 'Validity', STYLE.metaLabel);
  metaValue(footer, 5, 8, quoteValidity(items, generatedAt));
  sheet.merge(footer + 1, 1, footer + 1, 2, STYLE.metaLabel); sheet.cell(footer + 1, 1, 'Payment', STYLE.metaLabel);
  metaValue(footer + 1, 3, 8, payment);
  sheet.merge(footer + 2, 1, footer + 2, 2, STYLE.metaLabel); sheet.cell(footer + 2, 1, 'Notes', STYLE.metaLabel);
  const notes = 'The credit term validity is subject to Sinosure approval.';
  sheet.merge(footer + 2, 3, footer + 2, 8, STYLE.metaValue); sheet.cell(footer + 2, 3, notes, STYLE.metaValue);

  const rule = footer + 4;
  sheet.merge(rule, 1, rule, 8, STYLE.rule); sheet.blank(rule, 1, STYLE.rule);
  sheet.height(rule + 1, 30);
  sheet.merge(rule + 1, 1, rule + 1, 8, STYLE.quoteSubtitle); sheet.cell(rule + 1, 1, SELLER, STYLE.quoteSubtitle);
  sheet.validation(`E${firstItem}:E${lastItem}`, { title: 'Invalid input', message: 'Enter a unit price greater than or equal to zero.' });
  return sheet;
}

function costSheet({ mode, values, result, highFreightResult, factory, quoteNo, generatedAt, date, time, name = 'Costing (Internal)' }) {
  const sheet = new Sheet(name);
  sheet.landscape = true;
  sheet.widths = [27, 21, 19, 16, 16, 36];
  sheet.height(1, 34); sheet.height(2, 24); sheet.height(3, 24);
  sheet.merge(1, 1, 1, 6, STYLE.title); sheet.cell(1, 1, '成本核算与定价依据（内部）', STYLE.title);
  sheet.merge(2, 1, 2, 6, STYLE.note);
  sheet.cell(2, 1, '根据工厂报价与最终定价生成。黄色单元格可编辑；修改数量、单价、费用或汇率后，下方公式会自动重算。', STYLE.note);
  sheet.cell(3, 1, '报价编号', STYLE.label); sheet.cell(3, 2, quoteNo, STYLE.text);
  sheet.cell(3, 3, '生成时间', STYLE.label); sheet.merge(3, 4, 3, 6, STYLE.text); sheet.cell(3, 4, `${date} ${time}`, STYLE.text);

  let row = 5;
  sheet.merge(row, 1, row, 6, STYLE.section); sheet.cell(row, 1, '01 / 工厂报价信息', STYLE.section);
  row++;
  const info = (labelA, valueA, labelB, valueB) => {
    sheet.height(row, 24);
    sheet.cell(row, 1, labelA, STYLE.label);
    sheet.cell(row, 2, valueA ?? '—', STYLE.inputText);
    sheet.cell(row, 3, labelB, STYLE.label);
    sheet.merge(row, 4, row, 6, STYLE.inputText);
    sheet.cell(row, 4, valueB ?? '—', STYLE.inputText);
    row++;
  };
  info('工厂名称', factory?.factory, '产品 / 规格', factory?.name);
  info('含量 / 纯度', factory?.purity, '其他关键质量指标', factory?.quality);
  info('CAS 号', factory?.cas, '报价日期', factory?.quoteDate);
  info('工厂报价单价', Number.isFinite(factory?.price) ? `${factory.price} ${factory.currency || ''}/${factory.unit || ''}` : '—', '有效至', factory?.validity);
  info('Incoterm', factory?.incoterm, '交货地点', factory?.port);
  info('装柜量 / 柜型', factory?.loading, '包装方式', factory?.packing);
  const rateText = value => Number.isFinite(value) ? `${value}%` : '—';
  info('交货期', factory?.delivery, '增值税率 / 退税率', `${rateText(factory?.tax)} / ${rateText(factory?.rebate)}`);
  info('进仓费承担方', factory?.warehouse, '港杂费承担方', factory?.portfee);
  info('报价来源', factory ? '已关联已保存的工厂报价' : '未关联工厂报价', '核算模式', MODE_LABELS[mode]);
  sheet.height(row, 66);
  sheet.cell(row, 1, '工厂报价明细', STYLE.label);
  sheet.merge(row, 2, row, 6, STYLE.inputText);
  sheet.cell(row, 2, factory?.details || factory?.raw || '—', STYLE.inputText);
  row += 2;

  sheet.merge(row, 1, row, 6, STYLE.section); sheet.cell(row, 1, '02 / 最终定价输入（黄色单元格可编辑）', STYLE.section);
  row++;
  const inputs = {};
  const addInput = (key, label, value, style, unit, note) => {
    sheet.height(row, 23);
    sheet.cell(row, 1, label, STYLE.label);
    sheet.cell(row, 2, value, style);
    sheet.cell(row, 3, unit, STYLE.textCenter);
    sheet.merge(row, 4, row, 6, STYLE.text);
    sheet.cell(row, 4, note, STYLE.text);
    inputs[key] = `$B$${row}`;
    row++;
  };
  addInput('qty', '数量', values.qty, STYLE.inputNum, 'kg', '报价数量；金额与成本按此数量计算。');
  addInput('sell', '对客单价', values.sell, STYLE.inputDecimal, 'USD/kg', '最终对客户的美元单价。');
  if (mode !== 'own') {
    addInput('buy', mode === 'rmb' ? '含税采购单价' : '工厂采购单价', values.buy, STYLE.inputDecimal, mode === 'rmb' ? 'RMB/kg' : 'USD/kg', mode === 'rmb' ? '工厂人民币含税价，按退税率换算为 FCA 成本。' : '工厂美元采购价。');
    addInput('fx', '买汇 / 成本汇率', values.fx, STYLE.inputDecimal, 'RMB/USD', '用于采购、国内费用与人民币利润换算。');
  }
  addInput('receive', '收汇汇率', values.receive, STYLE.inputDecimal, 'RMB/USD', '美元收汇折算人民币的汇率。');
  addInput('sea', '最低国际运费', values.sea, STYLE.inputNum, 'USD/票', '最低运费情景使用。');
  addInput('seaMax', '最高国际运费', values.seaMax, STYLE.inputNum, 'USD/票', '最高运费情景使用；可与最低运费相同。');
  addInput('local', '国内费用总额', values.local, STYLE.inputNum, 'RMB/票', '我方承担的完整国内费用，避免重复计入。');
  if (mode !== 'usd') {
    addInput('tax', '增值税率', values.tax, STYLE.inputPercent, '%', '按百分数填写，如 13 表示 13%。');
    addInput('rebate', '退税率', values.rebate, STYLE.inputPercent, '%', '不退税填 0；按百分数填写。');
  }
  addInput('transport', '运输保险费率', values.transport, STYLE.inputRate, '%', '按百分数填写，如 0.03 表示 0.03%。');
  addInput('credit', '信用保险费率', values.credit, STYLE.inputRate, '%', '按百分数填写，如 0.441 表示 0.441%。');
  addInput('interest', '年资金利率', values.interest, STYLE.inputPercent, '%', '按百分数填写。');
  addInput('months', '资金占用月数', values.months, STYLE.inputInt, '月', '默认与账期一致，可手动修改。');
  row++;

  sheet.merge(row, 1, row, 6, STYLE.section); sheet.cell(row, 1, '03 / 成本与利润（最低 / 最高国际运费）', STYLE.section);
  row++;
  sheet.height(row, 28);
  sheet.cell(row, 1, '指标', STYLE.tableHead);
  sheet.cell(row, 2, '最低运费', STYLE.tableHead);
  sheet.cell(row, 3, '最高运费', STYLE.tableHead);
  sheet.merge(row, 4, row, 6, STYLE.tableHead); sheet.cell(row, 4, '计算说明', STYLE.tableHead);
  row++;
  const r = inputs;
  const revenue = `(${r.qty}*${r.sell})`;
  const insurance = `(${revenue}*1.1*${r.transport}/100)`;
  const creditFee = `(${revenue}*${r.credit}/100)`;
  const interestFee = `(${revenue}*${r.interest}/100/12*${r.months})`;
  const base = mode === 'rmb'
    ? `((${r.buy}-${r.buy}/(1+${r.tax}/100)*${r.rebate}/100)/${r.fx})`
    : mode === 'usd' ? `(${r.buy}+${r.local}/${r.fx}/${r.qty})` : '';
  const lowLanded = mode === 'rmb'
    ? `(${base}+${r.sea}/${r.qty}+${r.local}/${r.fx}/${r.qty})`
    : mode === 'usd' ? `(${base}+${r.sea}/${r.qty})` : '';
  const highLanded = mode === 'rmb'
    ? `(${base}+${r.seaMax}/${r.qty}+${r.local}/${r.fx}/${r.qty})`
    : mode === 'usd' ? `(${base}+${r.seaMax}/${r.qty})` : '';
  const ownUnit = sea => `(${r.sell}-(${insurance}+${creditFee}+${interestFee}+${sea}+${r.local}/${r.receive})/${r.qty})`;
  const ownRmb = unit => `(${unit}*(1+${r.tax}/100)/(1+(${r.tax}-${r.rebate})/100)*${r.receive})`;
  const deduction = `(1-(1.1*${r.transport}+${r.credit}+${r.interest}/12*${r.months})/100)`;
  const addition = (label, lowFormula, highFormula, lowValue, highValue, style = STYLE.formulaNum, description = '') => {
    sheet.height(row, 23);
    sheet.cell(row, 1, label, STYLE.label);
    sheet.formula(row, 2, lowFormula, style, lowValue);
    sheet.formula(row, 3, highFormula, style, highValue);
    sheet.merge(row, 4, row, 6, STYLE.text);
    sheet.cell(row, 4, description, STYLE.text);
    row++;
  };
  addition('销售收入', revenue, revenue, values.qty * values.sell, values.qty * values.sell, STYLE.formulaMoney, '数量 × 对客单价。');
  addition('运输保险', insurance, insurance, result.insurance, highFreightResult.insurance, STYLE.formulaMoney, '销售收入 × 110% × 运输保险费率。');
  addition('信用保险', creditFee, creditFee, result.credit, highFreightResult.credit, STYLE.formulaMoney, '销售收入 × 信用保险费率。');
  addition('资金占用', interestFee, interestFee, result.interest, highFreightResult.interest, STYLE.formulaMoney, '销售收入 × 年资金利率 ÷ 12 × 资金占用月数。');
  if (mode === 'own') {
    const lowUnit = ownUnit(r.sea), highUnit = ownUnit(r.seaMax);
    const lowRmb = ownRmb(lowUnit), highRmb = ownRmb(highUnit);
    addition('美元不含税倒推价', lowUnit, highUnit, result.unit, highFreightResult.unit, STYLE.formulaDecimal, '对客单价扣除运输保险、信用保险、资金占用、国际运费和国内费用后的倒推采购价。');
    addition('人民币含税倒推价', lowRmb, highRmb, result.rmb, highFreightResult.rmb, STYLE.formulaRmb, '按增值税率和退税率换算，并按收汇汇率折算为人民币。');
    addition('倒推价差（对客单价 - 美元倒推价）', `(${r.sell}-${lowUnit})`, `(${r.sell}-${highUnit})`, values.sell - result.unit, values.sell - highFreightResult.unit, STYLE.formulaDecimal, '可用于核对倒推价与最终报价之间的空间。');
  } else {
    addition('采购成本（FCA / 基础）', base, base, result.base, highFreightResult.base, STYLE.formulaDecimal, mode === 'rmb' ? '含税采购价按增值税率和退税率换算后的 FCA 成本。' : '工厂采购价加国内费用摊薄。');
    addition('C&F（CFR）成本', lowLanded, highLanded, result.landed, highFreightResult.landed, STYLE.formulaDecimal, '采购成本 + 国际运费 + 国内费用摊薄；不含保险、信保和资金占用。');
    const profitLow = `(${revenue}-${insurance}-${creditFee}-${interestFee}-${lowLanded}*${r.qty})`;
    const profitHigh = `(${revenue}-${insurance}-${creditFee}-${interestFee}-${highLanded}*${r.qty})`;
    addition('预计利润', profitLow, profitHigh, result.profit, highFreightResult.profit, STYLE.formulaMoney, '销售收入 − 三项费用 − C&F 成本 × 数量。');
    addition('采购成本利润率', `(${profitLow}/(${base}*${r.qty}))`, `(${profitHigh}/(${base}*${r.qty}))`, result.margin, highFreightResult.margin, STYLE.formulaPercent, '预计利润 ÷ 采购成本总额。');
    addition('人民币利润', `(${revenue}*${r.receive}-(${insurance}+${creditFee}+${interestFee})*${r.fx}-${lowLanded}*${r.fx}*${r.qty})`,
      `(${revenue}*${r.receive}-(${insurance}+${creditFee}+${interestFee})*${r.fx}-${highLanded}*${r.fx}*${r.qty})`,
      result.rmb, highFreightResult.rmb, STYLE.formulaRmb, '美元收入、费用和成本分别按收汇 / 成本汇率折算。');
    addition('盈亏平衡对客单价', `${lowLanded}/${deduction}`, `${highLanded}/${deduction}`, result.landed / (1 - (1.1 * values.transport + values.credit + values.interest / 12 * values.months) / 100),
      highFreightResult.landed / (1 - (1.1 * values.transport + values.credit + values.interest / 12 * values.months) / 100), STYLE.formulaDecimal, 'C&F 成本 ÷（1 − 保险、信保和资金占用费率）。');
  }
  row++;
  sheet.merge(row, 1, row, 6, STYLE.section); sheet.cell(row, 1, '04 / 使用说明', STYLE.section);
  row++;
  const notes = [
    '黄色单元格为输入项，修改后 Excel 会按本表公式自动重算；浅绿色为合计结果。',
    '“Quotation”工作表可直接编辑产品、规格包装、单价、客户、条款、工厂、交期和备注。',
    '“最低运费”列使用最低国际运费，“最高运费”列使用最高国际运费；两列共享其余输入。',
    '本工作簿用于报价与内部核算，正式对外前请复核条款、币种、数量和金额。',
  ];
  for (const text of notes) {
    sheet.height(row, 22);
    sheet.merge(row, 1, row, 6, STYLE.note);
    sheet.cell(row, 1, `· ${text}`, STYLE.note);
    row++;
  }
  return sheet;
}

function workbook(sheets) {
  const sheetTags = sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const definedNames = sheets.map((sheet, index) => `<definedName name="_xlnm.Print_Area" localSheetId="${index}">'${xml(sheet.name)}'!$A$1:$${colName(sheet.maxCol())}$${sheet.maxRow()}</definedName>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="23426"/>
<workbookPr/>
<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000" activeTab="0"/></bookViews>
<sheets>${sheetTags}</sheets>
<definedNames>
${definedNames}
</definedNames>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`;
}

/**
 * Build an editable quotation workbook. A single item creates the usual
 * Quotation + Costing (Internal) pair; multiple items share one Quotation page
 * and get one internal costing page per product.
 * @param {object} input
 * @param {Array<{mode:'rmb'|'usd'|'own', values:object, result:object, highFreightResult:object, factory?:object|null}>} [input.items]
 * @param {'rmb'|'usd'|'own'} [input.mode]
 * @param {object} [input.values]
 * @param {object} [input.result]
 * @param {object} [input.highFreightResult]
 * @param {object|null} [input.factory]
 * @param {Date} [input.generatedAt]
 * @returns {{buffer: Buffer, filename: string, quoteNo: string, generatedAt: string, mime: string}}
 */
export function buildQuotationWorkbook({ mode, values, result, highFreightResult, factory = null, items, generatedAt = new Date(), includeCosting = true }) {
  const list = Array.isArray(items) && items.length ? items : [{ mode, values, result, highFreightResult, factory }];
  for (const item of list) {
    if (!MODE_LABELS[item?.mode]) throw Error('未知核算模式');
    if (!item.values?.product || !Number.isFinite(item.values.qty) || item.values.qty <= 0) throw Error('请先填写产品名称和有效数量');
    if (!item.result || !item.highFreightResult) throw Error('缺少核算结果');
  }
  const first = list[0];
  const parts = dateParts(generatedAt);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  const dateText = longDate(generatedAt);
  const quoteNo = `SA-${buyerCode(first.values.customer)}-${date.replaceAll('-', '')}`;
  const quote = quoteSheet({ items: list, quoteNo, generatedAt, dateText });
  const costs = includeCosting ? list.map((item, index) => costSheet({
    ...item,
    quoteNo,
    generatedAt,
    date,
    time,
    name: list.length === 1 ? 'Costing (Internal)' : `Costing ${index + 1}`,
  })) : [];
  const sheets = [quote, ...costs];
  const sheetOverrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n');
  const sheetRels = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('\n');
  const worksheetFiles = Object.fromEntries(sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheet.xml()]));
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheetOverrides}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    'xl/workbook.xml': workbook(sheets),
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRels}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    'xl/styles.xml': STYLES_XML,
    ...worksheetFiles,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>Quotation ${xml(first.values.product)}</dc:title><dc:creator>Quote Workbench</dc:creator><cp:lastModifiedBy>Quote Workbench</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${generatedAt.toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${generatedAt.toISOString()}</dcterms:modified>
</cp:coreProperties>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Quote Workbench</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>
</Properties>`,
  };
  const safe = String(first.values.product || 'Quotation').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40) || 'Quotation';
  return {
    buffer: zip(files, generatedAt),
    filename: `Quotation_${safe}${list.length > 1 ? `_${list.length}items` : ''}_${date.replaceAll('-', '')}.xlsx`,
    quoteNo,
    generatedAt: generatedAt.toISOString(),
    mime: MIME,
  };
}

export { MIME as QUOTATION_MIME, zip as buildZip };
