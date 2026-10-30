import type { Address } from 'viem';
import { type AirnodeV2Request, deriveRequestHash, fetchSignedResponse } from './airnode-v2.ts';

export const AERODATABOX_URL = 'https://airnode-aerodatabox.fly.dev/';
// From the x-airnode extension of GET / on the Airnode.
export const AERODATABOX_ADDRESS: Address = '0x83FE2E8F24E66520B1902C3507De4F471248f2Ec';

// The two requests FlightGuard accepts. They must match PROJECTION, STATUS_PROJECTION and the parameters in
// _deriveRequestHash in contracts/FlightGuard.sol.

// The arrival request, which settle() takes
export const FLIGHT_PROJECTION = {
  actualArrival: '/0/arrival/revisedTime/utc',
  scheduledArrival: '/0/arrival/scheduledTime/utc',
  status: '/0/status',
};

// The status request, which settleCancelledOrDiverted() takes: a cancelled or diverted flight has no actual arrival
// time, so the arrival request fails for it
export const STATUS_PROJECTION = { status: '/0/status' };

const buildRequest = (flightNumber: string, dateLocal: string, projection: Record<string, string>): AirnodeV2Request => ({
  operation: 'flightStatusOnDate',
  parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal, dateLocalRole: 'Departure' },
  responseProjection: projection,
});

export const buildFlightRequest = (flightNumber: string, dateLocal: string) =>
  buildRequest(flightNumber, dateLocal, FLIGHT_PROJECTION);

export const buildFlightStatusRequest = (flightNumber: string, dateLocal: string) =>
  buildRequest(flightNumber, dateLocal, STATUS_PROJECTION);

export const deriveFlightRequestHash = (flightNumber: string, dateLocal: string) =>
  deriveRequestHash(buildFlightRequest(flightNumber, dateLocal));

export const deriveFlightStatusRequestHash = (flightNumber: string, dateLocal: string) =>
  deriveRequestHash(buildFlightStatusRequest(flightNumber, dateLocal));

export const fetchSignedFlight = (flightNumber: string, dateLocal: string, fetchFunction: typeof fetch = fetch) =>
  fetchSignedResponse(AERODATABOX_URL, buildFlightRequest(flightNumber, dateLocal), fetchFunction);

export const fetchSignedFlightStatus = (flightNumber: string, dateLocal: string, fetchFunction: typeof fetch = fetch) =>
  fetchSignedResponse(AERODATABOX_URL, buildFlightStatusRequest(flightNumber, dateLocal), fetchFunction);
