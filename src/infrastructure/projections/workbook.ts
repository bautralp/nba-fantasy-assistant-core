import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { WorkspaceSnapshot } from '../../domain/models/workspace.ts';
import { HEADERS, ImportError, canonical, exactNumericIdSource, type RawFile } from '../../application/projectionRows.ts';
import { PROJECTION_STATS } from '../../domain/models/projection.ts';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: false, processEntities: false, isArray: name => ['sheet', 'Relationship', 'si', 'row', 'c', 't'].includes(name) });
type Xml = Record<string, any>; // XML adapter boundary; domain input is validated independently.
function xml(bytes: Uint8Array | undefined): Xml {
  if (!bytes) throw new ImportError('XLSX içinde gerekli XML parçası eksik.');
  const text = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new ImportError('Geçersiz veya desteklenmeyen XLSX XML.');
  return parser.parse(text) as Xml;
}
// DTD expansion is disabled. Decode XML literals and numeric character references only.
const decode = (value: string): string => value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, entity => {
  const literal = ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" } as Record<string, string>)[entity];
  if (literal !== undefined) return literal;
  const point = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
  if (!Number.isInteger(point) || point < 1 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new ImportError('Geçersiz XML karakteri.');
  return String.fromCodePoint(point);
});
const texts = (v: any): string => v === undefined ? '' : Array.isArray(v) ? v.map(texts).join('') : typeof v === 'object' ? texts(v.t ?? v.r ?? v['#text']) : decode(String(v));
function column(ref: string): number {
  const match = /^([A-Z]+)[1-9]\d*$/.exec(ref); if (!match) throw new ImportError('Geçersiz XLSX hücre adresi.');
  let n = 0; for (const c of match[1]) n = n * 26 + c.charCodeAt(0) - 64;
  if (n > 256) throw new ImportError('XLSX sütun sınırı aşıldı.'); return n - 1;
}
export function readWorkbook(bytes: Uint8Array, name: string): RawFile {
  if (bytes.byteLength > MAX_BYTES) throw new ImportError('Dosya 20 MB sınırını aşıyor.');
  try {
    let total = 0;
    const files = unzipSync(bytes, { filter: entry => {
      total += entry.originalSize;
      if (total > MAX_EXPANDED || entry.originalSize > MAX_BYTES) throw new ImportError('Açılmış XLSX boyut sınırı aşıldı.');
      return /^(?:\[Content_Types\]\.xml|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml))$/.test(entry.name);
    } });
    const workbook = xml(files['xl/workbook.xml']); const rels = xml(files['xl/_rels/workbook.xml.rels']).Relationships.Relationship as Xml[];
    const strings = files['xl/sharedStrings.xml'] ? (xml(files['xl/sharedStrings.xml']).sst.si ?? []).map((v: Xml) => texts(v)) : [];
    const sheets: Xml[] = workbook.workbook.sheets.sheet;
    if (!Array.isArray(sheets) || new Set(sheets.map(s => s['@name'])).size !== sheets.length) throw new ImportError('Çelişkili çalışma sayfaları.');
    for (const required of ['Players', 'Settings', 'Instructions']) if (!sheets.some(s => s['@name'] === required)) throw new ImportError(`Eksik zorunlu sayfa: ${required}`);
    const readSheet = (sheetName: string): unknown[][] => {
      const sheet = sheets.find(s => s['@name'] === sheetName)!;
      const matching = rels.filter(r => r['@Id'] === sheet['@r:id']);
      if (matching.length !== 1 || matching[0]['@TargetMode'] === 'External') throw new ImportError('Geçersiz XLSX sayfa ilişkisi.');
      const target = String(matching[0]['@Target']);
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) throw new ImportError('Desteklenmeyen XLSX sayfa yolu.');
      const rows: unknown[][] = []; const numericSources = new Map<string, string>(); const usedRows = new Set<number>();
      for (const row of xml(files[path]).worksheet.sheetData?.row ?? []) {
        const r = Number(row['@r']);
        if (!Number.isInteger(r) || r < 1 || r > 50000 || usedRows.has(r)) throw new ImportError('Geçersiz/çok büyük XLSX satır adresi.');
        usedRows.add(r); const cells: unknown[] = []; const seen = new Set<number>();
        for (const cell of row.c ?? []) {
          const ref = String(cell['@r']); const c = column(ref);
          if (Number(ref.replace(/^[A-Z]+/, '')) !== r || seen.has(c)) throw new ImportError('Çelişkili XLSX hücre adresi.'); seen.add(c);
          if (cell.f === undefined && (!cell['@t'] || cell['@t'] === 'n') && cell.v !== undefined) numericSources.set(ref, String(cell.v));
          // Formula caches are deliberately ignored. The marker fails numeric validation.
          cells[c] = cell.f !== undefined ? { formula: true } : cell['@t'] === 's' ? strings[Number(cell.v)]
            : cell['@t'] === 'inlineStr' ? texts(cell.is) : cell['@t'] === 'str' ? texts(cell.v)
            : cell['@t'] && cell['@t'] !== 'n' ? { unsupportedCell: true }
            : cell.v === undefined || typeof cell.v === 'string' && !cell.v.trim() ? null : Number(cell.v);
        }
        rows[r - 1] = cells;
      }
      const identityColumn = rows[0]?.findIndex(v => typeof v === 'string' && canonical(v) === 'PLAYER_ID') ?? -1;
      if (sheetName === 'Players' && identityColumn >= 0) rows.forEach((cells, i) => {
        const source = numericSources.get(`${letters(identityColumn)}${i + 1}`);
        const value = cells[identityColumn];
        if (source !== undefined && typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && !exactNumericIdSource(source)) cells[identityColumn] = { unsafeIdentity: true };
      });
      return Array.from({ length: rows.length }, (_, i) => rows[i] ?? []);
    };
    readSheet('Instructions');
    const settings = readSheet('Settings'); const metadata: Record<string, unknown> = Object.create(null);
    for (const row of settings) {
      if (!row.length) continue;
      const key = String(row[0]); if (Object.hasOwn(metadata, key)) throw new ImportError('Mükerrer Settings anahtarı.'); metadata[key] = row[1];
    }
    if (!Object.hasOwn(metadata, 'schemaVersion') || !metadata.season || !metadata.unit) throw new ImportError('Settings: schemaVersion, season ve unit gerekli.');
    const rows = readSheet('Players');
    return { name, format: 'xlsx', headers: (rows.shift() ?? []).map(v => typeof v === 'string' ? v : ''), rows, schemaVersion: metadata.schemaVersion, season: metadata.season, unit: metadata.unit };
  } catch (error) { if (error instanceof ImportError) throw error; throw new ImportError('Bozuk veya desteklenmeyen XLSX dosyası.'); }
}
const escape = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const letters = (n: number): string => n < 26 ? String.fromCharCode(65 + n) : letters(Math.floor(n / 26) - 1) + letters(n % 26);
const sheetXml = (rows: readonly (readonly unknown[])[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" style="1" width="24" customWidth="1"/></cols><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((v, j) => v === undefined || v === null ? '' : `<c r="${letters(j)}${i + 1}"${typeof v === 'number' ? '' : ' t="inlineStr"'}>${typeof v === 'number' ? `<v>${v}</v>` : `<is><t xml:space="preserve">${escape(v)}</t></is>`}</c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
const instructions = [
  ['Alan', 'Açıklama'], ['PLAYER', 'Oyuncu adı zorunludur. Mükerrer adları dosyada düzeltin. Kimlikler çalışma içinde otomatik oluşturulur.'],
  ['POS', 'İsteğe bağlı: PG, SG, SF, PF, C, G, F; virgül veya / ile ayırın. G, PG/SG; F, SF/PF uygunluğu vermez.'],
  ['RANK', 'İsteğe bağlı pozitif tam sayı. Geçersiz değer uyarıdır.'], ['GP', 'Zorunlu, pozitif sonlu sayı; ondalık olabilir.'],
  ...PROJECTION_STATS.map(k => [k, `Zorunlu, negatif olmayan sonlu sayı. ${k === 'FGM' ? 'FGM ≤ FGA.' : k === 'FTM' ? 'FTM ≤ FTA.' : ''}`]),
  ['Birim', 'Dosyada tek unit: perGame (GP ile çarpılır) veya totals (sezon toplamı). Sezon lig sezonuna eşit olmalı.'],
  ['Sayı biçimi', 'Sayısal hücre veya noktalı ondalık metin kullanın. Boş hücre sıfır değildir. Binlik ayırıcı, virgüllü ondalık, negatif, NaN, Infinity kabul edilmez.'],
  ['Formül', 'Formüller hesaplanmaz. İstatistik hücresinde formül varsa projeksiyon excluded olur. FG%/FT% girmeyin; isabet/deneme değerlerinden hesaplanır.'],
  ['Çalışma', 'Draft ekranına girildiğinde havuz kilitlenir. Farklı dosya için yeni çalışma başlatın.'],
];
export function createWorkbook(season: string, unit: 'perGame' | 'totals', playerRows: readonly (readonly unknown[])[] = [], headers: readonly string[] = HEADERS.filter(h => h !== 'PLAYER_ID')): Uint8Array {
  const names = ['Players', 'Settings', 'Instructions'];
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  files['_rels/.rels'] = strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files['xl/styles.xml'] = strToU8('<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>');
  files['xl/workbook.xml'] = strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  [[headers, ...playerRows], [['schemaVersion', 1], ['season', season], ['unit', unit]], instructions].forEach((rows, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(rows)); });
  return zipSync(files, { level: 6 });
}
export function exportPlayerPool(workspace: WorkspaceSnapshot): Uint8Array {
  const dataset = workspace.datasets.find(d => d.id === workspace.league.activeDatasetId);
  if (!dataset) throw new ImportError('Dışa aktarılacak aktif veri seti yok.');
  const projections = workspace.projections.filter(p => p.datasetId === dataset.id);
  const picked = new Set((workspace.draftSession?.picks ?? workspace.rosterEntries).map(p => p.playerId));
  const active = new Set(projections.map(p => p.playerId));
  return createWorkbook(dataset.season, dataset.unit, workspace.players.filter(p => active.has(p.id) || picked.has(p.id)).map(p => {
    const projection = projections.find(v => v.playerId === p.id);
    const positions = workspace.eligibility.find(e => e.playerId === p.id && e.scope.kind === 'dataset' && e.scope.datasetId === dataset.id)?.positions ?? [];
    return [p.id, p.name, positions.join(','), projection?.rank, projection?.status === 'valid' ? projection.gamesPlayed : undefined, ...PROJECTION_STATS.map(k => projection?.status === 'valid' ? projection.stats[k] : undefined)];
  }), HEADERS);
}
