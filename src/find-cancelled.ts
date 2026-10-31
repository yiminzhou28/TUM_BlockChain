// Finds a flight that AeroDataBox reports as cancelled, fetches its signed status (the request that
// settleCancelledOrDiverted() takes), verifies it and saves it to test/fixtures/cancelled.json, so that
// test_RealCancelledFlight_PaysOut pays a policy out with a real cancellation.
//   node --env-file=.env src/find-cancelled.ts [airport IATA codes]     default: MUC FRA
// Costs 0.05 aUSD for each airport board it reads and each flight status it fetches.
import { writeFileSync } from 'node:fs';
import { fetchSignedResponse, verifySignedResponse } from './airnode-v2.ts';
import {
  AERODATABOX_ADDRESS,
  AERODATABOX_URL,
  deriveFlightStatusRequestHash,
  fetchSignedFlightStatus,
} from './flight.ts';
import { createScriptFetch } from './script-options.ts';

const airports = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['MUC', 'FRA'];
const payingFetch = createScriptFetch();

interface BoardEntry {
  number?: string;
  status?: string;
  movement?: { scheduledTime?: { local?: string } };
  departure?: { scheduledTime?: { local?: string } };
}

for (const code of airports) {
  console.log(`Looking for cancelled departures at ${code} in the last 12 hours (0.05 aUSD)`);
  let departures: BoardEntry[] = [];
  try {
    const board = await fetchSignedResponse(
      AERODATABOX_URL,
      {
        operation: 'airportSchedule',
        parameters: {
          codeType: 'iata',
          code,
          offsetMinutes: -720,
          durationMinutes: 720,
          direction: 'Departure',
          withLeg: false,
          withCancelled: true,
          withCodeshared: false,
          withCargo: false,
          withPrivate: false,
        },
      },
      payingFetch
    );
    departures = (JSON.parse(board.data).departures ?? []) as BoardEntry[];
  } catch (error) {
    console.log(`  could not read the board (${(error as Error).message.slice(0, 120)})`);
    continue;
  }
  // The departure date local to the airport is the dateLocal that the policy and the requests use
  const cancelled = departures
    .filter((flight) => flight.status === 'Canceled')
    .map((flight) => ({
      flightNumber: String(flight.number ?? '')
        .toUpperCase()
        .replace(/\s/g, ''),
      dateLocal: String(flight.movement?.scheduledTime?.local ?? flight.departure?.scheduledTime?.local ?? '').slice(
        0,
        10
      ),
    }))
    .filter(
      ({ flightNumber, dateLocal }) => /^[A-Z0-9]{3,8}$/.test(flightNumber) && /^\d{4}-\d{2}-\d{2}$/.test(dateLocal)
    );
  console.log(`  ${departures.length} departures on the board, ${cancelled.length} cancelled`);
  if (departures.length > 0 && cancelled.length === 0 && departures.some((flight) => flight.status === 'Canceled')) {
    console.log(
      `  the board has cancellations in an unexpected shape: ${JSON.stringify(departures.find((f) => f.status === 'Canceled')).slice(0, 300)}`
    );
  }

  for (const { flightNumber, dateLocal } of cancelled.slice(0, 3)) {
    console.log(`  fetching the signed status of ${flightNumber} departing ${dateLocal} (0.05 aUSD)`);
    try {
      const signed = await fetchSignedFlightStatus(flightNumber, dateLocal, payingFetch);
      await verifySignedResponse(signed, AERODATABOX_ADDRESS, deriveFlightStatusRequestHash(flightNumber, dateLocal));
      const { status } = JSON.parse(signed.data);
      if (status !== 'Canceled') {
        console.log(`  ${flightNumber}: the signed status is ${status}, trying the next one`);
        continue;
      }
      const file = 'test/fixtures/cancelled.json';
      writeFileSync(file, `${JSON.stringify({ flightNumber, dateLocal, airport: code, ...signed }, null, 2)}\n`);
      console.log(JSON.stringify(signed, null, 2));
      console.log(
        `Signature OK: AeroDataBox signed that ${flightNumber} departing ${code} on ${dateLocal} was cancelled. Saved to ${file}`
      );
      process.exit(0);
    } catch (error) {
      console.log(`  ${flightNumber}: ${(error as Error).message.slice(0, 120)}`);
    }
  }
}
console.log(
  'No cancelled flight found. Try other airports, such as: node --env-file=.env src/find-cancelled.ts LHR CDG AMS'
);
process.exit(1);
