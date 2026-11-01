import type { Player } from '../domain/models/player.ts';
import type { PlayerProjection, ProjectionDataset } from '../domain/models/projection.ts';
import type { CalculationModel } from '../engine/model.ts';

const text = (s: string) => s.normalize('NFKC').toLocaleLowerCase('tr-TR');
/** Manual imports reject duplicate normalized names. Extra source fields also
 * disambiguate legacy names without relying on generated application UUIDs. */
export function poolTieKey(player: Player, projection?: PlayerProjection) {
  return JSON.stringify([text(player.name), player.name.normalize('NFC'),
    Object.entries(player.providerIds ?? {}).sort(), projection?.status === 'valid' ?
      [projection.gamesPlayed, ...Object.entries(projection.stats).sort()] : null,
    projection?.presentation?.team ?? '']);
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Derived presentation: never overwrite source ranks or feed ranks into engine math. */
export function rankDraftPool(players: readonly Player[], projections: readonly PlayerProjection[], model: CalculationModel | null, dataset?: ProjectionDataset) {
  const totalZ = new Map([...(model?.z ?? [])].map(([id, z]) => [id, Object.values(z).reduce((a, b) => a + b, 0)]));
  const byId = new Map(projections.map(p => [p.playerId, p]));
  const tieKeys = new Map(players.map(p => [p.id, poolTieKey(p, byId.get(p.id))]));
  const supplied = projections.filter(p => p.rank !== undefined);
  const invalid = dataset?.rankInputIssue === 'invalid' || supplied.some(p => !Number.isSafeInteger(p.rank) || p.rank! <= 0);
  const duplicate = new Set(supplied.map(p => p.rank)).size !== supplied.length;
  const issue = invalid ? 'invalid' : duplicate ? 'duplicate' : supplied.length && supplied.length !== projections.length ? 'partial' : 'missing';
  // API adapters omit ranks on excluded rows. Preserve published gaps only
  // when every analyzable player has a usable source rank; API alone is no proof.
  const api = dataset?.source.kind === 'api';
  const required = api ? projections.filter(p => p.status === 'valid') : projections;
  const usableSource = supplied.length > 0 && !invalid && !duplicate && required.every(p => p.rank !== undefined);
  const source: 'provided' | 'automatic' = usableSource ? 'provided' : 'automatic';
  const ranks = source === 'provided' ? new Map(supplied.map(p => [p.playerId, p.rank!])) : new Map(
    [...totalZ].filter(([,z]) => Number.isFinite(z)).sort(([a,az],[b,bz]) => bz - az || compare(tieKeys.get(a) ?? '', tieKeys.get(b) ?? '')).map(([id],i) => [id,i+1]));
  const sourceLabel = api ? `${dataset.source.name} · ` : '';
  const notice = sourceLabel + (source === 'provided' ? (api ? 'RANK: yayımlanmış kaynak sıralama; boşluklar korunur.' : 'RANK: dosyadaki kaynak sıralama.') :
    `${issue === 'missing' ? 'Kaynak RANK yok.' : issue === 'invalid' ? 'Kaynak RANK geçersiz.' : issue === 'duplicate' ? 'Kaynak RANK mükerrer.' : 'Kaynak RANK kısmi.'} RANK: mevcut 9CAT TOTAL Z modelinden otomatik üretilir. Kaynak değerleri değiştirilmez.`);
  return { source, issue: source === 'automatic' ? issue : null, ranks, totalZ, tieKeys, notice };
}
