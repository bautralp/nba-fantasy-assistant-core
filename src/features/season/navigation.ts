export type SeasonScreen = 'teams' | 'menu' | 'weekly' | 'schedule' | 'rosters' | 'standings' | 'power' | 'analysis' | 'waiver' | 'trade';
/** Screens computed from the shared ROS pipeline; entering one refreshes an expired ESPN cache. */
export const ANALYSIS_SCREENS: readonly SeasonScreen[] = ['power', 'analysis', 'waiver', 'trade'];
export const seasonModules = [
  { screen: 'weekly', title: 'Haftalık Eşleşmeler', icon: '⇄' },
  { screen: 'schedule', title: 'Fikstür', icon: '▦' },
  { screen: 'rosters', title: 'Kadrolar', icon: '♟' },
  { screen: 'standings', title: 'Standings', icon: '≡' },
  { screen: 'power', title: 'Power Rankings', icon: '↗' },
  { screen: 'analysis', title: 'Takım Analizi', icon: '◎' },
  { screen: 'waiver', title: 'Waiver Asistanı', icon: '+' },
  { screen: 'trade', title: 'Takas Asistanı', icon: '⇆' },
] as const;
export const preferenceKey = 'nba-fantasy-assistant.espn-preferences.v1';
export const teamPreferenceKey = (leagueId: number, seasonId: number) => `nba-fantasy-assistant.espn-team.v1:${leagueId}:${seasonId}`;
export function readPreferences(): { input: string; season: number } {
  try { const p = JSON.parse(sessionStorage.getItem(preferenceKey) ?? '{}'); return { input: typeof p.input === 'string' && /^\d+$/.test(p.input) ? p.input : '', season: Number.isInteger(p.season) && p.season >= 2018 && p.season <= 2100 ? p.season : 2027 }; }
  catch { return { input: '', season: 2027 }; }
}
