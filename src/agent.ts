// FlightGuard agent: prices policies from flight history it buys over x402, signs quotes, buys policies and settles
// them with signed AeroDataBox data.
//
//   node --env-file=.env src/agent.ts quote LH400 2026-10-29 [payout aUSD] [threshold minutes] [history days]
//   node --env-file=.env src/agent.ts buy
//   node --env-file=.env src/agent.ts keeper
//   node --env-file=.env src/agent.ts status
//   node --env-file=.env src/agent.ts withdraw
import { readFileSync, writeFileSync } from 'node:fs';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  type Hex,
  http,
  parseUnits,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { type AirnodeV2Request, fetchSignedResponse, type SignedResponse, verifySignedResponse } from './airnode-v2.ts';
import { AERODATABOX_ADDRESS, AERODATABOX_URL, deriveFlightRequestHash, fetchSignedFlight } from './flight.ts';
import { createScriptFetch } from './script-options.ts';

const FLIGHTGUARD = (process.env.FLIGHTGUARD_ADDRESS ?? '0xE12a3238ca345b45d34D4A8E9A244228EdfcBc73') as Address;
const AUSD: Address = '0xbeA34973e5f67F18F656A2C6070C64326C791808';
const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const EXPLORER = process.env.EXPLORER ?? 'https://sepolia.basescan.org';
const QUOTE_FILE = 'quote.json';
const STATUS = ['None', 'Active', 'PaidOut', 'ClosedOnTime', 'Expired'];

