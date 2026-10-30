import { writeFileSync } from 'node:fs';
import type { Address } from 'viem';
import { type AirnodeV2Request, deriveRequestHash, fetchSignedResponse, verifySignedResponse } from './airnode-v2.ts';
import { createScriptFetch } from './script-options.ts';

const AERODATABOX_URL = 'https://airnode-aerodatabox.fly.dev/';
const AERODATABOX_ADDRESS: Address = '0x83FE2E8F24E66520B1902C3507De4F471248f2Ec';

const [flightNumber = 'LH2020', dateLocal = '2026-10-29'] = process.argv.slice(2);

const request: AirnodeV2Request = {
  operation: 'flightStatusOnDate',
  parameters: { searchBy: 'number', searchParam: flightNumber, dateLocal },
};

const signed = await fetchSignedResponse(AERODATABOX_URL, request, createScriptFetch());
await verifySignedResponse(signed, AERODATABOX_ADDRESS, deriveRequestHash(request));

const file = `flight-${flightNumber}-${dateLocal}.json`;
writeFileSync(file, JSON.stringify({ ...signed, data: signed.data ? JSON.parse(signed.data) : null }, null, 2));
console.log(`Signature OK. Full response saved to ${file}`);