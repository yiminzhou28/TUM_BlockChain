import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUnits } from 'viem';
import {
  arrivalDelay,
  connectionThreshold,
  datesIn,
  exposureProblem,
  MIN_POPULATION,
  MIN_PREMIUM,
  populationPrior,
  priceFromHistory,
  shiftDate,
  UNIFORM_PRIOR,
} from './pricing.ts';

const aUSD = (amount: string) => parseUnits(amount, 6);
const flight = (status: string, arrival: object) => JSON.stringify([{ status, arrival }]);

test('the uniform prior gives (k + 1) / (n + 2)', () => {
  const { n, k, probability } = priceFromHistory([0, 3, 40, 12, 0], 15, aUSD('1'));
  assert.equal(n, 5);
  assert.equal(k, 1);
  assert.equal(probability, 2 / 7);
});

test('the premium is payout x P x 1.2 with a floor, plus the keeper reward', () => {
  assert.equal(priceFromHistory([0, 0, 0, 0, 0], 15, aUSD('1')).premium, aUSD('0.171429'));
  const cheap = priceFromHistory(new Array(100).fill(0), 15, aUSD('0.1'));
  assert.ok(cheap.raw < MIN_PREMIUM);
  assert.equal(cheap.premium, MIN_PREMIUM);
  const withReward = priceFromHistory([0, 0, 0, 0, 0], 15, aUSD('1'), UNIFORM_PRIOR, aUSD('0.1'));
  assert.equal(withReward.risk, aUSD('0.171429'));
  assert.equal(withReward.premium, aUSD('0.271429'));
});

test('the population prior needs enough other flights', () => {
  assert.deepEqual(populationPrior(new Array(MIN_POPULATION - 1).fill(0), 15), UNIFORM_PRIOR);
});

test('a flight that was never late shrinks toward the population, not toward 50 %', () => {
  // 2 of 20 other flights were 15+ min late
  const population = [...new Array(18).fill(0), 20, 45];
  const prior = populationPrior(population, 15);
  assert.equal(prior.mean, 3 / 22);
  const withPopulation = priceFromHistory([0, 0, 0, 0, 0], 15, aUSD('1'), prior);
  const withUniform = priceFromHistory([0, 0, 0, 0, 0], 15, aUSD('1'));
  assert.equal(withPopulation.probability, (0 + 4 * (3 / 22)) / (5 + 4));
  assert.ok(withPopulation.premium < withUniform.premium);
});

test('the population prior depends on the threshold', () => {
  const population = [...new Array(10).fill(0), 20, 45, 130];
  assert.ok(populationPrior(population, 120).mean < populationPrior(population, 15).mean);
});

test('arrivalDelay reads a response the way the contract does', () => {
  const scheduledTime = { utc: '2026-10-29 18:35Z' };
  assert.deepEqual(arrivalDelay(flight('Arrived', { scheduledTime, revisedTime: { utc: '2026-10-29 21:10Z' } })), {
    minutes: 155,
    reason: '155 min late',
  });
  assert.equal(
    arrivalDelay(flight('Arrived', { scheduledTime, revisedTime: { utc: '2026-10-29 18:20Z' } })).minutes,
    0
  );
  assert.equal(arrivalDelay(flight('Arrived', { scheduledTime })).reason, 'no actual arrival time');
  assert.equal(arrivalDelay(flight('Canceled', { scheduledTime })).reason, 'status Canceled');
  assert.equal(arrivalDelay('').reason, 'did not operate');
  assert.equal(arrivalDelay('[]').reason, 'did not operate');
});

test('datesIn finds dates in any shape, newest first, once each', () => {
  assert.deepEqual(datesIn('["2026-10-17","2026-10-24","2026-10-17"]'), ['2026-10-24', '2026-10-17']);
  assert.deepEqual(datesIn('[{"departureDateLocal":"2026-10-24T06:05"}]'), ['2026-10-24']);
  assert.deepEqual(datesIn('{"message":"nothing"}'), []);
});

test('shiftDate crosses months', () => {
  assert.equal(shiftDate('2026-11-01', -1), '2026-10-31');
});

test('exposure caps per flight and per departure date', () => {
  const pool = aUSD('10');
  assert.equal(exposureProblem({ pool, flightReserved: 0n, dateReserved: 0n, payout: aUSD('5') }), undefined);
  assert.match(
    exposureProblem({ pool, flightReserved: aUSD('4'), dateReserved: aUSD('4'), payout: aUSD('2') })!,
    /this flight/
  );
  assert.match(exposureProblem({ pool, flightReserved: 0n, dateReserved: aUSD('7'), payout: aUSD('2') })!, /that date/);
  assert.equal(exposureProblem({ pool: 0n, flightReserved: 0n, dateReserved: 0n, payout: 1n }), 'the pool is empty');
});

test('a self-transfer connection becomes a delay threshold on the first flight', () => {
  // Lands 10:00Z, the next flight leaves 13:00Z, 90 min needed to collect bags and check in again
  assert.deepEqual(connectionThreshold('2026-10-31 10:00Z', '2026-10-31 13:00Z', 90), {
    gapMinutes: 180,
    thresholdMinutes: 90,
  });
  // Across midnight
  assert.equal(connectionThreshold('2026-10-31 22:30Z', '2026-11-01 01:30Z', 60).thresholdMinutes, 120);
});

test('a connection that is too tight or impossible is not insured', () => {
  assert.match(connectionThreshold('2026-10-31 10:00Z', '2026-10-31 11:40Z', 90).problem!, /less than 15 min of slack/);
  assert.match(connectionThreshold('2026-10-31 10:00Z', '2026-10-31 09:00Z', 90).problem!, /leaves before/);
  assert.match(connectionThreshold('', '2026-10-31 09:00Z', 90).problem!, /no times/);
});