const { abi } = JSON.parse(readFileSync('out/FlightGuard.sol/FlightGuard.json', 'utf8'));
const key = process.env.PAYER_PRIVATE_KEY as Hex;
if (!key) throw new Error('Set PAYER_PRIVATE_KEY in .env');
const account = privateKeyToAccount(key);
const chain = { ...baseSepolia, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
const aUSD = (amount: bigint) => `${formatUnits(amount, 6)} aUSD`;
const log = (...args: unknown[]) => console.log('[agent]', ...args);

// ---------------------------------------------------------------- pricing

// "2026-10-29 18:39Z" -> Unix ms
const parseUtc = (text: string) => Date.parse(text.replace(' ', 'T'));

const shiftDate = (dateLocal: string, days: number) => {
  const d = new Date(`${dateLocal}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Arrival delay of the operating flight in a full AeroDataBox response, read the same way the contract reads it
 * (status Arrived, arrival revisedTime against scheduledTime), or why there is none.
 */
export const arrivalDelay = (data: string): { minutes?: number; reason: string } => {
  const flights = data ? JSON.parse(data) : undefined;
  const flight = Array.isArray(flights) ? flights[0] : undefined;
  if (!flight) return { reason: 'did not operate' };
  if (flight.status !== 'Arrived') return { reason: `status ${flight.status}` };
  const scheduled = flight.arrival?.scheduledTime?.utc;
  const actual = flight.arrival?.revisedTime?.utc;
  if (!scheduled || !actual) return { reason: 'no actual arrival time' };
  const minutes = Math.max(0, Math.round((parseUtc(actual) - parseUtc(scheduled)) / 60_000));
  return { minutes, reason: `${minutes} min late` };
};

/** Every YYYY-MM-DD in a response, whatever its shape, newest first */
export const datesIn = (data: string) => [...new Set(data.match(/\d{4}-\d{2}-\d{2}/g) ?? [])].sort().reverse();

/**
 * Premium = payout x P(delay >= threshold) x (1 + margin), with P estimated from the observed history using a
 * Beta(1,1) prior, so a flight with no delays in a short history still gets a nonzero price: (k + 1) / (n + 2).
 */
export const priceFromHistory = (delays: number[], thresholdMinutes: number, payout: bigint) => {
  const n = delays.length;
  const k = delays.filter((d) => d >= thresholdMinutes).length;
  const probability = (k + 1) / (n + 2);
  const MARGIN = 0.2;
  const MIN_PREMIUM = parseUnits('0.05', 6);
  let premium = (payout * BigInt(Math.round(probability * (1 + MARGIN) * 1e6))) / 1_000_000n;
  if (premium < MIN_PREMIUM) premium = MIN_PREMIUM;
  return { n, k, probability, premium };
};

async function quote(flightText: string, dateLocal: string, payoutText = '2', thresholdText = '120', daysText = '5') {
  const flightNumber = flightText.toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z0-9]{3,8}$/.test(flightNumber)) throw new Error(`Flight number ${flightText} is not like LH400`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateLocal)) throw new Error(`Date ${dateLocal} is not YYYY-MM-DD`);
  const payout = parseUnits(payoutText, 6);
  const threshold = Number(thresholdText);
  const days = Number(daysText);
  if (payout <= 0n) throw new Error(`Payout ${payoutText} must be more than 0`);
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error(`Threshold ${thresholdText} must be whole minutes, at least 1`);
  if (!Number.isInteger(days) || days < 2 || days > 14) throw new Error(`History ${daysText} must be 2 to 14 flights`);
  const payingFetch = createScriptFetch();

  // 1. Is the flight still sellable? Buy its schedule for that date and stop if it has departed, is already known to
  //    be late, or leaves within SALES_CLOSE_BEFORE_DEPARTURE. The quote expires before the scheduled departure, and
  //    the contract enforces that expiry, so a traveller can never buy cover once the flight is under way.
  const SALES_CLOSE_BEFORE_DEPARTURE = 2 * 3600;
  const SELLABLE_STATUSES = ['Expected', 'Unknown', 'CheckIn'];
  log(`Checking the schedule of ${flightNumber} departing ${dateLocal} (0.05 aUSD)`);
  const schedule = await fetchSignedResponse(
    AERODATABOX_URL,
    {
      operation: 'flightStatusOnDate',
      parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal, dateLocalRole: 'Departure' },
    },
    payingFetch
  );
  const flight = schedule.data ? JSON.parse(schedule.data)[0] : undefined;
  const scheduledDeparture = flight?.departure?.scheduledTime?.utc;
  if (!flight || !scheduledDeparture) throw new Error(`AeroDataBox has no ${flightNumber} departing ${dateLocal}`);
  const departureAt = Math.floor(parseUtc(scheduledDeparture) / 1000);
  const revisedDeparture = flight.departure?.revisedTime?.utc;
  const knownDelayMinutes = revisedDeparture ? Math.round((parseUtc(revisedDeparture) - departureAt * 1000) / 60_000) : 0;
  log(`  ${flight.departure.airport?.iata} -> ${flight.arrival?.airport?.iata}, departs ${scheduledDeparture}, status ${flight.status}`);
  if (!SELLABLE_STATUSES.includes(flight.status)) throw new Error(`Not selling: status is ${flight.status}`);
  if (knownDelayMinutes >= 15) throw new Error(`Not selling: departure already revised ${knownDelayMinutes} min late`);
  const now = Math.floor(Date.now() / 1000);
  const salesClose = departureAt - SALES_CLOSE_BEFORE_DEPARTURE;
  if (now >= salesClose) {
    throw new Error(`Not selling: sales closed at ${new Date(salesClose * 1000).toISOString()}, 2 h before departure`);
  }

  log(`Pricing ${flightNumber} on ${dateLocal}: payout ${aUSD(payout)} if ${threshold}+ min late`);

  // 2. Which past dates did this flight operate on? A flight that runs a few days a week has no flight on most
  //    calendar days, so ask flightDates and price from the flight's own last `days` departures.
  const today = new Date().toISOString().slice(0, 10);
  let history: string[] = [];
  log(`Looking up the dates ${flightNumber} operated on (0.05 aUSD)`);
  try {
    const operated = await fetchSignedResponse(
      AERODATABOX_URL,
      { operation: 'flightDates', parameters: { searchBy: 'number', searchParam: flightNumber } },
      payingFetch
    );
    history = datesIn(operated.data ?? '').filter((d) => d < today).slice(0, days);
  } catch (error) {
    log(`  flightDates failed (${(error as Error).message.slice(0, 80)})`);
  }
  if (history.length === 0) {
    history = Array.from({ length: days }, (_, i) => shiftDate(today, -(i + 1)));
    log(`  no past dates found, using the last ${days} calendar days`);
  } else {
    log(`  last ${history.length} departures: ${history.join(', ')}`);
  }

  // 3. Buy the outcome of each of those flights over x402 and price from them.
  log(`Buying ${history.length} past flights from AeroDataBox over x402 (0.05 aUSD each)`);
  const delays: number[] = [];
  for (const day of history) {
    const request: AirnodeV2Request = {
      operation: 'flightStatusOnDate',
      parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal: day, dateLocalRole: 'Departure' },
    };
    try {
      const signed = await fetchSignedResponse(AERODATABOX_URL, request, payingFetch);
      const { minutes, reason } = arrivalDelay(signed.data);
      log(`  ${day}: ${reason}`);
      if (minutes !== undefined) delays.push(minutes);
    } catch (error) {
      log(`  ${day}: skipped (${(error as Error).message.slice(0, 80)})`);
    }
  }

  // 4. Sell only what can be settled and is worth buying.
  //    The contract settles from the arrival revisedTime. If AeroDataBox did not report one for this flight's recent
  //    arrivals, it may not report one for this flight either, and the policy could never pay out.
  const MIN_OBSERVED_ARRIVALS = 2;
  if (delays.length < MIN_OBSERVED_ARRIVALS) {
    throw new Error(
      `Not selling: only ${delays.length} of ${history.length} past flights have an actual arrival time in AeroDataBox, ` +
        `so this policy might never be settleable`
    );
  }
  const { n, k, probability, premium } = priceFromHistory(delays, threshold, payout);
  log(`${k} of ${n} observed flights were ${threshold}+ min late -> P(delay) = (${k}+1)/(${n}+2) = ${probability.toFixed(3)}`);
  log(`Premium: ${aUSD(payout)} x ${probability.toFixed(3)} x 1.2 = ${aUSD(premium)}`);
  //    At P(delay) above 1/1.2 the premium would reach the payout: nobody should pay that, so do not sell it.
  if (premium >= payout) throw new Error(`Not selling: the premium ${aUSD(premium)} would not be below the payout`);

  //    A short validity leaves no time to wait for delay news before buying.
  const QUOTE_VALIDITY = 10 * 60;
  const q = {
    holder: account.address,
    flightNumber,
    dateLocal,
    premium,
    payout,
    delayThresholdMinutes: BigInt(threshold),
    validUntil: BigInt(Math.min(now + QUOTE_VALIDITY, salesClose - 1)),
    nonce: BigInt(Date.now()),
  };
  const quoteHash = (await publicClient.readContract({
    address: FLIGHTGUARD,
    abi,
    functionName: 'hashQuote',
    args: [q],
  })) as Hex;
  const signature = await account.signMessage({ message: { raw: quoteHash } });
  writeFileSync(
    QUOTE_FILE,
    JSON.stringify({ quote: q, signature, pricing: { observed: n, delayed: k, probability } }, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v, 2)
  );
  log(`Signed quote saved to ${QUOTE_FILE}, valid until ${new Date(Number(q.validUntil) * 1000).toISOString()}`);
}

// ---------------------------------------------------------------- buying

async function buy() {
  const { quote: raw, signature } = JSON.parse(readFileSync(QUOTE_FILE, 'utf8'));
  const q = {
    ...raw,
    premium: BigInt(raw.premium),
    payout: BigInt(raw.payout),
    delayThresholdMinutes: BigInt(raw.delayThresholdMinutes),
    validUntil: BigInt(raw.validUntil),
    nonce: BigInt(raw.nonce),
  };
  log(`Buying ${q.flightNumber} ${q.dateLocal}: premium ${aUSD(q.premium)}, payout ${aUSD(q.payout)}`);

  const allowance = await publicClient.readContract({
    address: AUSD,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, FLIGHTGUARD],
  });
  if (allowance < q.premium) {
    // Approve exactly the premium, not an unlimited amount
    const hash = await walletClient.writeContract({
      address: AUSD,
      abi: erc20Abi,
      functionName: 'approve',
      args: [FLIGHTGUARD, q.premium],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`Approved ${aUSD(q.premium)}: ${EXPLORER}/tx/${hash}`);
  }

  const hash = await walletClient.writeContract({ address: FLIGHTGUARD, abi, functionName: 'buyPolicy', args: [q, signature] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`buyPolicy reverted: ${EXPLORER}/tx/${hash}`);
  const count = (await publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'policyCount' })) as bigint;
  log(`Policy #${count - 1n} bought: ${EXPLORER}/tx/${hash}`);
}

// ---------------------------------------------------------------- settling

type PolicyTuple = [Address, Hex, bigint, bigint, bigint, number, string, string];

const readPolicies = async () => {
  const count = (await publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'policyCount' })) as bigint;
  const policies = [];
  for (let id = 0n; id < count; id++) {
    const p = (await publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'policies', args: [id] })) as PolicyTuple;
    policies.push({ id, holder: p[0], payout: p[2], threshold: p[3], settleBy: p[4], status: p[5], flightNumber: p[6], dateLocal: p[7] });
  }
  return policies;
};

