import { ImportError, type RawFile } from '../../application/projectionRows.ts';
import { readCsv, readProjectionJson } from './textReaders.ts';
import { readWorkbook } from './workbook.ts';
export async function readProjectionFile(file: File): Promise<RawFile> {
  if (file.size > 20 * 1024 * 1024) throw new ImportError('Dosya 20 MB sınırını aşıyor.');
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension === 'xlsx') return readWorkbook(new Uint8Array(await file.arrayBuffer()), file.name);
  if (extension === 'csv') return readCsv(await file.text(), file.name);
  if (extension === 'json') return readProjectionJson(await file.text(), file.name);
  throw new ImportError('XLSX, CSV veya JSON dosyası seçin.');
}
export function downloadWorkbook(bytes: Uint8Array, name: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
