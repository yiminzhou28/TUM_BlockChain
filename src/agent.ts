// FlightGuard agent. The underwriter checks its data source, prices flights from history it buys over x402 and signs
// quotes together with a signed proof that the flight is still sellable; the traveller buys policies with them; and
// the keeper settles policies with signed AeroDataBox data, on its own in watch mode, and is paid for it.
//
//   node --env-file=.env src/agent.ts quote <flight> <YYYY-MM-DD> [payout aUSD] [threshold minutes] [history flights]
//   node --env-file=.env src/agent.ts quote-connection <first flight> <date> <second flight> <date> [payout] [minutes to change] [history]
//   node --env-file=.env src/agent.ts buy
//   node --env-file=.env src/agent.ts keeper
//   node --env-file=.env src/agent.ts watch [hours]
//   node --env-file=.env src/agent.ts status
//   node --env-file=.env src/agent.ts fund-traveller [aUSD] [ETH]
//   node --env-file=.env src/agent.ts withdraw
//
// PAYER_PRIVATE_KEY is the underwriter: it owns the pool, pays for data, signs quotes and sends settlements.
// TRAVELLER_PRIVATE_KEY, if set, is the traveller who buys policies and receives payouts. Without it the underwriter
// buys as well. src/mcp.ts offers the same actions to an AI assistant.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  type Hex,
  http,
  isAddressEqual,
  parseEther,
  parseUnits,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { type AirnodeV2Request, fetchSignedResponse, type SignedResponse, verifySignedResponse } from './airnode-v2.ts';
import {
  AERODATABOX_ADDRESS,
  AERODATABOX_URL,
  deriveFlightRequestHash,
  deriveFlightSaleRequestHash,
  deriveFlightStatusRequestHash,
  fetchPublishedSigner,
  fetchSignedFlight,
  fetchSignedFlightSale,
  fetchSignedFlightStatus,
} from './flight.ts';
import {
  arrivalDelay,
  connectionThreshold,
  datesIn,
  exposureProblem,
  MIN_OBSERVED_ARRIVALS,
  type Outcome,
  parseUtc,
  populationPrior,
  priceFromHistory,
  shiftDate,
} from './pricing.ts';
import { createScriptFetch } from './script-options.ts';

export const FLIGHTGUARD = (process.env.FLIGHTGUARD_ADDRESS ?? '0xbce017f3ebccf26bcf28dcf125501b9aafb3d931') as Address;
const AUSD: Address = '0xbeA34973e5f67F18F656A2C6070C64326C791808';
const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const EXPLORER = process.env.EXPLORER ?? 'https://sepolia.basescan.org';
const STATUS = ['None', 'Active', 'PaidOut', 'ClosedOnTime', 'Expired'];

// The same rules as the contract checks at purchase, so the agent never signs a quote the contract would refuse
const SELLABLE_STATUSES = ['Expected', 'CheckIn'];
const SALES_CLOSE_BEFORE_DEPARTURE = 2 * 3600;
const MAX_SALE_PROOF_AGE = 15 * 60;
// A short validity leaves no time to wait for delay news before buying
const QUOTE_VALIDITY = 10 * 60;
// A proof of sale is about the flight, not the buyer: every traveller on the flight can buy with it for this long, so
// the data behind a quote is bought per flight, not per traveller
const SALE_PROOF_REUSE = 5 * 60;
// What the AeroDataBox Airnode charges for each of the operations the agent calls
const PRICE_PER_CALL = parseUnits('0.05', 6);

// Files are found from the project folder, wherever the agent is started from (an AI assistant starts it elsewhere)
const ROOT = new URL('..', import.meta.url);
const file = (name: string) => new URL(name, ROOT);
// Local state, kept out of git
const QUOTE_FILE = file('quote.json'); // the last signed quote and its proof of sale, for buy
const HISTORY_FILE = file('flight-history.json'); // every past flight outcome the agent bought, reused for pricing
const SCHEDULE_FILE = file('schedule.json'); // scheduled arrival of each quoted flight, so watch knows when to look
const SALE_FILE = file('sale-proofs.json'); // the latest checked schedule and proof of sale of each flight
const DATES_FILE = file('flight-dates.json'); // the past departures of each flight, looked up once a day
const QUOTES_FILE = file('quotes-signed.json'); // quotes the underwriter signed that may still be bought

const { abi } = JSON.parse(readFileSync(file('out/FlightGuard.sol/FlightGuard.json'), 'utf8'));
if (!process.env.PAYER_PRIVATE_KEY) throw new Error('Set PAYER_PRIVATE_KEY in .env');
const underwriter = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as Hex);
const traveller = process.env.TRAVELLER_PRIVATE_KEY
  ? privateKeyToAccount(process.env.TRAVELLER_PRIVATE_KEY as Hex)
  : underwriter;
