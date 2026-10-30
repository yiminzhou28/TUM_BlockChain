// Fetches the signed, projected status of a flight, the exact response FlightGuard.settle takes, verifies it and
// saves it to test/fixtures. Usage: node --env-file=.env src/fetch-flight.ts LH400 2026-10-29
import { writeFileSync } from 'node:fs';
import { verifySignedResponse } from './airnode-v2.ts';
import { AERODATABOX_ADDRESS, deriveFlightRequestHash, fetchSignedFlight } from './flight.ts';
import { createScriptFetch } from './script-options.ts';

const [flightNumber = 'LH400', dateLocal = '2026-10-29'] = process.argv.slice(2);

const signed = await fetchSignedFlight(flightNumber, dateLocal, createScriptFetch());
await verifySignedResponse(signed, AERODATABOX_ADDRESS, deriveFlightRequestHash(flightNumber, dateLocal));

const file = `test/fixtures/flight-${flightNumber}-${dateLocal}.json`;
writeFileSync(file, `${JSON.stringify(signed, null, 2)}\n`);
console.log(JSON.stringify(signed, null, 2));
console.log(`Signature OK, saved to ${file}`);
