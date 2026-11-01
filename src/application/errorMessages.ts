import type { RepositoryError } from './ports';
import type { LegacyV3Error, MigrationNotice } from '../infrastructure/persistence/legacyV3';
export function describeError(error: RepositoryError | LegacyV3Error): string {
  switch (error.code) {
    case 'invalid-json': return 'Dosya geçerli JSON değil.';
    case 'unsupported-schema': return `Desteklenmeyen yedek sürümü: ${error.path}.`;
    case 'invalid-data': return `Veri doğrulanamadı: ${error.issues.map(issue => `${issue.path} (${issue.code})`).join('; ')}`;
    case 'serialization': return 'JSON yedeği üretilemedi.';
    case 'storage-conflict': return 'Kayıt başka bir sekmede değişti. Üzerine yazılmadı. Önce bu sekmenin JSON yedeğini indirin; ardından güncel kaydı yüklemeyi seçebilirsiniz.';
    case 'storage-access': return 'Tarayıcı kaydına erişilemiyor. Bellekte çalışabilir ve JSON yedeği indirebilirsiniz.';
    case 'storage-quota': return 'Tarayıcı depolama kotası dolu. JSON yedeği indirin.';
    case 'existing-record-invalid': return `Mevcut tarayıcı kaydı bozuk; üzerine yazılmadı. ${describeError(error.reason)}`;
    case 'legacy-migration': return `v3 aktarımı tamamlanamadı: ${error.issues.map(describeNotice).join('; ')}`;
  }
}
const noticeMessages: Record<string, string> = {
  'legacy-turn-confirmation-required': 'Seçimin eski tur sırası doğrulanamıyor; sahipliği korumak için açık onay gerekiyor',
  'legacy-turn-explicitly-confirmed': 'Sıra dışı seçim sahipliği sizin onayınızla korundu',
  'original-selection-indices-and-consent-unavailable': 'Eski seçim indeksleri ve onayları yedekte yok; mevcut kronolojik sıra kullanıldı',
  'projection-excluded-raw-values-not-retained': 'Geçersiz projeksiyon analiz dışı bırakıldı; ham değerler korunmadı. Orijinal v3 dosyasını saklayın',
  'source-loaded-replaced-by-importedAt': 'Eski yükleme tarihi bilinmiyor; aktarım zamanı kullanıldı',
  'source-mode-not-used': 'Eski kaynak birimi kullanılmadı; oyuncu satırlarının birimi kullanıldı',
  'unknown-position-omitted': 'Bilinmeyen pozisyon aktarılmadı',
  'rank-omitted': 'Geçersiz oyuncu sırası aktarılmadı',
  'unmapped-field': 'Bu alanın yeni modelde karşılığı yok; aktarılmadı',
};
export function describeNotice(notice: MigrationNotice): string {
  return `${notice.path}: ${noticeMessages[notice.code] ?? `Uyumsuz veri (${notice.code})`}`;
}