const chain = { ...baseSepolia, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const underwriterWallet = createWalletClient({ account: underwriter, chain, transport: http(RPC) });
const travellerWallet = createWalletClient({ account: traveller, chain, transport: http(RPC) });

/** Where the agent's log lines go: the terminal, or the answer to an AI assistant's tool call */
export const output = { write: (line: string) => console.log(line) };
const log = (...args: unknown[]) => output.write(['[agent]', ...args].join(' '));

const aUSD = (amount: bigint) => `${formatUnits(amount, 6)} aUSD`;
const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
/** One line for an error: for a call the contract refused, the custom error it reverted with, such as QuoteExpired() */
export const describeError = (error: unknown) => {
  if (!(error instanceof BaseError)) return error instanceof Error ? error.message : String(error);
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
    return `${reverted.shortMessage} ${reverted.data.errorName}(${(reverted.data.args ?? []).map(String).join(', ')})`;
  }
  return error.shortMessage;
};
const reason = (error: unknown) => (describeError(error).split('\n')[0] ?? '').slice(0, 160);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = <T>(path: URL, fallback: T): T =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const writeJson = (path: URL, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
const balanceOf = (owner: Address) =>
  publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
const sum = (amounts: bigint[]) => amounts.reduce((a, b) => a + b, 0n);
const read = (functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: FLIGHTGUARD, abi, functionName, args });

/** The keeper reward of this deployment. Earlier deployments had none. */
const keeperReward = async () => {
  try {
    return (await read('keeperReward')) as bigint;
  } catch {
    return 0n;
  }
};

// ---------------------------------------------------------------- the data source

let sourceChecked = false;

/**
 * Before paying for any data: the Airnode the agent buys from must sign with the key that FlightGuard trusts, and that
 * key must still be the one the Airnode publishes. Otherwise every response would be refused on-chain after being paid.
 */
async function checkDataSource() {
  if (sourceChecked) return;
  const trusted = (await read('airnode')) as Address;
  if (!isAddressEqual(trusted, AERODATABOX_ADDRESS)) {
    throw new Error(`FlightGuard trusts ${trusted}, but this agent verifies against ${AERODATABOX_ADDRESS}`);
  }
  let published: Address;
  try {
    published = await fetchPublishedSigner();
  } catch (error) {
    log(
      `Could not read the signer the AeroDataBox Airnode publishes (${reason(error)}). Every response is still verified before use.`
    );
    sourceChecked = true;
    return;
  }
  if (!isAddressEqual(published, trusted)) {
    throw new Error(
      `Not paying for data: the AeroDataBox Airnode now publishes ${published} as its signer, but FlightGuard trusts ${trusted}`
    );
  }
  log(`Data source checked: the AeroDataBox Airnode publishes ${short(published)}, the signer FlightGuard trusts`);
  sourceChecked = true;
}

// ---------------------------------------------------------------- policies on chain

type PolicyTuple = [Address, Hex, bigint, bigint, bigint, number, string, string];
type Policy = Awaited<ReturnType<typeof readPolicies>>[number];

async function readPolicies() {
  const count = (await read('policyCount')) as bigint;
  const policies = [];
  for (let id = 0n; id < count; id++) {
    const p = (await read('policies', [id])) as PolicyTuple;
    policies.push({
      id,
      holder: p[0],
      payout: p[2],
      threshold: p[3],
      settleBy: p[4],
      status: STATUS[p[5]],
      flightNumber: p[6],
      dateLocal: p[7],
    });
  }
  return policies;
}

// ---------------------------------------------------------------- quoting (underwriter)

export interface Connection {
  outbound: string;
  outboundDate: string;
  minConnectionMinutes: number;
}

const normaliseFlight = (text: string) => {
  const flightNumber = String(text).toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z0-9]{3,8}$/.test(flightNumber)) throw new Error(`Flight number ${text} is not like LH400`);
  return flightNumber;
};

