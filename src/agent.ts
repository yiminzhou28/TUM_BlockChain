// FlightGuard agent. The underwriter prices flights from history it buys over x402 and signs quotes, the traveller
// buys policies with them, and the keeper settles policies with signed AeroDataBox data, on its own in watch mode.
//
//   node --env-file=.env src/agent.ts quote <flight> <YYYY-MM-DD> [payout aUSD] [threshold minutes] [history flights]
//   node --env-file=.env src/agent.ts buy
//   node --env-file=.env src/agent.ts keeper
//   node --env-file=.env src/agent.ts watch [hours]
//   node --env-file=.env src/agent.ts status
//   node --env-file=.env src/agent.ts fund-traveller [aUSD] [ETH]
//   node --env-file=.env src/agent.ts withdraw
//
// PAYER_PRIVATE_KEY is the underwriter: it owns the pool, pays for data, signs quotes and sends settlements.
// TRAVELLER_PRIVATE_KEY, if set, is the traveller who buys policies and receives payouts. Without it the underwriter
// buys as well.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  type Hex,
  http,
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
  deriveFlightStatusRequestHash,
  fetchSignedFlight,
  fetchSignedFlightStatus,
} from './flight.ts';
import {
  arrivalDelay,
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

const FLIGHTGUARD = (process.env.FLIGHTGUARD_ADDRESS ?? '0x170ED8eeAD82B1a56d7d00938E94b8200Db801B1') as Address;
const AUSD: Address = '0xbeA34973e5f67F18F656A2C6070C64326C791808';
const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const EXPLORER = process.env.EXPLORER ?? 'https://sepolia.basescan.org';
const STATUS = ['None', 'Active', 'PaidOut', 'ClosedOnTime', 'Expired'];

// Local state, kept out of git
const QUOTE_FILE = 'quote.json'; // the last signed quote, for buy
const HISTORY_FILE = 'flight-history.json'; // every past flight outcome the agent bought, reused for pricing
const SCHEDULE_FILE = 'schedule.json'; // scheduled arrival of each quoted flight, so watch knows when to look

const { abi } = JSON.parse(readFileSync('out/FlightGuard.sol/FlightGuard.json', 'utf8'));
if (!process.env.PAYER_PRIVATE_KEY) throw new Error('Set PAYER_PRIVATE_KEY in .env');
const underwriter = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as Hex);
const traveller = process.env.TRAVELLER_PRIVATE_KEY
  ? privateKeyToAccount(process.env.TRAVELLER_PRIVATE_KEY as Hex)
  : underwriter;
const chain = { ...baseSepolia, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const underwriterWallet = createWalletClient({ account: underwriter, chain, transport: http(RPC) });
const travellerWallet = createWalletClient({ account: traveller, chain, transport: http(RPC) });

const aUSD = (amount: bigint) => `${formatUnits(amount, 6)} aUSD`;
const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
const reason = (error: unknown) => ((error as Error).message.split('\n')[0] ?? '').slice(0, 90);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args: unknown[]) => console.log('[agent]', ...args);
const readJson = <T>(file: string, fallback: T): T => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
const balanceOf = (owner: Address) =>
  publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });

// ---------------------------------------------------------------- policies on chain

type PolicyTuple = [Address, Hex, bigint, bigint, bigint, number, string, string];
type Policy = Awaited<ReturnType<typeof readPolicies>>[number];

async function readPolicies() {
  const count = (await publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'policyCount' })) as bigint;
  const policies = [];
  for (let id = 0n; id < count; id++) {
    const p = (await publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'policies', args: [id] })) as PolicyTuple;
    policies.push({ id, holder: p[0], payout: p[2], threshold: p[3], settleBy: p[4], status: STATUS[p[5]], flightNumber: p[6], dateLocal: p[7] });
  }
  return policies;
}

const sum = (amounts: bigint[]) => amounts.reduce((a, b) => a + b, 0n);

// ---------------------------------------------------------------- quoting (underwriter)

