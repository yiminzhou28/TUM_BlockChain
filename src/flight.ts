import type { Address } from 'viem';
import { type AirnodeV2Request, deriveRequestHash, fetchSignedResponse } from './airnode-v2.ts';

export const AERODATABOX_URL = 'https://airnode-aerodatabox.fly.dev/';
// From the x-airnode extension of GET / on the Airnode. checkPublishedSigner compares it with what the Airnode
// publishes now.
export const AERODATABOX_ADDRESS: Address = '0x83FE2E8F24E66520B1902C3507De4F471248f2Ec';

// The three requests FlightGuard accepts. They must match SALE_PROJECTION, PROJECTION, STATUS_PROJECTION and the
// parameters in _deriveRequestHash in contracts/FlightGuard.sol.

// The sale request, which buyPolicy() takes as proof that the flight is still expected and far enough from departure
export const SALE_PROJECTION = {
  scheduledArrival: '/0/arrival/scheduledTime/utc',
  scheduledDeparture: '/0/departure/scheduledTime/utc',
  status: '/0/status',
};

// The arrival request, which settle() takes
export const FLIGHT_PROJECTION = {
  actualArrival: '/0/arrival/revisedTime/utc',
  scheduledArrival: '/0/arrival/scheduledTime/utc',
  status: '/0/status',
};

// The status request, which settleCancelledOrDiverted() takes: a cancelled or diverted flight has no actual arrival
// time, so the arrival request fails for it
export const STATUS_PROJECTION = { status: '/0/status' };

const buildRequest = (
  flightNumber: string,
  dateLocal: string,
  projection: Record<string, string>
): AirnodeV2Request => ({
  operation: 'flightStatusOnDate',
  parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal, dateLocalRole: 'Departure' },
  responseProjection: projection,
});

export const buildFlightSaleRequest = (flightNumber: string, dateLocal: string) =>
  buildRequest(flightNumber, dateLocal, SALE_PROJECTION);

export const buildFlightRequest = (flightNumber: string, dateLocal: string) =>
  buildRequest(flightNumber, dateLocal, FLIGHT_PROJECTION);

export const buildFlightStatusRequest = (flightNumber: string, dateLocal: string) =>
  buildRequest(flightNumber, dateLocal, STATUS_PROJECTION);

export const deriveFlightSaleRequestHash = (flightNumber: string, dateLocal: string) =>
  deriveRequestHash(buildFlightSaleRequest(flightNumber, dateLocal));

export const deriveFlightRequestHash = (flightNumber: string, dateLocal: string) =>
  deriveRequestHash(buildFlightRequest(flightNumber, dateLocal));

export const deriveFlightStatusRequestHash = (flightNumber: string, dateLocal: string) =>
  deriveRequestHash(buildFlightStatusRequest(flightNumber, dateLocal));

export const fetchSignedFlightSale = (flightNumber: string, dateLocal: string, fetchFunction: typeof fetch = fetch) =>
  fetchSignedResponse(AERODATABOX_URL, buildFlightSaleRequest(flightNumber, dateLocal), fetchFunction);

export const fetchSignedFlight = (flightNumber: string, dateLocal: string, fetchFunction: typeof fetch = fetch) =>
  fetchSignedResponse(AERODATABOX_URL, buildFlightRequest(flightNumber, dateLocal), fetchFunction);

export const fetchSignedFlightStatus = (flightNumber: string, dateLocal: string, fetchFunction: typeof fetch = fetch) =>
  fetchSignedResponse(AERODATABOX_URL, buildFlightStatusRequest(flightNumber, dateLocal), fetchFunction);

/** The address the AeroDataBox Airnode publishes as its signer, from the free document at its URL */
export const fetchPublishedSigner = async (fetchFunction: typeof fetch = fetch): Promise<Address> => {
  const response = await fetchFunction(AERODATABOX_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`The Airnode document answered ${response.status}`);
  const document = (await response.json()) as { 'x-airnode'?: { address?: Address } };
  const address = document['x-airnode']?.address;
  if (!address) throw new Error('The Airnode document has no x-airnode.address');
  return address;
};