const checkDate = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Date ${date} is not YYYY-MM-DD`);
  return date;
};

/** The full AeroDataBox status of one flight departing on one local date, or undefined if it does not operate */
async function fetchSchedule(flightNumber: string, dateLocal: string, payingFetch: typeof fetch) {
  log(`Checking the schedule of ${flightNumber} departing ${dateLocal} (0.05 aUSD)`);
  const signed = await fetchSignedResponse(
    AERODATABOX_URL,
    {
      operation: 'flightStatusOnDate',
      parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal, dateLocalRole: 'Departure' },
    },
    payingFetch
  );
  return signed.data ? JSON.parse(signed.data)[0] : undefined;
}

interface Sale {
  schedule: { from?: string; to?: string; scheduledDeparture: string; scheduledArrival: string; status: string };
  saleProof: SignedResponse;
}

/**
 * Checks that a flight is still sellable and gets the signed proof of sale that the contract requires. Both are about
 * the flight, so a check made in the last SALE_PROOF_REUSE seconds, for any traveller, is used again for free.
 */
async function checkSellable(flightNumber: string, dateLocal: string, payingFetch: typeof fetch): Promise<Sale> {
  const key = `${flightNumber}|${dateLocal}`;
  const salesClosed = (departure: string) => {
    const close = Math.floor(parseUtc(departure) / 1000) - SALES_CLOSE_BEFORE_DEPARTURE;
    if (nowSeconds() >= close) throw new Error(`Not selling: sales closed at ${iso(close)}, 2 h before departure`);
  };

  const recent = readJson<Record<string, Sale>>(SALE_FILE, {})[key];
  const age = recent ? nowSeconds() - Number(recent.saleProof.timestamp) : Infinity;
  if (recent && age < SALE_PROOF_REUSE) {
    log(
      `Reusing the schedule check and proof of sale of ${flightNumber} from ${age} s ago (free): they prove the flight, not the buyer`
    );
    salesClosed(JSON.parse(recent.saleProof.data).scheduledDeparture);
    return recent;
  }

  // 1. The full schedule shows the route, the status and any known delay
  const flight = await fetchSchedule(flightNumber, dateLocal, payingFetch);
  const scheduledDeparture = flight?.departure?.scheduledTime?.utc;
  const scheduledArrival = flight?.arrival?.scheduledTime?.utc;
  if (!flight || !scheduledDeparture || !scheduledArrival)
    throw new Error(`AeroDataBox has no ${flightNumber} departing ${dateLocal}`);
  const revisedDeparture = flight.departure?.revisedTime?.utc;
  const knownDelayMinutes = revisedDeparture
    ? Math.round((parseUtc(revisedDeparture) - parseUtc(scheduledDeparture)) / 60_000)
    : 0;
  log(
    `  ${flight.departure.airport?.iata} -> ${flight.arrival?.airport?.iata}, departs ${scheduledDeparture}, arrives ${scheduledArrival}, status ${flight.status}`
  );
  if (!SELLABLE_STATUSES.includes(flight.status)) throw new Error(`Not selling: status is ${flight.status}`);
  if (knownDelayMinutes >= 15) throw new Error(`Not selling: departure already revised ${knownDelayMinutes} min late`);
  salesClosed(scheduledDeparture);

  // 2. The proof of sale that the contract checks: AeroDataBox's signed status and scheduled departure, right now
  log(`Fetching the signed proof of sale (0.05 aUSD)`);
  const saleProof = await fetchSignedFlightSale(flightNumber, dateLocal, payingFetch);
  await verifySignedResponse(saleProof, AERODATABOX_ADDRESS, deriveFlightSaleRequestHash(flightNumber, dateLocal));
  const signed = JSON.parse(saleProof.data);
  if (!SELLABLE_STATUSES.includes(signed.status)) throw new Error(`Not selling: the signed status is ${signed.status}`);
  salesClosed(signed.scheduledDeparture);
  log(`  signed by AeroDataBox: status ${signed.status}, departs ${signed.scheduledDeparture}`);

  const sale = {
    schedule: {
      from: flight.departure.airport?.iata,
      to: flight.arrival?.airport?.iata,
      scheduledDeparture,
      scheduledArrival,
      status: flight.status,
    },
    saleProof,
  };
  writeJson(SALE_FILE, { ...readJson(SALE_FILE, {}), [key]: sale });
  return sale;
}

interface SignedQuote {
  contract: Address;
  hash: Hex;
  flightNumber: string;
  dateLocal: string;
  payout: string;
  validUntil: number;
}

/**
 * Quotes this underwriter signed for this contract that are still valid and that nobody has used yet. Any of them can
 * still be bought, so their cover counts against the exposure caps; a used one is a policy already.
 */
async function openQuotes() {
  const unexpired = readJson<SignedQuote[]>(QUOTES_FILE, []).filter((q) => q.validUntil > nowSeconds());
  writeJson(QUOTES_FILE, unexpired);
  const here = unexpired.filter((q) => isAddressEqual(q.contract, FLIGHTGUARD));
  const used = await Promise.all(here.map((q) => read('usedQuotes', [q.hash]) as Promise<boolean>));
  return here.filter((_, i) => !used[i]);
}

/** The past dates a flight operated on, newest first. A flight that runs a few days a week has none on most days. */
async function pastDepartures(flightNumber: string, today: string, payingFetch: typeof fetch) {
  const known = readJson<Record<string, { on: string; dates: string[] }>>(DATES_FILE, {});
  if (known[flightNumber]?.on === today) {
    log(`  past departures of ${flightNumber} already looked up today (free)`);
    return known[flightNumber].dates;
  }
  log(`Looking up the dates ${flightNumber} operated on (0.05 aUSD)`);
  try {
    const operated = await fetchSignedResponse(
      AERODATABOX_URL,
      { operation: 'flightDates', parameters: { searchBy: 'number', searchParam: flightNumber } },
      payingFetch
    );
    const dates = datesIn(operated.data ?? '').filter((d) => d < today);
    if (dates.length > 0) writeJson(DATES_FILE, { ...known, [flightNumber]: { on: today, dates } });
    return dates;
  } catch (error) {
    log(`  flightDates failed (${reason(error)})`);
    return [];
  }
}

export async function quote(
  flightText: string,
  dateText: string,
  payoutText: string | number = '2',
  thresholdText: string | number = '120',
  countText: string | number = '5',
  connection?: Connection
) {
  const flightNumber = normaliseFlight(flightText);
  const dateLocal = checkDate(dateText);
  const payout = parseUnits(String(payoutText), 6);
  let threshold = Number(thresholdText);
  const count = Number(countText);
  if (payout <= 0n) throw new Error(`Payout ${payoutText} must be more than 0`);
  if (!connection && (!Number.isInteger(threshold) || threshold < 1)) {
    throw new Error(`Threshold ${thresholdText} must be whole minutes, at least 1`);
  }
  if (!Number.isInteger(count) || count < 2 || count > 14)
    throw new Error(`History ${countText} must be 2 to 14 flights`);
  await checkDataSource();
  // Counts the signed responses this quote pays for
  const scriptFetch = createScriptFetch();
  let paidCalls = 0n;
  const payingFetch: typeof fetch = async (input, init) => {
    const response = await scriptFetch(input, init);
    if (response.ok) paidCalls += 1n;
    return response;
  };

  // 1-2. Is the flight still sellable? The schedule check and the signed proof of sale, shared by every traveller.
  const { schedule, saleProof } = await checkSellable(flightNumber, dateLocal, payingFetch);
  const { scheduledDeparture, scheduledArrival } = schedule;
  writeJson(SCHEDULE_FILE, { ...readJson(SCHEDULE_FILE, {}), [`${flightNumber}|${dateLocal}`]: scheduledArrival });

  // 1b. Self-transfer cover: the slack in the connection becomes the delay threshold on the first flight.
  let connectionSummary: Record<string, unknown> | undefined;
  if (connection) {
    const outbound = normaliseFlight(connection.outbound);
    const outboundDate = checkDate(connection.outboundDate);
    const next = await fetchSchedule(outbound, outboundDate, payingFetch);
    const nextDeparture = next?.departure?.scheduledTime?.utc;
    if (!next || !nextDeparture) throw new Error(`AeroDataBox has no ${outbound} departing ${outboundDate}`);
    if (next.status === 'Canceled') throw new Error(`Not selling: ${outbound} is already cancelled`);
    const changeAt = next.departure?.airport?.iata;
    if (schedule.to && changeAt && schedule.to !== changeAt) {
      throw new Error(`Not selling: ${flightNumber} lands in ${schedule.to} but ${outbound} departs from ${changeAt}`);
    }
    const result = connectionThreshold(scheduledArrival, nextDeparture, connection.minConnectionMinutes);
    if (result.problem) throw new Error(`Not selling: ${result.problem}`);
    threshold = result.thresholdMinutes as number;
    log(
      `  Self-transfer: ${flightNumber} lands ${scheduledArrival}, ${outbound} (${next.departure.airport?.iata} -> ${next.arrival?.airport?.iata}) leaves ${nextDeparture}`
    );
    log(
      `  ${result.gapMinutes} min gap - ${connection.minConnectionMinutes} min to change = pays if ${flightNumber} lands ${threshold}+ min late, is cancelled or diverted`
    );
    connectionSummary = {
      inbound: flightNumber,
      outbound,
      outboundDate,
      gapMinutes: result.gapMinutes,
      minConnectionMinutes: connection.minConnectionMinutes,
    };
  }

  // 3. Is there room in the pool? One strike or storm hits every policy on a flight, and often every flight on a day.
  //    Quotes still open count too: every one of them could be bought.
  const [pool, policies, reward, open] = await Promise.all([
    balanceOf(FLIGHTGUARD),
    readPolicies(),
    keeperReward(),
    openQuotes(),
  ]);
  const cover = [
    ...policies.filter((p) => p.status === 'Active'),
    ...open.map((q) => ({ flightNumber: q.flightNumber, dateLocal: q.dateLocal, payout: BigInt(q.payout) })),
  ];
  const problem = exposureProblem({
    pool,
    flightReserved: sum(
      cover.filter((c) => c.flightNumber === flightNumber && c.dateLocal === dateLocal).map((c) => c.payout)
    ),
    dateReserved: sum(cover.filter((c) => c.dateLocal === dateLocal).map((c) => c.payout)),
    payout,
  });
  if (problem) {
    // Name the open quotes behind it, and when the last of them expires and frees its cover
    const counted = open.filter(
      (q) => q.dateLocal === dateLocal && (!problem.includes('this flight') || q.flightNumber === flightNumber)
    );
    const until = Math.max(...counted.map((q) => q.validUntil));
    const note = counted.length > 0 ? `, counting ${counted.length} open quote(s) until ${iso(until)}` : '';
    throw new Error(`Not selling: ${problem}${note}`);
  }

  // 4. Which past dates did the flight operate on? Price from the flight's own last departures.
  log(
    `Pricing ${flightNumber} on ${dateLocal}: payout ${aUSD(payout)} if ${threshold}+ min late, cancelled or diverted`
  );
  const today = new Date().toISOString().slice(0, 10);
  let history = (await pastDepartures(flightNumber, today, payingFetch)).slice(0, count);
  if (history.length === 0) {
    history = Array.from({ length: count }, (_, i) => shiftDate(today, -(i + 1)));
    log(`  no past dates found, using the last ${count} calendar days`);
  } else {
    log(`  last ${history.length} departures: ${history.join(', ')}`);
  }

  // 5. How did those flights go? From the agent's own history if it bought them before, otherwise over x402. The
  //    history is per flight, not per traveller: every later quote on the same flight reuses it for free.
  const cache = readJson<Record<string, Outcome>>(HISTORY_FILE, {});
  const delays: number[] = [];
  for (const day of history) {
    const key = `${flightNumber}|${day}`;
    if (!cache[key]) {
      const request: AirnodeV2Request = {
        operation: 'flightStatusOnDate',
        parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal: day, dateLocalRole: 'Departure' },
      };
      try {
        cache[key] = arrivalDelay((await fetchSignedResponse(AERODATABOX_URL, request, payingFetch)).data);
        log(`  ${day}: ${cache[key].reason} (bought, 0.05 aUSD)`);
      } catch (error) {
        log(`  ${day}: skipped (${reason(error)})`);
        continue;
      }
    } else {
      log(`  ${day}: ${cache[key].reason} (from history, free)`);
    }
    if (cache[key].minutes !== undefined) delays.push(cache[key].minutes);
  }
  writeJson(HISTORY_FILE, cache);

  // 6. Sell only what can be settled. The contract settles from the arrival revisedTime; if AeroDataBox did not report
  //    one for this flight's recent arrivals, it may not report one this time either.
  if (delays.length < MIN_OBSERVED_ARRIVALS) {
    throw new Error(
      `Not selling: only ${delays.length} of ${history.length} past flights have an actual arrival time in AeroDataBox, ` +
        'so this policy might never be settleable'
    );
  }

  // 7. Price: the flight's own record, shrunk toward every other flight the agent has observed (empirical Bayes), plus
  //    the keeper reward that the contract pays to whoever settles.
  const otherFlights = Object.entries(cache)
    .filter(([key, outcome]) => !key.startsWith(`${flightNumber}|`) && outcome.minutes !== undefined)
    .map(([, outcome]) => outcome.minutes as number);
  const prior = populationPrior(otherFlights, threshold);
  const { n, k, probability, raw, risk, premium } = priceFromHistory(delays, threshold, payout, prior, reward);
  log(`Prior: ${prior.source} -> mean ${prior.mean.toFixed(3)}, worth ${prior.strength} flights`);
  log(
    `${k} of ${n} of its own flights were ${threshold}+ min late -> P(delay) = (${k} + ${prior.strength} x ${prior.mean.toFixed(3)}) / (${n} + ${prior.strength}) = ${probability.toFixed(3)}`
  );
  const floor = raw < risk ? `, raised to the ${aUSD(risk)} minimum` : '';
  log(
    `Premium: ${aUSD(payout)} x ${probability.toFixed(3)} x 1.2 = ${aUSD(raw)}${floor}, + ${aUSD(reward)} keeper reward = ${aUSD(premium)}`
  );
  log(
    `Data bought for this quote: ${paidCalls} signed responses = ${aUSD(paidCalls * PRICE_PER_CALL)}. Every traveller on ` +
      `${flightNumber} reuses its history and dates, and for 5 min its proof of sale`
  );
  if (premium >= payout) throw new Error(`Not selling: the premium ${aUSD(premium)} would not be below the payout`);

  // 8. Sign the quote for the traveller. It expires before the proof of sale gets too old for the contract and before
  //    sales close.
  const saleDepartureAt = Math.floor(parseUtc(JSON.parse(saleProof.data).scheduledDeparture) / 1000);
  const validUntil = Math.min(
    nowSeconds() + QUOTE_VALIDITY,
    saleDepartureAt - SALES_CLOSE_BEFORE_DEPARTURE - 60,
    Number(saleProof.timestamp) + MAX_SALE_PROOF_AGE - 60
  );
  const q = {
    holder: traveller.address,
    flightNumber,
    dateLocal,
    premium,
    payout,
    delayThresholdMinutes: BigInt(threshold),
    validUntil: BigInt(validUntil),
    nonce: BigInt(Date.now()),
  };
  const quoteHash = (await read('hashQuote', [q])) as Hex;
  const signature = await underwriter.signMessage({ message: { raw: quoteHash } });
  const signedQuote: SignedQuote = {
    contract: FLIGHTGUARD,
    hash: quoteHash,
    flightNumber,
    dateLocal,
    payout: payout.toString(),
    validUntil,
  };
  writeJson(QUOTES_FILE, [...readJson<SignedQuote[]>(QUOTES_FILE, []), signedQuote]);
  writeJson(QUOTE_FILE, {
    quote: q,
    signature,
    saleProof,
    pricing: { observed: n, delayed: k, probability, prior },
    connection: connectionSummary,
  });
  log(
    `Signed by underwriter ${short(underwriter.address)} for traveller ${short(traveller.address)}, valid until ${iso(validUntil)}. Saved to quote.json`
  );
  return {
    flightNumber,
    dateLocal,
    route: `${schedule.from} -> ${schedule.to}`,
    scheduledDeparture,
    scheduledArrival,
    payout: aUSD(payout),
    delayThresholdMinutes: threshold,
    probability: Number(probability.toFixed(3)),
    premium: aUSD(premium),
    validUntil: iso(validUntil),
    dataBought: aUSD(paidCalls * PRICE_PER_CALL),
    connection: connectionSummary,
  };
}

/** Self-transfer cover: a delay policy on the first flight, with the slack in the connection as its threshold */
export const quoteConnection = (
  inbound: string,
  inboundDate: string,
  outbound: string,
  outboundDate: string,
  payoutText: string | number = '2',
  minConnectionText: string | number = '90',
  countText: string | number = '5'
) => {
  const minConnectionMinutes = Number(minConnectionText);
  if (!Number.isInteger(minConnectionMinutes) || minConnectionMinutes < 0)
    throw new Error(`Minutes to change ${minConnectionText} must be whole minutes`);
  return quote(inbound, inboundDate, payoutText, 0, countText, { outbound, outboundDate, minConnectionMinutes });
};

// ---------------------------------------------------------------- buying (traveller)

export async function buy() {
  if (!existsSync(QUOTE_FILE)) throw new Error('No quote yet. Quote first.');
  const { quote: raw, signature, saleProof } = JSON.parse(readFileSync(QUOTE_FILE, 'utf8'));
  const q = {
    ...raw,
    premium: BigInt(raw.premium),
    payout: BigInt(raw.payout),
    delayThresholdMinutes: BigInt(raw.delayThresholdMinutes),
    validUntil: BigInt(raw.validUntil),
    nonce: BigInt(raw.nonce),
  };
  if (q.holder.toLowerCase() !== traveller.address.toLowerCase()) {
    throw new Error(`The quote is for ${q.holder}, but TRAVELLER_PRIVATE_KEY is ${traveller.address}. Quote again.`);
  }
  if (!saleProof) throw new Error('The quote has no proof of sale. Quote again.');
  if (nowSeconds() > Number(q.validUntil))
    throw new Error(`The quote expired at ${iso(Number(q.validUntil))}. Quote again.`);
  log(
    `Traveller ${short(traveller.address)} buys ${q.flightNumber} ${q.dateLocal}: premium ${aUSD(q.premium)}, payout ${aUSD(q.payout)} if ${q.delayThresholdMinutes}+ min late, cancelled or diverted`
  );

  const allowance = await publicClient.readContract({
    address: AUSD,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [traveller.address, FLIGHTGUARD],
  });
  if (allowance < q.premium) {
    // Approve exactly the premium, not an unlimited amount
    const hash = await travellerWallet.writeContract({
      address: AUSD,
      abi: erc20Abi,
      functionName: 'approve',
      args: [FLIGHTGUARD, q.premium],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`Approved ${aUSD(q.premium)}: ${EXPLORER}/tx/${hash}`);
  }
  const proof = {
    timestamp: BigInt(saleProof.timestamp),
    data: toHex(saleProof.data),
    signature: saleProof.signature as Hex,
  };
  const hash = await travellerWallet.writeContract({
    address: FLIGHTGUARD,
    abi,
    functionName: 'buyPolicy',
    args: [q, signature, proof],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`buyPolicy reverted: ${EXPLORER}/tx/${hash}`);
  const policyId = ((await read('policyCount')) as bigint) - 1n;
  const sale = JSON.parse(saleProof.data);
  log(
    `The contract verified AeroDataBox's signed proof of sale: status ${sale.status}, departs ${sale.scheduledDeparture}`
  );
  log(`Policy #${policyId} bought: ${EXPLORER}/tx/${hash}`);
  return { policyId: Number(policyId), transaction: `${EXPLORER}/tx/${hash}` };
}