async function keeper(responseFile?: string) {
  const active = (await readPolicies()).filter((p) => STATUS[p.status] === 'Active');
  log(`${active.length} active ${active.length === 1 ? 'policy' : 'policies'}`);
  const payingFetch = createScriptFetch();

  for (const p of active) {
    log(`Policy #${p.id}: ${p.flightNumber} on ${p.dateLocal}, pays ${aUSD(p.payout)} if ${p.threshold}+ min late`);
    let signed: SignedResponse;
    try {
      signed = responseFile
        ? JSON.parse(readFileSync(responseFile, 'utf8'))
        : await fetchSignedFlight(p.flightNumber, p.dateLocal, payingFetch);
    } catch (error) {
      log(`  no signed data yet (${(error as Error).message.slice(0, 80)}), will retry later`);
      continue;
    }
    // Check off-chain first, so a response the contract would reject does not cost gas
    await verifySignedResponse(signed, AERODATABOX_ADDRESS, deriveFlightRequestHash(p.flightNumber, p.dateLocal));
    const data = JSON.parse(signed.data);
    if (data.status !== 'Arrived') {
      log(`  status ${data.status}, not landed yet, will retry later`);
      continue;
    }
    const delay = Math.max(0, Math.round((parseUtc(data.actualArrival) - parseUtc(data.scheduledArrival)) / 60_000));
    log(`  signed by AeroDataBox: arrived ${data.actualArrival}, scheduled ${data.scheduledArrival} -> ${delay} min late`);

    const hash = await walletClient.writeContract({
      address: FLIGHTGUARD,
      abi,
      functionName: 'settle',
      args: [p.id, BigInt(signed.timestamp), toHex(signed.data), signed.signature],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`settle reverted: ${EXPLORER}/tx/${hash}`);
    log(`  ${delay >= Number(p.threshold) ? `PAID OUT ${aUSD(p.payout)} to ${p.holder}` : 'on time, closed without payout'}`);
    log(`  ${EXPLORER}/tx/${hash}`);
  }
}

async function status() {
  const [pool, reserved] = await Promise.all([
    publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: 'balanceOf', args: [FLIGHTGUARD] }),
    publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'totalReserved' }) as Promise<bigint>,
  ]);
  log(`FlightGuard ${FLIGHTGUARD}: pool ${aUSD(pool)}, reserved ${aUSD(reserved)}`);
  for (const p of await readPolicies()) {
    log(`  #${p.id} ${p.flightNumber} ${p.dateLocal} payout ${aUSD(p.payout)} threshold ${p.threshold} min: ${STATUS[p.status]}`);
  }
}

/** The underwriter takes back everything in the pool that is not reserved for active policies */
async function withdraw() {
  const available = (await publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'availableLiquidity' })) as bigint;
  if (available === 0n) return log('Nothing to withdraw');
  const hash = await walletClient.writeContract({ address: FLIGHTGUARD, abi, functionName: 'withdraw', args: [available] });
  await publicClient.waitForTransactionReceipt({ hash });
  log(`Withdrew ${aUSD(available)} from ${FLIGHTGUARD}: ${EXPLORER}/tx/${hash}`);
}

// ---------------------------------------------------------------- main

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'quote') await quote(...(args as [string, string]));
  else if (command === 'buy') await buy();
  else if (command === 'keeper') await keeper(args[0] === '--file' ? args[1] : undefined);
  else if (command === 'status') await status();
  else if (command === 'withdraw') await withdraw();
  else console.log('Usage: src/agent.ts quote <flight> <YYYY-MM-DD> [payout] [threshold min] [days] | buy | keeper | status | withdraw');
}
