# Public Core: synthetic code profile

This source tree is prepared under architecture B: public code and independently authored synthetic fixtures; existing private production remains authoritative. No live provider, production deploy, raw dataset, private league/roster relationship or research record is included. This is not a production migration or provider-data license.

Run `npm ci --ignore-scripts`, install Python requirements, then `npm run test:public:all`. For Chromium use `npx --no-install playwright install chromium` (or set CHROMIUM_PATH for an existing Chromium). `npm run dev` serves the app. Explicit demo entry: `/?demo=synthetic`, synthetic league ID **789**. The page banner identifies all demo values as synthetic. The default mode supports local manual Draft data; live provider calls fail without downloading data. Missing demo inputs cause an error, never a real-provider fallback.

| Feature | Public synthetic scope | Private requirement |
|---|---|---|
| Draft | 140-player legacy inputs and 220-player demo projection; setup, picks, undo, persistence, rankings, imports | Real provider actual history and real league integration not claimed |
| ROS | Independent shooting/rank/source/timestamp validation, explicit demo schedule parser | Real model validity, historical fit/replay and provider freshness |
| Power Rankings | Shared 9CAT engine, ten synthetic teams, 90 numeric cells; FG/FT ratio and TO inversion | Frozen real-data equivalence stays private |
| Season | Synthetic connection/rosters, team selection and strategy targets | Actual standings/matchup/provider semantics against real history |
| Waiver | 120 fictional free agents, read-only paging and add/drop what-if | Live ESPN pool, source coverage/freshness and real ownership |
| Trade | Two-way swaps, capacity/ownership safeguards, nine-category effect and undo/reset | Real league transaction eligibility; no ESPN write exists |

The Actual historical statistics screen has no distributed dataset. Demo mode does not relabel generated numbers as real SportsDataverse observations. In the rankings screen select the ROS period. Frozen rookie/returning parameters, protocols, first origin and saved research records are not generated or changed. Historical comparison profiles remain blocked; `npm run test:full` returns a non-success status for private/production validation.

The original data-dependent test sources may remain as source-only references. Their presence is not a claim they run in public CI. The profile `migration/validation-scopes.json` enumerates executed public cases/files; the private audit delivery includes a test-level matrix with failures/requirements. No original assertion, golden or tolerance is changed to make the public suite pass.
