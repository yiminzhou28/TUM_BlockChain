// Fetches the signed response that FlightGuard settles with, verifies it and saves it to test/fixtures.
//   node --env-file=.env src/fetch-flight.ts LH400 2026-10-29            the arrival request, for settle()
//   node --env-file=.env src/fetch-flight.ts LH400 2026-10-29 --status   the status request, for settleCancelledOrDiverted()
import { writeFileSync } from 'node:fs';
import { verifySignedResponse } from './airnode-v2.ts';
import {
  AERODATABOX_ADDRESS,
  deriveFlightRequestHash,
  deriveFlightStatusRequestHash,
  fetchSignedFlight,
  fetchSignedFlightStatus,
} from './flight.ts';
import { createScriptFetch } from './script-options.ts';

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const [flightNumber = 'LH400', dateLocal = '2026-10-29'] = args.filter((arg) => !arg.startsWith('--'));

const signed = statusOnly
  ? await fetchSignedFlightStatus(flightNumber, dateLocal, createScriptFetch())
  : await fetchSignedFlight(flightNumber, dateLocal, createScriptFetch());
const requestHash = statusOnly
  ? deriveFlightStatusRequestHash(flightNumber, dateLocal)
  : deriveFlightRequestHash(flightNumber, dateLocal);
await verifySignedResponse(signed, AERODATABOX_ADDRESS, requestHash);

const file = `test/fixtures/${statusOnly ? 'status' : 'flight'}-${flightNumber}-${dateLocal}.json`;
writeFileSync(file, `${JSON.stringify(signed, null, 2)}\n`);
console.log(JSON.stringify(signed, null, 2));
console.log(`Signature OK, saved to ${file}`);