async function quote(flightText: string, dateLocal: string, payoutText = '2', thresholdText = '120', countText = '5') {
  const flightNumber = flightText.toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z0-9]{3,8}$/.test(flightNumber)) throw new Error(`Flight number ${flightText} is not like LH400`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateLocal)) throw new Error(`Date ${dateLocal} is not YYYY-MM-DD`);
  const payout = parseUnits(payoutText, 6);
  const threshold = Number(thresholdText);
  const count = Number(countText);
  if (payout <= 0n) throw new Error(`Payout ${payoutText} must be more than 0`);
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error(`Threshold ${thresholdText} must be whole minutes, at least 1`);
  if (!Number.isInteger(count) || count < 2 || count > 14) throw new Error(`History ${countText} must be 2 to 14 flights`);
  const payingFetch = createScriptFetch();

  // 1. Is the flight still sellable? Buy its schedule and stop if it has departed, is known to be late, or leaves
  //    within 2 hours. The quote expires before that, and the contract enforces the expiry.
  const SALES_CLOSE_BEFORE_DEPARTURE = 2 * 3600;
  const SELLABLE_STATUSES = ['Expected', 'Unknown', 'CheckIn'];
  log(`Checking the schedule of ${flightNumber} departing ${dateLocal} (0.05 aUSD)`);
  const schedule = await fetchSignedResponse(
    AERODATABOX_URL,
    { operation: 'flightStatusOnDate', parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal, dateLocalRole: 'Departure' } },
    payingFetch
  );
  const flight = schedule.data ? JSON.parse(schedule.data)[0] : undefined;
  const scheduledDeparture = flight?.departure?.scheduledTime?.utc;
  if (!flight || !scheduledDeparture) throw new Error(`AeroDataBox has no ${flightNumber} departing ${dateLocal}`);
  const departureAt = Math.floor(parseUtc(scheduledDeparture) / 1000);
  const revisedDeparture = flight.departure?.revisedTime?.utc;
  const knownDelayMinutes = revisedDeparture ? Math.round((parseUtc(revisedDeparture) - departureAt * 1000) / 60_000) : 0;
  const scheduledArrival = flight.arrival?.scheduledTime?.utc;
  log(`  ${flight.departure.airport?.iata} -> ${flight.arrival?.airport?.iata}, departs ${scheduledDeparture}, arrives ${scheduledArrival}, status ${flight.status}`);
  if (!SELLABLE_STATUSES.includes(flight.status)) throw new Error(`Not selling: status is ${flight.status}`);
  if (knownDelayMinutes >= 15) throw new Error(`Not selling: departure already revised ${knownDelayMinutes} min late`);
  const now = nowSeconds();
  const salesClose = departureAt - SALES_CLOSE_BEFORE_DEPARTURE;
  if (now >= salesClose) throw new Error(`Not selling: sales closed at ${iso(salesClose)}, 2 h before departure`);
  if (scheduledArrival) writeJson(SCHEDULE_FILE, { ...readJson(SCHEDULE_FILE, {}), [`${flightNumber}|${dateLocal}`]: scheduledArrival });

  // 2. Is there room in the pool? One strike or storm hits every policy on a flight, and often every flight on a day.
  const [pool, policies] = await Promise.all([balanceOf(FLIGHTGUARD), readPolicies()]);
  const active = policies.filter((p) => p.status === 'Active');
  const problem = exposureProblem({
    pool,
    flightReserved: sum(active.filter((p) => p.flightNumber === flightNumber && p.dateLocal === dateLocal).map((p) => p.payout)),
    dateReserved: sum(active.filter((p) => p.dateLocal === dateLocal).map((p) => p.payout)),
    payout,
  });
  if (problem) throw new Error(`Not selling: ${problem}`);

  // 3. Which past dates did the flight operate on? A flight that runs a few days a week has no flight on most calendar
  //    days, so ask flightDates and price from the flight's own last departures.
  log(`Pricing ${flightNumber} on ${dateLocal}: payout ${aUSD(payout)} if ${threshold}+ min late, cancelled or diverted`);
  const today = new Date().toISOString().slice(0, 10);
  let history: string[] = [];
  log(`Looking up the dates ${flightNumber} operated on (0.05 aUSD)`);
  try {
    const operated = await fetchSignedResponse(
      AERODATABOX_URL,
      { operation: 'flightDates', parameters: { searchBy: 'number', searchParam: flightNumber } },
      payingFetch
    );
    history = datesIn(operated.data ?? '').filter((d) => d < today).slice(0, count);
  } catch (error) {
    log(`  flightDates failed (${reason(error)})`);
  }
  if (history.length === 0) {
    history = Array.from({ length: count }, (_, i) => shiftDate(today, -(i + 1)));
    log(`  no past dates found, using the last ${count} calendar days`);
  } else {
    log(`  last ${history.length} departures: ${history.join(', ')}`);
  }

  // 4. How did those flights go? From the agent's own history if it bought them before, otherwise over x402.
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

  // 5. Sell only what can be settled. The contract settles from the arrival revisedTime; if AeroDataBox did not report
  //    one for this flight's recent arrivals, it may not report one this time either.
  if (delays.length < MIN_OBSERVED_ARRIVALS) {
    throw new Error(
      `Not selling: only ${delays.length} of ${history.length} past flights have an actual arrival time in AeroDataBox, ` +
        'so this policy might never be settleable'
    );
  }

  // 6. Price: the flight's own record, shrunk toward every other flight the agent has observed (empirical Bayes).
  const otherFlights = Object.entries(cache)
    .filter(([key, outcome]) => !key.startsWith(`${flightNumber}|`) && outcome.minutes !== undefined)
    .map(([, outcome]) => outcome.minutes as number);
  const prior = populationPrior(otherFlights, threshold);
  const { n, k, probability, premium } = priceFromHistory(delays, threshold, payout, prior);
  log(`Prior: ${prior.source} -> mean ${prior.mean.toFixed(3)}, worth ${prior.strength} flights`);
  log(`${k} of ${n} of its own flights were ${threshold}+ min late -> P(delay) = (${k} + ${prior.strength} x ${prior.mean.toFixed(3)}) / (${n} + ${prior.strength}) = ${probability.toFixed(3)}`);
  log(`Premium: ${aUSD(payout)} x ${probability.toFixed(3)} x 1.2 = ${aUSD(premium)}`);
  if (premium >= payout) throw new Error(`Not selling: the premium ${aUSD(premium)} would not be below the payout`);

  // 7. Sign the quote for the traveller. It is valid for 10 minutes, so there is no time to wait for delay news.
  const QUOTE_VALIDITY = 10 * 60;
  const q = {
    holder: traveller.address,
    flightNumber,
    dateLocal,
    premium,
    payout,
    delayThresholdMinutes: BigInt(threshold),
    validUntil: BigInt(Math.min(now + QUOTE_VALIDITY, salesClose - 1)),
    nonce: BigInt(Date.now()),
  };
  const quoteHash = (await publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'hashQuote', args: [q] })) as Hex;
  const signature = await underwriter.signMessage({ message: { raw: quoteHash } });
  writeJson(QUOTE_FILE, { quote: q, signature, pricing: { observed: n, delayed: k, probability, prior } });
  log(`Signed by underwriter ${short(underwriter.address)} for traveller ${short(traveller.address)}, valid until ${iso(Number(q.validUntil))}. Saved to ${QUOTE_FILE}`);
}

