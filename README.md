# NBA Fantasy Assistant — Public Core

This public repository implements architecture B: **public code + synthetic fixtures, private production**. The initial 471-file public core has been imported with clean Git history. Production data refresh, frozen research records and the existing GitHub Pages publisher remain in the separate private repository.

- `npm ci --ignore-scripts`
- `pip install -r scripts/requirements-stats.txt`
- `npx --no-install playwright install chromium` (or set `CHROMIUM_PATH`)
- `npm run test:public:all`
- `npm run dev`, then explicitly open `/?demo=synthetic` (fictional league ID `789`).

The synthetic demo exercises Draft, ROS, Power Rankings, Season, Waiver and Trade. A persistent banner identifies fictional values. No real ESPN/NBA observation, league relationship or frozen research record is included; the Actual historical-statistics view is intentionally unavailable. Default public mode does not contact a live provider or silently substitute demo data. User-imported manual Draft files remain local browser data.

See [feature/test scope](docs/public-core/SCOPE.md), [isolation policy](docs/public-core/ISOLATION.md), [one-way transfer design](docs/public-core/SYNCHRONIZATION.md) and [copyright/notice scope](LICENSE-SCOPE.md). Required third-party runtime notices are included in `LICENSES/` and `public/licenses/THIRD_PARTY.txt`. Making this repository public does not grant a new blanket open-source license to original project code.

`npm test` is explicitly the public synthetic profile. `npm run test:full` deliberately reports the separately blocked private/production scopes. The real-data historical, frozen research and production test requirements remain in the private authority; public green is not a claim they passed. Production refresh, Pages publish and rookie shadow record workflows are not active here.

The `Public synthetic core` GitHub Actions workflow runs the public synthetic profile on pull requests and pushes to `main`. It checks type safety, the production build, public JavaScript/Python and Chromium regressions, the source/data boundary and secrets. It requires no private credentials or production publishing permissions and does not run private research, data refresh or deployment jobs.

The reviewed source inventory is `migration/public-files.json`. Source additions or modifications require an intentional manifest review/update; CI verifies it and does not automatically bless its own changes. No private data cache may be imported. Build and test artifacts are generated locally and ignored; only explicitly reviewed source is committed here.
