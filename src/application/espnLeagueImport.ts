import type { PublicLeague } from '../features/season/model.ts';
import { NINE_CATEGORIES } from '../domain/models/categories.ts';
import { INITIAL_LEAGUE_RULES } from '../domain/rules/leagueRules.ts';
import type { LeagueSettings } from './leagueSetup.ts';

/** ESPN seasons are keyed by their ending year: 2026-27 → 2027. */
export const ESPN_DRAFT_SEASON = { label: '2026-27', espnSeasonId: 2027 } as const;
const IR_SLOT = 13;
const CATEGORY_SCORING = ['H2H_CATEGORY', 'H2H_MOST_CATEGORIES', 'H2H_EACH_CATEGORY'];
/** The Draft engine's fixed lineup: PG, SG, SF, PF, C, G, F, 3 UTIL, 3 bench (ESPN slot IDs). */
const ENGINE_SLOTS: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 11: 3, 12: 3 };

export type DraftSupport =
  | { readonly ok: true; readonly name: string; readonly teams: readonly { readonly espnTeamId: number; readonly name: string }[]; readonly draftOrder: readonly number[] | null; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** Only 10 teams × 13 roster spots × the nine standard categories map onto the Draft engine today. */
export function checkDraftSupport(league: PublicLeague): DraftSupport {
  const reasons: string[] = [], notes: string[] = [];
  const teamCount = league.teams.length;
  if (teamCount !== INITIAL_LEAGUE_RULES.teamCount) reasons.push(`Ligin ${teamCount} takımlı. Şimdilik yalnız ${INITIAL_LEAGUE_RULES.teamCount} takımlı ligler otomatik aktarılabiliyor.`);
  const rosterSize = league.rosterSlots.filter(s => s.slotId !== IR_SLOT).reduce((sum, s) => sum + s.count, 0);
  if (rosterSize !== INITIAL_LEAGUE_RULES.rosterSize) reasons.push(`Ligde takım başına ${rosterSize} oyuncu var (IR hariç). Şimdilik yalnız ${INITIAL_LEAGUE_RULES.rosterSize} oyunculu kadrolar destekleniyor.`);
  const type = league.scoring.type;
  if (/POINTS/.test(type)) reasons.push('Lig puan (points) sistemiyle oynanıyor. Şimdilik yalnız 9 kategorili (9CAT) ligler destekleniyor.');
  else if (type === 'ROTO') reasons.push('Lig Roto sistemiyle oynanıyor. Şimdilik yalnız Head-to-Head kategori ligleri destekleniyor.');
  else if (!CATEGORY_SCORING.includes(type)) reasons.push(`Ligin skor sistemi tanınmadı (${type}). Şimdilik yalnız 9 kategorili (9CAT) ligler destekleniyor.`);
  else {
    const labels = league.scoring.categories.map(c => c.label);
    const missing = NINE_CATEGORIES.filter(c => !labels.includes(c));
    const extra = labels.filter(l => !(NINE_CATEGORIES as readonly string[]).includes(l));
    if (missing.length || extra.length || labels.length !== NINE_CATEGORIES.length) {
      const parts = [`Ligde ${labels.length} kategori var`, missing.length ? `eksik: ${missing.join(', ')}` : '', extra.length ? `farklı: ${extra.join(', ')}` : ''].filter(Boolean);
      reasons.push(`${parts.join('; ')}. Şimdilik yalnız standart 9 kategori (${NINE_CATEGORIES.join(', ')}) destekleniyor.`);
    }
  }
  const names = league.teams.map(t => t.name.trim());
  if (new Set(names.map(n => n.normalize('NFKC').toLocaleLowerCase('tr-TR'))).size !== names.length) notes.push('Bazı ESPN takım adları aynı. Lig oluşturmadan önce adları birbirinden ayır.');
  const slots = Object.fromEntries(league.rosterSlots.filter(s => s.count > 0 && s.slotId !== IR_SLOT).map(s => [s.slotId, s.count]));
  const sameSlots = Object.keys({ ...slots, ...ENGINE_SLOTS }).every(id => slots[Number(id)] === ENGINE_SLOTS[Number(id)]);
  if (!reasons.length && !sameSlots) notes.push('ESPN ligindeki kadro slotları Draft Asistanı’nın kullandığı düzenden (PG, SG, SF, PF, C, G, F, 3 UTIL, 3 yedek) farklı. Draft hesapları bu sabit düzenle yapılır.');
  if (reasons.length) return { ok: false, reasons };
  const draftOrder = league.draftSettings?.pickOrder ?? null;
  if (!draftOrder) notes.push('ESPN’de draft sırası henüz belirlenmemiş veya okunamadı. Takımlar ESPN takım numarasına göre sıralandı; sırayı kendin düzenle.');
  if (league.draftSettings?.type && league.draftSettings.type !== 'SNAKE') notes.push(`ESPN ligi ${league.draftSettings.type === 'AUCTION' ? 'açık artırma (auction)' : league.draftSettings.type} draftı kullanıyor. Draft Asistanı snake draft olarak çalışır.`);
  return { ok: true, name: league.name, teams: [...league.teams].sort((a, b) => a.espnTeamId - b.espnTeamId).map(t => ({ espnTeamId: t.espnTeamId, name: t.name.trim() })), draftOrder, notes };
}

/** Fills the blank form only; the user still picks their own team and draft order. Nothing is saved here. */
export function settingsFromEspn(support: Extract<DraftSupport, { ok: true }>, blank: LeagueSettings): LeagueSettings {
  if (blank.teams.length !== support.teams.length) throw new Error('Takım sayısı uyuşmuyor.');
  const teams = blank.teams.map((team, index) => ({ ...team, name: support.teams[index].name }));
  // Local team IDs stay UUIDs; ESPN team IDs only decide the first-round order.
  const local = new Map(support.teams.map((t, index) => [t.espnTeamId, teams[index].id]));
  const draftOrder = support.draftOrder?.map(id => local.get(id)!) ?? teams.map(t => t.id);
  return { ...blank, name: support.name, season: ESPN_DRAFT_SEASON.label, teams, userTeamId: '', draftOrder };
}

/** User-facing reasons by the ESPN client's error code. Unknown codes get a generic message. */
export function espnImportError(code: string | undefined): string | null {
  switch (code) {
    case 'aborted': return null;
    case 'input': return 'Lig ID’si geçersiz. ESPN lig ID’si yalnız rakamlardan oluşur (örneğin 12345678); lig sayfasının bağlantısını da yapıştırabilirsin.';
    case 'not-found': return 'Bu ID ile 2026-27 sezonunda bir ESPN ligi bulunamadı. ID’yi kontrol et.';
    case 'private': return 'Bu lig gizli (private). Otomatik aktarım için ligin ESPN ayarlarında herkese açık (public) olması gerekiyor.';
    case 'rate-limit': return 'ESPN kısa sürede çok fazla istek aldı. Biraz bekleyip tekrar dene.';
    case 'timeout': return 'ESPN zamanında yanıt vermedi. Biraz sonra tekrar dene.';
    case 'network': return 'ESPN’e ulaşılamadı. İnternet bağlantını kontrol edip tekrar dene.';
    default: return 'ESPN’den gelen lig bilgisi okunamadı. Biraz sonra tekrar deneyebilirsin.';
  }
}
