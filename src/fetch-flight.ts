// Fetches a signed response that FlightGuard accepts, verifies it and saves it to test/fixtures.
//   node --env-file=.env src/fetch-flight.ts LH400 2026-10-29            the arrival request, for settle()
//   node --env-file=.env src/fetch-flight.ts LH400 2026-10-29 --status   the status request, for settleCancelledOrDiverted()
//   node --env-file=.env src/fetch-flight.ts DE1130 2026-10-31 --sale    the sale request, for buyPolicy(): run it at least
//                                                                        2 h before departure, saved as sale-proof.json
import { writeFileSync } from 'node:fs';
import { verifySignedResponse } from './airnode-v2.ts';
import {
  AERODATABOX_ADDRESS,
  deriveFlightRequestHash,
  deriveFlightSaleRequestHash,
  deriveFlightStatusRequestHash,
  fetchSignedFlight,
  fetchSignedFlightSale,
  fetchSignedFlightStatus,
} from './flight.ts';
import { parseUtc } from './pricing.ts';
import { createScriptFetch } from './script-options.ts';

const args = process.argv.slice(2);
const kind = args.includes('--sale') ? 'sale' : args.includes('--status') ? 'status' : 'flight';
const [flightNumber = 'LH400', dateLocal = '2026-10-29'] = args.filter((arg) => !arg.startsWith('--'));

const fetchers = { flight: fetchSignedFlight, status: fetchSignedFlightStatus, sale: fetchSignedFlightSale };
const hashes = {
  flight: deriveFlightRequestHash,
  status: deriveFlightStatusRequestHash,
  sale: deriveFlightSaleRequestHash,
};

const signed = await fetchers[kind](flightNumber, dateLocal, createScriptFetch());
await verifySignedResponse(signed, AERODATABOX_ADDRESS, hashes[kind](flightNumber, dateLocal));
console.log(JSON.stringify(signed, null, 2));

if (kind === 'sale') {
  // The contract only accepts a proof of sale for a flight that is still expected and at least 2 h from departure
  const { status, scheduledDeparture } = JSON.parse(signed.data);
  const hoursLeft = (parseUtc(scheduledDeparture) / 1000 - Number(signed.timestamp)) / 3600;
  if (!['Expected', 'CheckIn'].includes(status) || hoursLeft < 2) {
    console.log(
      `Not saved: status ${status}, ${hoursLeft.toFixed(1)} h before departure. A proof of sale needs Expected or CheckIn and 2+ h.`
    );
    process.exit(1);
  }
}

const file =
  kind === 'sale' ? 'test/fixtures/sale-proof.json' : `test/fixtures/${kind}-${flightNumber}-${dateLocal}.json`;
const saved = kind === 'sale' ? { flightNumber, dateLocal, ...signed } : signed;
writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
console.log(`Signature OK, saved to ${file}`);
