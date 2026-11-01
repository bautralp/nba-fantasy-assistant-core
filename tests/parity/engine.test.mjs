import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  calculateModel,
  projectTotals,
  teamScores,
  rankTeams,
  categoryBalance,
  opponentAnalysis,
  recommendations,
  matchLineup,
  eligible,
  positionFit,
  categoryValues,
} from "../../src/engine/index.ts";
import { INITIAL_LEAGUE_RULES } from "../../src/domain/rules/leagueRules.ts";
const read = async (path) =>
  JSON.parse(
    await readFile(new URL(`../fixtures/${path}`, import.meta.url), "utf8"),
  );
const scenarios = await read("scenarios.json"),
  references = await read("reference-ids.json");

function compare(actual, expected, path = "$") {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", path);
    if (
      /\.(ranks|tieRanks)\.|\.(br|ar|rank|teamIndex|count|rated|referenceCount|selected|remaining|filled|unknown|total)$/.test(
        path,
      )
    )
      assert.equal(actual, expected, path);
    else
      assert.ok(
        Number.isFinite(actual) &&
          Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
        `${path}: ${actual} != ${expected}`,
      );
  } else if (expected && typeof expected === "object") {
    assert.equal(Array.isArray(actual), Array.isArray(expected), path);
    assert.deepEqual(
      Object.keys(actual),
      Object.keys(expected),
      `${path} keys/order`,
    );
    for (const key of Object.keys(expected))
      compare(actual[key], expected[key], `${path}.${key}`);
  } else assert.equal(actual, expected, path);
}
const statMap = {
  FGM: "fgm",
  FGA: "fga",
  FTM: "ftm",
  FTA: "fta",
  "3PM": "three",
  PTS: "pts",
  REB: "reb",
  AST: "ast",
  STL: "stl",
  BLK: "blk",
  TO: "to",
};
// Frozen fromObjects outputs are boundary inputs, not a second importer. No
// totals, scores, weights, reference selection or matching live in this adapter.
function adapt(scenario, oracle) {
  const records = oracle.imported.records;
  const dataset = {
    id: "dataset",
    schemaVersion: 1,
    season: "fixture",
    source: { name: "fixed", kind: "json" },
    importedAt: "2026-10-20T00:00:00Z",
    unit: scenario.mode,
  };
  const players = records.map((p) => ({ id: p.id, name: p.name }));
  const projections = records.map((p) => ({
    playerId: p.id,
    datasetId: dataset.id,
    ...(p.rank === null ? {} : { rank: p.rank }),
    ...(p.valid
      ? {
          status: "valid",
          gamesPlayed: p.values.gp,
          stats: Object.fromEntries(
            Object.entries(statMap).map(([k, v]) => [k, p.values[v]]),
          ),
        }
      : { status: "excluded", reasons: ["legacy invalid projection"] }),
  }));
  // Action scenarios use their fixed post-command state, so calculation parity
  // does not duplicate the draft command or confirmation implementations.
  const saved = oracle.checkpoints.at(-1);
  const teamNames =
    saved?.teams ?? Array.from({ length: 10 }, (_, i) => `Team ${i}`);
  const teams = teamNames.map((name, i) => ({
    id: `team-${i}`,
    leagueId: "league",
    name,
  }));
  const teamId = teams[saved?.myTeam ?? scenario.myTeam].id;
  const roster = oracle.picks.map((p) => ({
    playerId: p.id,
    teamId: teams[p.team].id,
  }));
  const eligibility = records.map((p) => ({
    playerId: p.id,
    positions: p.pos
      .toUpperCase()
      .split(/[^A-Z]+/)
      .filter(Boolean),
  }));
  return {
    dataset,
    players,
    projections,
    teams,
    teamId,
    roster,
    eligibility,
    targets: scenario.targets,
  };
}
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
const outputs = new Map();
for (const scenario of scenarios)
  test(`v3.3 parity: ${scenario.name}`, async () => {
    const expected = await read(`expected/${scenario.name}.json`),
      input = deepFreeze(adapt(scenario, expected));
    const {
      dataset,
      players,
      projections,
      teams,
      teamId,
      roster,
      eligibility,
      targets,
    } = input;
    const model = calculateModel(players, projections, dataset);
    const scores = teamScores(teams, roster, model),
      ranks = rankTeams(scores);
    const legacyRanks = (r) =>
      Object.fromEntries(
        Object.entries(r).map(([c, values]) => [
          c,
          Object.fromEntries(teams.map((t, i) => [i, values[t.id]])),
        ]),
      );
    const mine = roster
      .filter((p) => p.teamId === teamId)
      .map((p) => eligibility.find((e) => e.playerId === p.playerId))
      .filter(Boolean);
    const totals = players.map((p) => {
      const s = projectTotals(
        projections.find((x) => x.playerId === p.id),
        dataset,
      );
      return {
        id: p.id,
        totals: s
          ? {
              gp: s.gamesPlayed,
              ...Object.fromEntries(
                Object.entries(statMap).map(([k, v]) => [v, s.stats[k]]),
              ),
            }
          : null,
      };
    });
    const { referenceIds, ...rest } = model;
    const actual = {
      totals,
      model: {
        ...rest,
        valid: model.valid.map((p) => p.playerId),
        z: Object.fromEntries(model.z),
      },
      scores: scores.map(({ teamId, ...t }, i) => ({
        name: t.name,
        i,
        count: t.count,
        rated: t.rated,
        sum: t.sum,
        score: t.score,
      })),
      ranks: legacyRanks(ranks),
      balance: categoryBalance(scores, teamId, targets),
      threats: opponentAnalysis(scores, teamId, targets).map(
        ({ teamId, ...t }) => ({
          cat: t.cat,
          team: t.team,
          teamIndex: teams.findIndex((x) => x.id === teamId),
          gap: t.gap,
          ahead: t.ahead,
          level: t.level,
          rated: t.rated,
          confidence: t.confidence,
        }),
      ),
      suggestions: recommendations({ ...input, model }).map(
        ({ playerId, ...r }) => ({ p: playerId, ...r }),
      ),
      lineups: teams.map((t) =>
        matchLineup(
          roster
            .filter((p) => p.teamId === t.id)
            .map((p) => eligibility.find((e) => e.playerId === p.playerId))
            .filter(Boolean),
        ),
      ),
      eligibility: eligibility.map((e) => ({
        id: e.playerId,
        slots: INITIAL_LEAGUE_RULES.rosterSlots.map((s) => eligible(e, s)),
        fit: positionFit(mine, e),
      })),
    };
    // Model keys differ only by the explicit referenceIds diagnostic field.
    for (const key of Object.keys(actual)) {
      // Object field order has no business meaning; array order remains exact.
      compare(canonical(actual[key]), canonical(expected[key]), `$.${key}`);
    }
    if (references[scenario.name])
      assert.deepEqual(referenceIds, references[scenario.name]);
    const tieScores = [0, 5e-11, 2e-10].map((v, i) => ({
      teamId: String(i),
      score: categoryValues(() => v),
    }));
    compare(rankTeams(tieScores), expected.tieRanks, "$.tieRanks");
    outputs.set(scenario.name, actual);
  });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
