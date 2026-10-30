// FlightGuard agent: prices policies from flight history it buys over x402, signs quotes, buys policies and settles
// them with signed AeroDataBox data.
//
//   node --env-file=.env src/agent.ts quote LH400 2026-10-29 [payout aUSD] [threshold minutes] [history days]
//   node --env-file=.env src/agent.ts buy
//   node --env-file=.env src/agent.ts keeper
//   node --env-file=.env src/agent.ts status
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

const FLIGHTGUARD = (process.env.FLIGHTGUARD_ADDRESS ?? '0x1Ff69Fd5D73cA61095421E6c67aDB5AF0479976A') as Address;
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

/** Arrival delay in minutes of the operating flight in a full AeroDataBox response, or undefined if unknown */
export const arrivalDelayMinutes = (flights: unknown): number | undefined => {
  const flight = Array.isArray(flights) ? flights[0] : undefined;
  if (flight?.status !== 'Arrived') return undefined;
  const scheduled = flight.arrival?.scheduledTime?.utc;
  const actual = flight.arrival?.revisedTime?.utc;
  if (!scheduled || !actual) return undefined;
  return Math.max(0, Math.round((parseUtc(actual) - parseUtc(scheduled)) / 60_000));
};

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

async function quote(flightNumber: string, dateLocal: string, payoutText = '2', thresholdText = '120', daysText = '5') {
  const payout = parseUnits(payoutText, 6);
  const threshold = Number(thresholdText);
  const days = Number(daysText);
  const payingFetch = createScriptFetch();

  log(`Pricing ${flightNumber} on ${dateLocal}: payout ${aUSD(payout)} if ${threshold}+ min late`);
  log(`Buying ${days} days of history from AeroDataBox over x402 (0.05 aUSD per call)`);
  const delays: number[] = [];
  for (let i = 1; i <= days; i++) {
    const day = shiftDate(dateLocal, -i);
    const request: AirnodeV2Request = {
      operation: 'flightStatusOnDate',
      parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal: day },
    };
    try {
      const signed = await fetchSignedResponse(AERODATABOX_URL, request, payingFetch);
      const delay = signed.data ? arrivalDelayMinutes(JSON.parse(signed.data)) : undefined;
      log(`  ${day}: ${delay === undefined ? 'no arrival data' : `${delay} min late`}`);
      if (delay !== undefined) delays.push(delay);
    } catch (error) {
      log(`  ${day}: skipped (${(error as Error).message.slice(0, 80)})`);
    }
  }

  const { n, k, probability, premium } = priceFromHistory(delays, threshold, payout);
  log(`${k} of ${n} observed flights were ${threshold}+ min late -> P(delay) = ${probability.toFixed(3)}`);
  log(`Premium: ${aUSD(premium)}`);

  const q = {
    holder: account.address,
    flightNumber,
    dateLocal,
    premium,
    payout,
    delayThresholdMinutes: BigInt(threshold),
    validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
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
  log(`Signed quote saved to ${QUOTE_FILE}`);
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
    const hash = await walletClient.writeContract({
      address: AUSD,
      abi: erc20Abi,
      functionName: 'approve',
      args: [FLIGHTGUARD, 2n ** 256n - 1n],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`Approved aUSD: ${EXPLORER}/tx/${hash}`);
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

// ---------------------------------------------------------------- main

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'quote') await quote(...(args as [string, string]));
  else if (command === 'buy') await buy();
  else if (command === 'keeper') await keeper(args[0] === '--file' ? args[1] : undefined);
  else if (command === 'status') await status();
  else console.log('Usage: src/agent.ts quote <flight> <YYYY-MM-DD> [payout] [threshold min] [days] | buy | keeper | status');
}