// ---------------------------------------------------------------- settling (keeper, anyone can do it)

const sendSettlement = async (
  functionName: 'settle' | 'settleCancelledOrDiverted',
  id: bigint,
  signed: SignedResponse
) => {
  const hash = await underwriterWallet.writeContract({
    address: FLIGHTGUARD,
    abi,
    functionName,
    args: [id, BigInt(signed.timestamp), toHex(signed.data), signed.signature],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${EXPLORER}/tx/${hash}`);
  return `${EXPLORER}/tx/${hash}`;
};

const RECHECK_AFTER_ESTIMATE = 10 * 60;
const RECHECK_WITHOUT_ESTIMATE = 30 * 60;

/**
 * Tries to settle one policy: first with the arrival, then with a cancellation or diversion. Only if neither settles it
 * and its settlement window is over does it expire the policy. Returns when to look again, or undefined if it is done.
 */
async function checkPolicy(p: Policy, payingFetch: typeof fetch, reward: bigint): Promise<number | undefined> {
  log(
    `Policy #${p.id}: ${p.flightNumber} departing ${p.dateLocal}, pays ${aUSD(p.payout)} to ${short(p.holder)} if ${p.threshold}+ min late, cancelled or diverted`
  );
  const rewardNote = reward > 0n ? `, keeper reward ${aUSD(reward)} to ${short(underwriter.address)}` : '';
  // Set when the arrival request shows the flight on its way, with an estimated arrival to come back at
  let next: number | undefined;

  // 1. The arrival request: the actual arrival time against the scheduled one
  try {
    const signed = await fetchSignedFlight(p.flightNumber, p.dateLocal, payingFetch);
    // Check off-chain first, so a response the contract would reject does not cost gas
    await verifySignedResponse(signed, AERODATABOX_ADDRESS, deriveFlightRequestHash(p.flightNumber, p.dateLocal));
    const data = JSON.parse(signed.data);
    if (data.status === 'Arrived') {
      const delay = Math.max(0, Math.floor((parseUtc(data.actualArrival) - parseUtc(data.scheduledArrival)) / 60_000));
      log(
        `  signed by AeroDataBox: arrived ${data.actualArrival}, scheduled ${data.scheduledArrival} -> ${delay} min late`
      );
      const tx = await sendSettlement('settle', p.id, signed);
      log(
        `  ${delay >= Number(p.threshold) ? `PAID OUT ${aUSD(p.payout)} to ${short(p.holder)}` : 'on time, closed without payout'}${rewardNote}: ${tx}`
      );
      return undefined;
    }
    if (data.status !== 'Canceled' && data.status !== 'Diverted') {
      const estimate = Math.floor(parseUtc(data.actualArrival) / 1000);
      log(`  status ${data.status}, expected to arrive ${data.actualArrival}`);
      if (!Number.isNaN(estimate)) next = Math.max(estimate, nowSeconds()) + RECHECK_AFTER_ESTIMATE;
    }
  } catch (error) {
    log(`  no arrival time yet (${reason(error)})`);
  }

  // 2. The status request: a cancelled or diverted flight has no arrival time but pays out on its status. Not needed
  //    while the flight is on its way, unless the settlement window is over.
  if (next === undefined || BigInt(nowSeconds()) > p.settleBy) {
    try {
      const signed = await fetchSignedFlightStatus(p.flightNumber, p.dateLocal, payingFetch);
      await verifySignedResponse(
        signed,
        AERODATABOX_ADDRESS,
        deriveFlightStatusRequestHash(p.flightNumber, p.dateLocal)
      );
      const { status } = JSON.parse(signed.data);
      if (status === 'Canceled' || status === 'Diverted') {
        log(`  signed by AeroDataBox: ${status}`);
        const tx = await sendSettlement('settleCancelledOrDiverted', p.id, signed);
        log(
          `  PAID OUT ${aUSD(p.payout)} to ${short(p.holder)} for a ${status === 'Canceled' ? 'cancelled' : 'diverted'} flight${rewardNote}: ${tx}`
        );
        return undefined;
      }
      log(`  status ${status}`);
    } catch (error) {
      log(`  no status yet (${reason(error)})`);
    }
  }

  // 3. Only now, if the settlement window is over, release the reserve
  if (BigInt(nowSeconds()) > p.settleBy) {
    const hash = await underwriterWallet.writeContract({
      address: FLIGHTGUARD,
      abi,
      functionName: 'expire',
      args: [p.id],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log(
      `  nothing to settle with and the settlement window is over: expired, reserve released: ${EXPLORER}/tx/${hash}`
    );
    return undefined;
  }
  return next ?? nowSeconds() + RECHECK_WITHOUT_ESTIMATE;
}

/** One pass over every active policy */
export async function keeper() {
  const active = (await readPolicies()).filter((p) => p.status === 'Active');
  log(`${active.length} active ${active.length === 1 ? 'policy' : 'policies'}`);
  if (active.length === 0) return;
  await checkDataSource();
  const payingFetch = createScriptFetch();
  const reward = await keeperReward();
  for (const p of active) {
    try {
      const next = await checkPolicy(p, payingFetch, reward);
      if (next !== undefined) log(`  not settled yet, look again after ${iso(next)}`);
    } catch (error) {
      log(`  failed (${reason(error)})`);
    }
  }
}

/**
 * Runs on its own: sleeps until each flight's scheduled arrival, settles it once AeroDataBox reports the arrival,
 * cancellation or diversion, and stops when no policy is left or after `hours`. Policies bought while it runs are
 * picked up at their own scheduled arrival.
 */
export async function watch(hoursText: string | number = '12') {
  const stopAt = nowSeconds() + Number(hoursText) * 3600;
  const payingFetch = createScriptFetch();
  const next = new Map<string, number>();
  let announced = 0;
  let checked = false;
  log(`Watching FlightGuard ${FLIGHTGUARD} until ${iso(stopAt)}`);
  for (;;) {
    // A failed call, such as a network error or a settlement someone else sent first, must not stop the watch
    try {
      const active = (await readPolicies()).filter((p) => p.status === 'Active');
      if (active.length === 0) return log('No active policies left. Done.');
      if (!checked) {
        await checkDataSource();
        checked = true;
      }
      const reward = await keeperReward();
      // Read again every round, so a policy quoted while the watch runs is first looked at when its flight lands
      const scheduled = readJson<Record<string, string>>(SCHEDULE_FILE, {});
      for (const p of active) {
        const id = p.id.toString();
        if (!next.has(id)) {
          const arrival = scheduled[`${p.flightNumber}|${p.dateLocal}`];
          next.set(id, arrival ? Math.floor(parseUtc(arrival) / 1000) : nowSeconds());
          log(`Policy #${id} ${p.flightNumber}: first look ${arrival ? `at its scheduled arrival ${arrival}` : 'now'}`);
        }
        if ((next.get(id) as number) > nowSeconds()) continue;
        try {
          const again = await checkPolicy(p, payingFetch, reward);
          if (again === undefined) next.delete(id);
          else next.set(id, again);
        } catch (error) {
          log(`  failed (${reason(error)}), trying again in 10 minutes`);
          next.set(id, nowSeconds() + RECHECK_AFTER_ESTIMATE);
        }
      }
      const waiting = active.map((p) => next.get(p.id.toString())).filter((t): t is number => t !== undefined);
      if (waiting.length === 0) continue;
      const wake = Math.min(...waiting);
      if (wake > stopAt) return log(`Next look at ${iso(wake)} is after the watch window. Stopping.`);
      if ((await balanceOf(underwriter.address)) < parseUnits('0.1', 6)) {
        return log('The underwriter has less than 0.1 aUSD left to pay for data. Stopping.');
      }
      if (wake > nowSeconds()) {
        if (wake !== announced) log(`Sleeping until ${iso(wake)}`);
        announced = wake;
        // At most 1 minute at a time against the wall clock: a laptop that slept is back on time when it wakes, and a
        // policy bought in the meantime is noticed
        await sleep(Math.min(wake - nowSeconds(), 60) * 1000);
      }
    } catch (error) {
      if (nowSeconds() > stopAt) return log('The watch window is over. Stopping.');
      log(`Could not read the policies (${reason(error)}), trying again in 1 minute`);
      await sleep(60_000);
    }
  }
}

// ---------------------------------------------------------------- pool and wallets

export async function status() {
  const [pool, reserved, reward, underwriterBalance, travellerBalance, policies] = await Promise.all([
    balanceOf(FLIGHTGUARD),
    read('totalReserved') as Promise<bigint>,
    keeperReward(),
    balanceOf(underwriter.address),
    balanceOf(traveller.address),
    readPolicies(),
  ]);
  log(`FlightGuard ${FLIGHTGUARD}: pool ${aUSD(pool)}, reserved ${aUSD(reserved)}, keeper reward ${aUSD(reward)}`);
  log(`Underwriter ${short(underwriter.address)}: ${aUSD(underwriterBalance)}`);
  if (traveller !== underwriter) log(`Traveller ${short(traveller.address)}: ${aUSD(travellerBalance)}`);
  for (const p of policies) {
    log(
      `  #${p.id} ${p.flightNumber} ${p.dateLocal} holder ${short(p.holder)} payout ${aUSD(p.payout)} threshold ${p.threshold} min: ${p.status}`
    );
  }
  return {
    contract: FLIGHTGUARD,
    pool: aUSD(pool),
    reserved: aUSD(reserved),
    keeperReward: aUSD(reward),
    traveller: aUSD(travellerBalance),
    policies: policies.map((p) => ({
      id: Number(p.id),
      flight: p.flightNumber,
      date: p.dateLocal,
      payout: aUSD(p.payout),
      thresholdMinutes: Number(p.threshold),
      status: p.status,
    })),
  };
}

/** The underwriter gives the traveller aUSD for premiums and a little ETH for gas */
export async function fundTraveller(aUSDText = '1.5', ethText = '0.00002') {
  if (traveller === underwriter) throw new Error('Set TRAVELLER_PRIVATE_KEY in .env first');
  const tokens = await underwriterWallet.writeContract({
    address: AUSD,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [traveller.address, parseUnits(aUSDText, 6)],
  });
  await publicClient.waitForTransactionReceipt({ hash: tokens });
  const gas = await underwriterWallet.sendTransaction({ to: traveller.address, value: parseEther(ethText) });
  await publicClient.waitForTransactionReceipt({ hash: gas });
  log(`Sent ${aUSDText} aUSD and ${ethText} ETH to traveller ${traveller.address}`);
}

/** The underwriter takes back everything in the pool that is not reserved for active policies */
export async function withdraw() {
  const available = (await read('availableLiquidity')) as bigint;
  if (available === 0n) return log('Nothing to withdraw');
  const hash = await underwriterWallet.writeContract({
    address: FLIGHTGUARD,
    abi,
    functionName: 'withdraw',
    args: [available],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  log(`Withdrew ${aUSD(available)} from ${FLIGHTGUARD}: ${EXPLORER}/tx/${hash}`);
}

// ---------------------------------------------------------------- main

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'quote') await quote(...(args as [string, string]));
    else if (command === 'quote-connection') await quoteConnection(...(args as [string, string, string, string]));
    else if (command === 'buy') await buy();
    else if (command === 'keeper') await keeper();
    else if (command === 'watch') await watch(args[0]);
    else if (command === 'status') await status();
    else if (command === 'fund-traveller') await fundTraveller(args[0], args[1]);
    else if (command === 'withdraw') await withdraw();
    else {
      console.log(
        'Usage: src/agent.ts quote <flight> <YYYY-MM-DD> [payout] [threshold min] [history flights] | ' +
          'quote-connection <first flight> <date> <second flight> <date> [payout] [minutes to change] [history] | ' +
          'buy | keeper | watch [hours] | status | fund-traveller [aUSD] [ETH] | withdraw'
      );
    }
  } catch (error) {
    console.error(`Error: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
