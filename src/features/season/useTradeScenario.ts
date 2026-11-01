import { useCallback, useState } from 'react';
import { emptyScenario, type TradeMove, type TradeScenario } from '../../seasonAnalysis/trade.ts';

/** Scenario moves (IDs only) live in sessionStorage per league/season/team; real rosters
 * are never copied. Invalid stored data starts an empty scenario. */
export const tradeScenarioKey = (leagueId: number, seasonId: number, teamId: number) => `nba-fantasy-assistant.season-trade.v1:${leagueId}:${seasonId}:${teamId}`;
const isMove = (m: unknown): m is TradeMove => !!m && typeof m === 'object' && Number.isSafeInteger((m as TradeMove).playerId) && (m as TradeMove).playerId > 0
  && Number.isSafeInteger((m as TradeMove).sourceTeamId) && ((m as TradeMove).target === 'waiver' || Number.isSafeInteger((m as TradeMove).target));
export function parseScenario(raw: string | null): TradeScenario {
  try {
    const v = raw === null ? null : JSON.parse(raw);
    if (!v || v.schemaVersion !== 1 || !Array.isArray(v.moves) || !v.moves.every(isMove) || new Set(v.moves.map((m: TradeMove) => m.playerId)).size !== v.moves.length || !Array.isArray(v.history) || !v.history.every((h: unknown) => Array.isArray(h) && h.every(isMove))) return emptyScenario();
    return { schemaVersion: 1, moves: v.moves, history: v.history.slice(-50) };
  } catch { return emptyScenario(); }
}
export function useTradeScenario(leagueId: number, seasonId: number, teamId: number) {
  const key = tradeScenarioKey(leagueId, seasonId, teamId);
  const [state, setState] = useState(() => { try { return { key, scenario: parseScenario(sessionStorage.getItem(key)) }; } catch { return { key, scenario: emptyScenario() }; } });
  const scenario = state.key === key ? state.scenario : emptyScenario();
  const save = useCallback((next: TradeScenario) => {
    setState({ key, scenario: next });
    try { sessionStorage.setItem(key, JSON.stringify({ ...next, history: next.history.slice(-50) })); } catch { /* scenario stays in memory for this view */ }
  }, [key]);
  return { scenario, save };
}