// ---------------------------------------------------------------- buying (traveller)

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
  if (q.holder.toLowerCase() !== traveller.address.toLowerCase()) {
    throw new Error(`The quote is for ${q.holder}, but TRAVELLER_PRIVATE_KEY is ${traveller.address}. Quote again.`);
  }
  log(`Traveller ${short(traveller.address)} buys ${q.flightNumber} ${q.dateLocal}: premium ${aUSD(q.premium)}, payout ${aUSD(q.payout)}`);

  const allowance = await publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: 'allowance', args: [traveller.address, FLIGHTGUARD] });
  if (allowance < q.premium) {
    // Approve exactly the premium, not an unlimited amount
    const hash = await travellerWallet.writeContract({ address: AUSD, abi: erc20Abi, functionName: 'approve', args: [FLIGHTGUARD, q.premium] });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`Approved ${aUSD(q.premium)}: ${EXPLORER}/tx/${hash}`);
  }
  const hash = await travellerWallet.writeContract({ address: FLIGHTGUARD, abi, functionName: 'buyPolicy', args: [q, signature] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`buyPolicy reverted: ${EXPLORER}/tx/${hash}`);
  const count = (await publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'policyCount' })) as bigint;
  log(`Policy #${count - 1n} bought: ${EXPLORER}/tx/${hash}`);
}

// ---------------------------------------------------------------- settling (keeper, anyone can do it)

