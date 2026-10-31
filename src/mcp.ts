// FlightGuard as tools for an AI assistant, over the Model Context Protocol (stdio). The assistant can price cover for a
// flight or for a self-transfer connection, explain the price, buy the cover, check policies and settle them, all with
// signed AeroDataBox data. In Claude Desktop: Settings > Developer > Edit Config, and add to "mcpServers":
//
//   "flightguard": {
//     "command": "/opt/homebrew/bin/node",
//     "args": ["--env-file=/Users/you/flight-guard/.env", "/Users/you/flight-guard/src/mcp.ts"]
//   }
//
// with the path of `which node` as the command and this project's folder in both arguments.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buy, describeError, keeper, output, quote, quoteConnection, status } from './agent.ts';

// stdout carries the protocol, so nothing else may be written to it: everything the agent or a library prints goes to
// stderr, and during a tool call it is collected and returned with the answer, including the x402 payment receipts.
// One tool call runs at a time.
const toStderr = (...args: unknown[]) => process.stderr.write(`${args.join(' ')}\n`);
const quiet = () => {
  output.write = toStderr;
  console.log = console.info = console.warn = console.error = toStderr;
};
quiet();

let queue: Promise<unknown> = Promise.resolve();
const run = (action: () => Promise<unknown>) => {
  const call = queue.then(async () => {
    const lines: string[] = [];
    const collect = (...args: unknown[]) => lines.push(args.join(' ').replace(/^\[agent\] /, ''));
    output.write = collect;
    console.log = console.info = console.warn = console.error = collect;
    try {
      const result = await action();
      const text = [...lines, result === undefined ? '' : `Result: ${JSON.stringify(result, null, 2)}`]
        .join('\n')
        .trim();
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: [...lines, `Error: ${describeError(error)}`].join('\n') }],
      };
    } finally {
      quiet();
    }
  });
  queue = call.catch(() => undefined);
  return call;
};

const server = new McpServer(
  { name: 'flightguard', version: '1.0.0' },
  {
    instructions:
      'FlightGuard sells parametric flight insurance on Base Sepolia (testnet aUSD). A policy pays out automatically if ' +
      'the flight lands at least the threshold late, is cancelled or is diverted, proven by data the AeroDataBox Airnode ' +
      'signs. A first quote on a flight buys up to 0.45 aUSD of signed data, later quotes on the same flight reuse it. ' +
      'Quotes are valid for 10 minutes. Before calling buy_cover, show the user the premium, the payout and the threshold ' +
      'from the quote and ask them to confirm. Explain prices with the numbers in the quote output: how many past flights ' +
      'were late, the prior, the probability.',
  }
);

const flight = z.string().describe('Flight number, such as LH400 or DE 1130');
const date = z.string().describe('Departure date local to the departure airport, YYYY-MM-DD');
const payout = z.number().positive().default(1).describe('What the policy pays, in aUSD');

server.registerTool(
  'quote_flight_cover',
  {
    title: 'Quote flight delay cover',
    description:
      'Prices cover for one flight: pays `payout_aUSD` if the flight lands `delay_minutes` or more late, is cancelled or ' +
      'diverted. Checks with signed AeroDataBox data that the flight is still expected and at least 2 hours from ' +
      'departure, buys its recent track record over x402, prices it and signs a quote valid for 10 minutes. Does not buy.',
    inputSchema: {
      flight,
      date,
      payout_aUSD: payout,
      delay_minutes: z.number().int().min(1).default(15).describe('Arrival delay that triggers the payout, in minutes'),
    },
  },
  ({ flight, date, payout_aUSD, delay_minutes }) => run(() => quote(flight, date, payout_aUSD, delay_minutes))
);

server.registerTool(
  'quote_connection_cover',
  {
    title: 'Quote self-transfer cover',
    description:
      'Prices cover for a self-transfer: two separately booked flights, where a delay on the first makes the traveller ' +
      'miss the second and EU 261 does not help. The policy pays `payout_aUSD` if the first flight lands so late that the ' +
      'time left before the second flight departs is less than `minutes_to_change`, or if the first flight is cancelled ' +
      'or diverted. The second flight must depart from the airport where the first lands. Signs a quote valid for 10 ' +
      'minutes. Does not buy.',
    inputSchema: {
      first_flight: flight,
      first_date: date,
      second_flight: flight,
      second_date: date,
      payout_aUSD: payout,
      minutes_to_change: z
        .number()
        .int()
        .min(0)
        .default(90)
        .describe('Time the traveller needs between the two flights: bags, check-in, security'),
    },
  },
  ({ first_flight, first_date, second_flight, second_date, payout_aUSD, minutes_to_change }) =>
    run(() => quoteConnection(first_flight, first_date, second_flight, second_date, payout_aUSD, minutes_to_change))
);

server.registerTool(
  'buy_cover',
  {
    title: 'Buy the quoted cover',
    description:
      'Buys the last quote from the traveller wallet: pays the premium, and the contract checks the signed proof that the ' +
      'flight is still sellable. Ask the user to confirm the premium first.',
    inputSchema: {},
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  () => run(() => buy())
);

server.registerTool(
  'policy_status',
  {
    title: 'Show the pool and the policies',
    description: 'Shows the pool, what it has reserved, the keeper reward, the traveller balance and every policy.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () => run(() => status())
);

server.registerTool(
  'settle_policies',
  {
    title: 'Settle landed, cancelled or diverted flights',
    description:
      'For every active policy, fetches the signed outcome of its flight over x402 and settles it on-chain: pays out if ' +
      'it landed late enough, was cancelled or diverted, otherwise closes it. The settler earns the keeper reward.',
    inputSchema: {},
  },
  () => run(() => keeper())
);

await server.connect(new StdioServerTransport());
toStderr('FlightGuard MCP server ready');
