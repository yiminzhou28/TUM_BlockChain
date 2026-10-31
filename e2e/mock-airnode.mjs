// Test only. Loaded with `node --import` into the agent by e2e/run.mjs, it stands in for the AeroDataBox Airnode:
// it answers flightStatusOnDate, flightDates and airportSchedule from a world file that the test edits as flights
// depart, land or are cancelled, projects and signs the answers the way the Airnode does (with a local test key), and
// serves the document whose x-airnode.address the agent checks. It also moves the clock of the process by the offset in
// the world file, so that the agent, these signatures and the local chain all agree on the time.
import { readFileSync } from 'node:fs';
import { encodePacked, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const WORLD = process.env.MOCK_WORLD;
if (!WORLD) throw new Error('MOCK_WORLD is not set');
const AIRNODE_URL = 'https://airnode-aerodatabox.fly.dev/';

const RealDate = Date;
let cached;
let cachedAt = 0;
const world = () => {
  const now = RealDate.now();
  if (!cached || now - cachedAt > 100) {
    cached = JSON.parse(readFileSync(WORLD, 'utf8'));
    cachedAt = now;
  }
  return cached;
};

// ---------------------------------------------------------------- the clock
const offsetMs = () => (world().offset ?? 0) * 1000;
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offsetMs());
    else super(...args);
  }
  static now() {
    return RealDate.now() + offsetMs();
  }
}
globalThis.Date = ShiftedDate;

// ---------------------------------------------------------------- signing, as the Airnode does
const compareUtf8 = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.entries(value)
    .sort(([a], [b]) => compareUtf8(a, b))
    .map(([key, nested]) => [key, canonicalize(nested)]);
};
const deriveRequestHash = ({ operation, parameters, responseProjection }) => {
  const request = [operation, canonicalize(parameters)];
  return keccak256(
    toHex(JSON.stringify(responseProjection ? [...request, canonicalize(responseProjection)] : request))
  );
};
const readPointer = (document, pointer) =>
  pointer
    .split('/')
    .slice(1)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, token) => (value === null || value === undefined ? undefined : value[token]), document);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const sign = async (request, data) => {
  const w = world();
  const account = privateKeyToAccount(w.signerKey);
  const requestHash = deriveRequestHash(request);
  const timestamp = String(Math.floor(Date.now() / 1000) - (w.responseAgeSeconds ?? 0));
  const digest = keccak256(
    encodePacked(['bytes32', 'uint256', 'bytes'], [requestHash, BigInt(timestamp), toHex(data)])
  );
  const signature = await account.signMessage({ message: { raw: digest } });
  return { airnode: account.address, requestHash, timestamp, data, signature };
};

// ---------------------------------------------------------------- the flights
const shiftDate = (date, days) => {
  const d = new RealDate(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const spaced = (number) => number.replace(/^([A-Z0-9]{2})(\d+)$/, '$1 $2');
const local = (utc) => `${utc.slice(0, 16)}+00:00`;

const flightObject = (number, f) => ({
  number: spaced(number),
  status: f.status,
  departure: {
    airport: { iata: f.from },
    scheduledTime: { utc: f.dep, local: local(f.dep) },
    ...(f.depRevised ? { revisedTime: { utc: f.depRevised, local: local(f.depRevised) } } : {}),
  },
  arrival: {
    airport: { iata: f.to },
    scheduledTime: { utc: f.arr, local: local(f.arr) },
    ...(f.arrRevised ? { revisedTime: { utc: f.arrRevised, local: local(f.arrRevised) } } : {}),
  },
});

// Minutes late in successive weeks, for a weekly flight with a mixed record
const LATE_BY_WEEK = [3, 40, 0, 12, 0, 2, 25];
// A past flight that is not in the world: it arrived, as late as its history says
const pastFlight = (number, day, history) => {
  if (history === 'none') return undefined;
  const week = Math.floor(RealDate.parse(`${day}T12:00:00Z`) / (7 * 86_400_000));
  const late = history === 'late' ? 40 : history === 'ontime' ? 0 : LATE_BY_WEEK[week % LATE_BY_WEEK.length];
  const arr = `${day} 08:00Z`;
  const minutes = String(late % 60).padStart(2, '0');
  const arrRevised =
    history === 'noarrival' ? undefined : `${day} ${String(8 + Math.floor(late / 60)).padStart(2, '0')}:${minutes}Z`;
  return flightObject(number, { status: 'Arrived', from: 'MUC', to: 'PMI', dep: `${day} 06:00Z`, arr, arrRevised });
};

const flightsNamed = (number) => Object.entries(world().flights ?? {}).filter(([key]) => key.startsWith(`${number}|`));

const fullResponse = ({ operation, parameters }) => {
  if (operation === 'flightDates') {
    // The departures of the flight in the six weeks before its date in the world, and the next one
    const [key] = flightsNamed(parameters.searchParam)[0] ?? [];
    if (!key) return [];
    const date = key.split('|')[1];
    return [-42, -35, -28, -21, -14, -7, 7].map((days) => shiftDate(date, days));
  }
  if (operation === 'flightStatusOnDate') {
    const { searchParam: number, dateLocal } = parameters;
    const f = world().flights?.[`${number}|${dateLocal}`];
    if (f) return f.missing ? undefined : [flightObject(number, f)];
    const sibling = flightsNamed(number)[0]?.[1];
    if (!sibling || dateLocal >= flightsNamed(number)[0][0].split('|')[1]) return undefined;
    const past = pastFlight(number, dateLocal, sibling.history ?? 'mixed');
    return past ? [past] : undefined;
  }
  if (operation === 'airportSchedule') {
    const departures = Object.entries(world().flights ?? {})
      .filter(([, f]) => f.from === parameters.code && !f.missing)
      .map(([key, f]) => {
        const number = key.split('|')[0];
        return {
          number: spaced(number),
          status: f.status,
          movement: { airport: { iata: f.to }, scheduledTime: { utc: f.dep, local: local(f.dep) } },
        };
      });
    return { departures };
  }
  throw new Error(`unknown operation ${operation}`);
};

// ---------------------------------------------------------------- the Airnode
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(AIRNODE_URL)) return realFetch(input, init);
  const w = world();
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'GET') {
    if (w.documentDown) return json({ error: 'unavailable' }, 503);
    return json({ openapi: '3.1.0', info: { title: 'AeroDataBox (test)' }, 'x-airnode': { address: w.published } });
  }
  if (w.down) return new Response('upstream error', { status: 502 });
  const request = JSON.parse(init?.body ?? (await input.clone().text()));
  const full = fullResponse(request);
  let data = full === undefined ? '' : JSON.stringify(full);
  if (request.responseProjection) {
    // As the Airnode does: fields sorted by name, and nothing signed if a pointer finds nothing
    const projected = {};
    for (const [field, pointer] of Object.entries(request.responseProjection).sort(([a], [b]) => compareUtf8(a, b))) {
      const value = full === undefined ? undefined : readPointer(full, pointer);
      if (value === undefined) return json({ error: `The response has no value at ${pointer}` }, 400);
      projected[field] = value;
    }
    data = JSON.stringify(projected);
  }
  return json(await sign(request, data));
};