const sendSettlement = async (functionName: 'settle' | 'settleCancelledOrDiverted', id: bigint, signed: SignedResponse) => {
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

/** Tries to settle one policy. Returns when to look again, or undefined if it is settled. */
async function checkPolicy(p: Policy, payingFetch: typeof fetch): Promise<number | undefined> {
  const now = nowSeconds();
  log(`Policy #${p.id}: ${p.flightNumber} departing ${p.dateLocal}, pays ${aUSD(p.payout)} to ${short(p.holder)} if ${p.threshold}+ min late, cancelled or diverted`);

  if (BigInt(now) > p.settleBy) {
    const hash = await underwriterWallet.writeContract({ address: FLIGHTGUARD, abi, functionName: 'expire', args: [p.id] });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`  settlement window over, expired and reserve released: ${EXPLORER}/tx/${hash}`);
    return undefined;
  }

  // 1. The arrival request: the actual arrival time against the scheduled one
  try {
    const signed = await fetchSignedFlight(p.flightNumber, p.dateLocal, payingFetch);
    // Check off-chain first, so a response the contract would reject does not cost gas
    await verifySignedResponse(signed, AERODATABOX_ADDRESS, deriveFlightRequestHash(p.flightNumber, p.dateLocal));
    const data = JSON.parse(signed.data);
    if (data.status === 'Arrived') {
      const delay = Math.max(0, Math.floor((parseUtc(data.actualArrival) - parseUtc(data.scheduledArrival)) / 60_000));
      log(`  signed by AeroDataBox: arrived ${data.actualArrival}, scheduled ${data.scheduledArrival} -> ${delay} min late`);
      const tx = await sendSettlement('settle', p.id, signed);
      log(`  ${delay >= Number(p.threshold) ? `PAID OUT ${aUSD(p.payout)} to ${short(p.holder)}` : 'on time, closed without payout'}: ${tx}`);
      return undefined;
    }
    if (data.status !== 'Canceled' && data.status !== 'Diverted') {
      const estimate = Math.floor(parseUtc(data.actualArrival) / 1000);
      log(`  status ${data.status}, expected to arrive ${data.actualArrival}`);
      return Number.isNaN(estimate) ? now + RECHECK_WITHOUT_ESTIMATE : Math.max(estimate, now) + RECHECK_AFTER_ESTIMATE;
    }
  } catch (error) {
    log(`  no arrival time yet (${reason(error)})`);
  }

  // 2. The status request: a cancelled or diverted flight has no arrival time but pays out on its status
  try {
    const signed = await fetchSignedFlightStatus(p.flightNumber, p.dateLocal, payingFetch);
    await verifySignedResponse(signed, AERODATABOX_ADDRESS, deriveFlightStatusRequestHash(p.flightNumber, p.dateLocal));
    const { status } = JSON.parse(signed.data);
    if (status === 'Canceled' || status === 'Diverted') {
      log(`  signed by AeroDataBox: ${status}`);
      const tx = await sendSettlement('settleCancelledOrDiverted', p.id, signed);
      log(`  PAID OUT ${aUSD(p.payout)} to ${short(p.holder)} for a ${status.toLowerCase()} flight: ${tx}`);
      return undefined;
    }
    log(`  status ${status}`);
  } catch (error) {
    log(`  no status yet (${reason(error)})`);
  }
  return now + RECHECK_WITHOUT_ESTIMATE;
}

/** One pass over every active policy */
async function keeper() {
  const active = (await readPolicies()).filter((p) => p.status === 'Active');
  log(`${active.length} active ${active.length === 1 ? 'policy' : 'policies'}`);
  const payingFetch = createScriptFetch();
  for (const p of active) {
    try {
      const next = await checkPolicy(p, payingFetch);
      if (next !== undefined) log(`  not settled yet, look again after ${iso(next)}`);
    } catch (error) {
      log(`  failed (${reason(error)})`);
    }
  }
}

/**
 * Runs on its own: sleeps until each flight's scheduled arrival, settles it once AeroDataBox reports the arrival,
 * cancellation or diversion, and stops when no policy is left or after `hours`.
 */