test("per-game and totals are equivalent through the new engine", () => {
  for (const key of [
    "totals",
    "model",
    "scores",
    "ranks",
    "balance",
    "suggestions",
    "threats",
    "lineups",
  ])
    compare(
      canonical(outputs.get("early")[key]),
      canonical(outputs.get("equivalent-totals")[key]),
      `$.${key}`,
    );
});
test("legacy G/F tokens do not grant specific positions", () => {
  const g = { playerId: "g", positions: ["G"] },
    f = { playerId: "f", positions: ["F"] };
  assert.equal(eligible(g, "PG"), false);
  assert.equal(eligible(g, "SG"), false);
  assert.equal(eligible(g, "G"), true);
  assert.equal(eligible(f, "SF"), false);
  assert.equal(eligible(f, "PF"), false);
  assert.equal(eligible(f, "F"), true);
});

test("dataset isolation, missing and excluded projections retain identity without entering analysis", async () => {
  const scenario = scenarios.find((s) => s.name === "early");
  const input = adapt(scenario, await read("expected/early.json"));
  const baseline = calculateModel(
    input.players,
    input.projections,
    input.dataset,
  );
  const foreign = input.projections.map((p) => ({
    ...p,
    datasetId: "foreign",
    gamesPlayed: 1,
  }));
  compare(
    canonical(
      calculateModel(
        input.players,
        [...input.projections, ...foreign],
        input.dataset,
      ),
    ),
    canonical(baseline),
  );
  assert.equal(projectTotals(foreign[0], input.dataset), null);
  const reduced = input.projections
    .filter((p) => p.playerId !== input.players[0].id)
    .map((p, i) =>
      i === 0
        ? {
            playerId: p.playerId,
            datasetId: p.datasetId,
            status: "excluded",
            reasons: ["invalid"],
          }
        : p,
    );
  const result = calculateModel(input.players, reduced, input.dataset);
  assert.equal(result.z.has(input.players[0].id), false);
  assert.equal(result.z.has(input.projections[1].playerId), false);
  assert.equal(result.valid.length, baseline.valid.length - 2);
});

test("stable IDs survive renamed entities and team reordering; repeated calls leave the model intact", async () => {
  const scenario = scenarios.find((s) => s.name === "middle");
  const input = deepFreeze(adapt(scenario, await read("expected/middle.json")));
  const model = calculateModel(input.players, input.projections, input.dataset);
  const before = JSON.stringify([...model.z]);
  const first = recommendations({ ...input, model });
  assert.deepEqual(recommendations({ ...input, model }), first);
  assert.equal(JSON.stringify([...model.z]), before);
  const renamed = input.players.map((p) => ({
    ...p,
    name: "Same display name",
  }));
  const otherModel = calculateModel(renamed, input.projections, input.dataset);
  assert.deepEqual([...otherModel.z], [...model.z]);
  const original = rankTeams(teamScores(input.teams, input.roster, model));
  const reordered = rankTeams(
    teamScores([...input.teams].reverse(), input.roster, model),
  );
  compare(canonical(reordered), canonical(original), "$.ranks");
});
