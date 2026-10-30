// How the FlightGuard agent reads flight data and prices cover. No wallets and no network calls here, so all of it is
// unit tested in src/pricing.test.ts.
import { parseUnits } from 'viem';

/** "2026-10-29 18:39Z" -> Unix milliseconds */
export const parseUtc = (text: string) => Date.parse(text.replace(' ', 'T'));

/** The date `days` after `date`, both YYYY-MM-DD */
export const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** How one past flight went: its arrival delay in minutes, or why there is none */
export interface Outcome {
  minutes?: number;
  reason: string;
}

/**
 * The arrival delay of the operating flight in a full AeroDataBox flightStatusOnDate response, read the way the
 * contract reads it: status Arrived, arrival revisedTime against scheduledTime, in whole minutes, early counts as 0.
 */
export const arrivalDelay = (data: string): Outcome => {
  const flights = data ? JSON.parse(data) : undefined;
  const flight = Array.isArray(flights) ? flights[0] : undefined;
  if (!flight) return { reason: 'did not operate' };
  if (flight.status !== 'Arrived') return { reason: `status ${flight.status}` };
  const scheduled = flight.arrival?.scheduledTime?.utc;
  const actual = flight.arrival?.revisedTime?.utc;
  if (!scheduled || !actual) return { reason: 'no actual arrival time' };
  const minutes = Math.max(0, Math.floor((parseUtc(actual) - parseUtc(scheduled)) / 60_000));
  return { minutes, reason: `${minutes} min late` };
};

/** Every YYYY-MM-DD in a response, whatever its shape, newest first */
export const datesIn = (data: string) => [...new Set(data.match(/\d{4}-\d{2}-\d{2}/g) ?? [])].sort().reverse();

/** A Beta prior on P(delay), as its mean and its strength in flights */
export interface Prior {
  mean: number;
  strength: number;
  source: string;
}

/** Beta(1,1), under which the estimate is (k + 1) / (n + 2) */
export const UNIFORM_PRIOR: Prior = { mean: 0.5, strength: 2, source: 'uniform prior Beta(1,1)' };

/** Observations of other flights needed before the population prior replaces the uniform one */
export const MIN_POPULATION = 10;

/** How many flights the population prior is worth */
export const POPULATION_PRIOR_STRENGTH = 4;

/**
 * Empirical Bayes: the prior is estimated from every other flight the agent has observed, so a flight with a short
 * history shrinks toward how often flights are late in general, not toward a coin flip.
 */
export const populationPrior = (otherFlightDelays: number[], thresholdMinutes: number): Prior => {
  const n = otherFlightDelays.length;
  if (n < MIN_POPULATION) return UNIFORM_PRIOR;
  const late = otherFlightDelays.filter((d) => d >= thresholdMinutes).length;
  return {
    mean: (late + 1) / (n + 2),
    strength: POPULATION_PRIOR_STRENGTH,
    source: `population prior: ${late} of ${n} other observed flights were ${thresholdMinutes}+ min late`,
  };
};

export const MARGIN = 0.2;
export const MIN_PREMIUM = parseUnits('0.05', 6);

/** Fewer past arrivals with an actual time than this, and the flight's policy might never be settleable */
export const MIN_OBSERVED_ARRIVALS = 2;

/**
 * P(delay >= threshold) is the posterior mean (k + s * m) / (n + s) for a Beta prior with mean m and strength s.
 * Premium = payout * P * (1 + margin), at least MIN_PREMIUM.
 */
export const priceFromHistory = (delays: number[], thresholdMinutes: number, payout: bigint, prior = UNIFORM_PRIOR) => {
  const n = delays.length;
  const k = delays.filter((d) => d >= thresholdMinutes).length;
  const probability = (k + prior.strength * prior.mean) / (n + prior.strength);
  let premium = (payout * BigInt(Math.round(probability * (1 + MARGIN) * 1e6))) / 1_000_000n;
  if (premium < MIN_PREMIUM) premium = MIN_PREMIUM;
  return { n, k, probability, premium };
};

/** Most of the pool that the payouts of one flight, and of all flights departing on one date, may take */
export const MAX_SHARE_PER_FLIGHT = 0.5;
export const MAX_SHARE_PER_DATE = 0.8;

/**
 * Why selling `payout` more cover would concentrate too much risk, or undefined if it does not. One strike or storm
 * hits every policy on a flight, and often every flight on a day, at once.
 */
export const exposureProblem = (e: { pool: bigint; flightReserved: bigint; dateReserved: bigint; payout: bigint }) => {
  if (e.pool === 0n) return 'the pool is empty';
  const share = (amount: bigint) => Number(amount) / Number(e.pool);
  if (share(e.flightReserved + e.payout) > MAX_SHARE_PER_FLIGHT) {
    return `cover on this flight would exceed ${MAX_SHARE_PER_FLIGHT * 100} % of the pool`;
  }
  if (share(e.dateReserved + e.payout) > MAX_SHARE_PER_DATE) {
    return `cover on flights departing that date would exceed ${MAX_SHARE_PER_DATE * 100} % of the pool`;
  }
  return undefined;
};