async function watch(hoursText = '12') {
  const stopAt = nowSeconds() + Number(hoursText) * 3600;
  const scheduled = readJson<Record<string, string>>(SCHEDULE_FILE, {});
  const payingFetch = createScriptFetch();
  const next = new Map<string, number>();
  let announced = 0;
  log(`Watching FlightGuard ${FLIGHTGUARD} until ${iso(stopAt)}`);
  for (;;) {
    // A failed call, such as a network error or a settlement someone else sent first, must not stop the watch
    try {
      const active = (await readPolicies()).filter((p) => p.status === 'Active');
      if (active.length === 0) return log('No active policies left. Done.');
      for (const p of active) {
        const id = p.id.toString();
        if (!next.has(id)) {
          const arrival = scheduled[`${p.flightNumber}|${p.dateLocal}`];
          next.set(id, arrival ? Math.floor(parseUtc(arrival) / 1000) : nowSeconds());
          log(`Policy #${id} ${p.flightNumber}: first look ${arrival ? `at its scheduled arrival ${arrival}` : 'now'}`);
        }
        if ((next.get(id) as number) > nowSeconds()) continue;
        try {
          const again = await checkPolicy(p, payingFetch);
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
        // At most 5 minutes at a time against the wall clock, so a laptop that slept is back on time when it wakes
        await sleep(Math.min(wake - nowSeconds(), 300) * 1000);
      }
    } catch (error) {
      if (nowSeconds() > stopAt) return log('The watch window is over. Stopping.');
      log(`Could not read the policies (${reason(error)}), trying again in 1 minute`);
      await sleep(60_000);
    }
  }
}

// ---------------------------------------------------------------- pool and wallets

async function status() {
  const [pool, reserved, underwriterBalance, travellerBalance] = await Promise.all([
    balanceOf(FLIGHTGUARD),
    publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'totalReserved' }) as Promise<bigint>,
    balanceOf(underwriter.address),
    balanceOf(traveller.address),
  ]);
  log(`FlightGuard ${FLIGHTGUARD}: pool ${aUSD(pool)}, reserved ${aUSD(reserved)}`);
  log(`Underwriter ${short(underwriter.address)}: ${aUSD(underwriterBalance)}`);
  if (traveller !== underwriter) log(`Traveller ${short(traveller.address)}: ${aUSD(travellerBalance)}`);
  for (const p of await readPolicies()) {
    log(`  #${p.id} ${p.flightNumber} ${p.dateLocal} holder ${short(p.holder)} payout ${aUSD(p.payout)} threshold ${p.threshold} min: ${p.status}`);
  }
}

/** The underwriter gives the traveller aUSD for premiums and a little ETH for gas */
async function fundTraveller(aUSDText = '1.5', ethText = '0.00002') {
  if (traveller === underwriter) throw new Error('Set TRAVELLER_PRIVATE_KEY in .env first');
  const tokens = await underwriterWallet.writeContract({ address: AUSD, abi: erc20Abi, functionName: 'transfer', args: [traveller.address, parseUnits(aUSDText, 6)] });
  await publicClient.waitForTransactionReceipt({ hash: tokens });
  const gas = await underwriterWallet.sendTransaction({ to: traveller.address, value: parseEther(ethText) });
  await publicClient.waitForTransactionReceipt({ hash: gas });
  log(`Sent ${aUSDText} aUSD and ${ethText} ETH to traveller ${traveller.address}`);
}

/** The underwriter takes back everything in the pool that is not reserved for active policies */
async function withdraw() {
  const available = (await publicClient.readContract({ address: FLIGHTGUARD, abi, functionName: 'availableLiquidity' })) as bigint;
  if (available === 0n) return log('Nothing to withdraw');
  const hash = await underwriterWallet.writeContract({ address: FLIGHTGUARD, abi, functionName: 'withdraw', args: [available] });
  await publicClient.waitForTransactionReceipt({ hash });
  log(`Withdrew ${aUSD(available)} from ${FLIGHTGUARD}: ${EXPLORER}/tx/${hash}`);
}

// ---------------------------------------------------------------- main

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'quote') await quote(...(args as [string, string]));
  else if (command === 'buy') await buy();
  else if (command === 'keeper') await keeper();
  else if (command === 'watch') await watch(args[0]);
  else if (command === 'status') await status();
  else if (command === 'fund-traveller') await fundTraveller(args[0], args[1]);
  else if (command === 'withdraw') await withdraw();
  else {
    console.log(
      'Usage: src/agent.ts quote <flight> <YYYY-MM-DD> [payout] [threshold min] [history flights] | buy | keeper | ' +
        'watch [hours] | status | fund-traveller [aUSD] [ETH] | withdraw'
    );
  }
}
