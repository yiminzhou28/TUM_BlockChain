import type { Address } from 'viem';
import { type AirnodeV2Request, deriveRequestHash, fetchSignedResponse } from './airnode-v2.ts';

export const AERODATABOX_URL = 'https://airnode-aerodatabox.fly.dev/';
// From the x-airnode extension of GET / on the Airnode.
export const AERODATABOX_ADDRESS: Address = '0x83FE2E8F24E66520B1902C3507De4F471248f2Ec';

// Must match PROJECTION and the parameters in deriveRequestHash in contracts/FlightGuard.sol.
export const FLIGHT_PROJECTION = {
  actualArrival: '/0/arrival/revisedTime/utc',
  scheduledArrival: '/0/arrival/scheduledTime/utc',
  status: '/0/status',
};

export const buildFlightRequest = (flightNumber: string, dateLocal: string): AirnodeV2Request => ({
  operation: 'flightStatusOnDate',
  parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal, dateLocalRole: 'Departure' },
  responseProjection: FLIGHT_PROJECTION,
});

export const deriveFlightRequestHash = (flightNumber: string, dateLocal: string) =>
  deriveRequestHash(buildFlightRequest(flightNumber, dateLocal));

export const fetchSignedFlight = (flightNumber: string, dateLocal: string, fetchFunction: typeof fetch = fetch) =>
  fetchSignedResponse(AERODATABOX_URL, buildFlightRequest(flightNumber, dateLocal), fetchFunction);
