import { ImportError, canonical, exactNumericIdSource, type RawFile } from '../../application/projectionRows.ts';
import { isRecord } from '../persistence/workspaceJson.ts';

export function readCsv(text: string, name: string): RawFile {
  text = text.replace(/^\uFEFF/, '');
  const head = text.split(/\r?\n/).find(s => s.trim()) ?? '';
  const counts = [',', ';', '\t'].map(sep => ({ sep, count: head.split(sep).length - 1 })).sort((a, b) => b.count - a.count);
  if (!counts[0].count || counts[0].count === counts[1].count) throw new ImportError('CSV ayıracı belirsiz.');
  const sep = counts[0].sep; const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else value += ch; }
    else if (ch === sep || ch === '\n' || ch === '\r') {
      row.push(value); value = ''; closed = false;
      if (ch !== sep) { if (ch === '\r' && text[i + 1] === '\n') i++; if (row.some(v => v.trim())) rows.push(row); row = []; }
    } else if (ch === '"' && !value && !closed) quoted = true;
    else { if (closed || ch === '"') throw new ImportError('Bozuk CSV tırnak yapısı.'); value += ch; }
  }
  if (quoted) throw new ImportError('CSV içinde kapatılmamış tırnak.');
  row.push(value); if (row.some(v => v.trim())) rows.push(row);
  const headers = rows.shift() ?? [];
  if (rows.some(r => r.length !== headers.length)) throw new ImportError('CSV satır/sütun sayısı uyuşmuyor.');
  return { name, format: 'csv', headers, rows };
}
export function readProjectionJson(text: string, name: string): RawFile {
  let json: unknown; try { json = JSON.parse(text); } catch { throw new ImportError('Bozuk JSON dosyası.'); }
  json = rejectDuplicateJsonKeys(text);
  if (isRecord(json) && ['league', 'teams', 'picks', 'draftSession', 'targets', 'teamNames'].some(k => k in json)) throw new ImportError('Bu dosya oyuncu projeksiyonu değil; JSON yedekleme akışını kullanın.');
  const items = Array.isArray(json) ? json : isRecord(json) ? json.players ?? json.data : undefined;
  if (!Array.isArray(items) || !items.length || !items.every(isRecord)) throw new ImportError('JSON içinde oyuncu nesneleri dizisi gerekli.');
  const headers = [...new Set(items.flatMap(item => Object.keys(item)))];
  return { name, format: 'json', headers, rows: items.map(item => headers.map(k => item[k])),
    ...(isRecord(json) ? { season: json.season, unit: json.unit, schemaVersion: json.schemaVersion } : {}) };
}

/** JSON.parse accepts duplicate keys silently; projection identity must never depend on last-key-wins. */
function rejectDuplicateJsonKeys(text: string): unknown {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  let index = 0;
  const visit = (depth: number, identity = false): unknown => {
    if (depth > 100) throw new ImportError('JSON iç içe yapı sınırı aşıldı.');
    const token = tokens[index++];
    if (token === '{') {
      const keys = new Set<string>(); const result: Record<string, unknown> = Object.create(null);
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++]) as string;
        if (keys.has(key)) throw new ImportError(`JSON içinde mükerrer alan: ${key}`);
        keys.add(key); index++; result[key] = visit(depth + 1, canonical(key) === 'PLAYER_ID');
        if (tokens[index] === ',') index++; else break;
      }
      index++; return result;
    } else if (token === '[') {
      const result: unknown[] = [];
      while (tokens[index] !== ']') { result.push(visit(depth + 1)); if (tokens[index] === ',') index++; else break; }
      index++; return result;
    }
    const value: unknown = JSON.parse(token);
    return identity && typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && !exactNumericIdSource(token) ? { unsafeIdentity: true } : value;
  };
  return visit(0);
}
