// End-to-end test of FlightGuard on a local chain, through a day of flights:   pnpm e2e   (or: node e2e/run.mjs)
//
// Needs Foundry (anvil and forge on the PATH, or FOUNDRY_BIN=<folder>) and `pnpm install`. Uses nothing real: not
// .env, not Base Sepolia, not aUSD, no x402 payment. It copies the project to a temporary folder and, in the copy only,
// replaces the AeroDataBox signer with a local test key. Then it starts anvil with Base Sepolia's chain id, puts a test
// token where aUSD lives, deploys with the real deploy script, and runs the real agent, keeper, watch, MCP server and
// fixture scripts against e2e/mock-airnode.mjs, which signs answers like the AeroDataBox Airnode from a world that this
// test edits as flights depart, land and are cancelled. Every outcome is checked on-chain.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_SIGNER = '0x83FE2E8F24E66520B1902C3507De4F471248f2Ec';
const AUSD = '0xbeA34973e5f67F18F656A2C6070C64326C791808';
// Public test keys: anvil's first two accounts, the stand-in Airnode and an impostor
const UNDERWRITER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TRAVELLER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const AIRNODE_KEY = '0x00000000000000000000000000000000000000000000000000000000000a11ce';
const IMPOSTOR_KEY = '0x0000000000000000000000000000000000000000000000000000000000000b0b';
const AIRNODE = privateKeyToAccount(AIRNODE_KEY).address;
const IMPOSTOR = privateKeyToAccount(IMPOSTOR_KEY).address;
const UNDERWRITER = privateKeyToAccount(UNDERWRITER_KEY).address;
const TRAVELLER = privateKeyToAccount(TRAVELLER_KEY).address;

const bin = (name) => (process.env.FOUNDRY_BIN ? join(process.env.FOUNDRY_BIN, name) : name);
const FORGE_ARGS = process.env.E2E_FORGE_ARGS ? process.env.E2E_FORGE_ARGS.split(' ') : [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();

let passed = 0;
const check = (name, condition, context = '') => {
  if (!condition) throw new Error(`FAILED: ${name}${context ? `\n${context.slice(-3000)}` : ''}`);
  passed += 1;
  console.log(`  \u2713 ${name}`);
};
const step = (title) => console.log(`\n== ${title}`);
// Output of a command, without the stack trace and the source line that Node prints with an uncaught error
const indent = (text, prefix = '    ') =>
  text
    .split('\n')
    .filter((line, i, lines) => !/^file:\/\/.*:\d+$/.test(line) && !/^file:\/\/.*:\d+$/.test(lines[i - 1] ?? ''))
    .filter((line) => line.trim() && !/^\s+at |^Node\.js v|^\s*\^+$/.test(line))
    .map((line) => `${prefix}${line}`)
    .join('\n');

// ---------------------------------------------------------------- a copy of the project that trusts the test key

for (const tool of ['forge', 'anvil']) {
  if (spawnSync(bin(tool), ['--version']).status !== 0) {
    console.error(`${tool} not found. Install Foundry (https://getfoundry.sh) or set FOUNDRY_BIN to its folder.`);
    process.exit(1);
  }
}
// Not copied: git, dependencies (linked instead), deployments, keys, and the agent's local state
const SKIP = new Set([
  '.git',
  'node_modules',
  'lib',
  'broadcast',
  '.env',
  'quote.json',
  'flight-history.json',
  'flight-dates.json',
  'sale-proofs.json',
  'quotes-signed.json',
  'schedule.json',
]);
const work = mkdtempSync(join(tmpdir(), 'flightguard-e2e-'));
cpSync(ROOT, work, { recursive: true, filter: (source) => !SKIP.has(relative(ROOT, source).split(sep)[0]) });
symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'dir');
symlinkSync(join(ROOT, 'lib'), join(work, 'lib'), 'dir');
for (const file of ['src/flight.ts', 'script/DeployFlightGuard.s.sol', 'test/FlightGuardRealData.t.sol']) {
  const text = readFileSync(join(work, file), 'utf8');
  if (!text.includes(REAL_SIGNER)) throw new Error(`${file} does not name the AeroDataBox signer ${REAL_SIGNER}`);
  writeFileSync(join(work, file), text.replaceAll(REAL_SIGNER, AIRNODE));
}
console.log(`Working in ${work}, with the AeroDataBox signer replaced by the test key ${AIRNODE}`);

let anvil;
let watcher;
const stopAll = () => {
  watcher?.kill();
  anvil?.kill();
};
process.on('exit', stopAll);

try {
  step('Build, local chain, test aUSD, deploy with script/DeployFlightGuard.s.sol');
  const build = spawnSync(bin('forge'), ['build', ...FORGE_ARGS], { cwd: work, encoding: 'utf8' });
  check('forge build', build.status === 0, build.stdout + build.stderr);

  const port = Number(process.env.E2E_PORT ?? 20000 + Math.floor(Math.random() * 20000));
  const RPC = `http://127.0.0.1:${port}`;
  anvil = spawn(bin('anvil'), ['--port', String(port), '--chain-id', '84532', '--silent'], { stdio: 'ignore' });
  const rpc = async (method, params = []) => {
    const response = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await rpc('eth_chainId');
      break;
    } catch (error) {
      if (attempt > 100) throw new Error(`anvil did not start on port ${port}: ${error.message}`);
      await sleep(200);
    }
  }
  const chain = {
    id: 84532,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  };
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const wallet = createWalletClient({ account: privateKeyToAccount(UNDERWRITER_KEY), chain, transport: http(RPC) });
  const send = async (hash) => publicClient.waitForTransactionReceipt({ hash: await hash });

  // The test token from test/FlightGuard.t.sol, at the address of aUSD
  const testUsd = JSON.parse(readFileSync(join(work, 'out/FlightGuard.t.sol/TestUSD.json'), 'utf8'));
  await rpc('anvil_setCode', [AUSD, testUsd.deployedBytecode.object]);
  const mintAbi = [
    {
      type: 'function',
      name: 'mint',
      stateMutability: 'nonpayable',
      outputs: [],
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    },
  ];
  await send(
    wallet.writeContract({
      address: AUSD,
      abi: mintAbi,
      functionName: 'mint',
      args: [UNDERWRITER, parseUnits('20', 6)],
    })
  );
  await send(
    wallet.writeContract({ address: AUSD, abi: mintAbi, functionName: 'mint', args: [TRAVELLER, parseUnits('3', 6)] })
  );

  const deploy = spawnSync(
    bin('forge'),
    ['script', 'script/DeployFlightGuard.s.sol', '--rpc-url', RPC, '--broadcast', ...FORGE_ARGS],
    {
      cwd: work,
      env: { ...process.env, PAYER_PRIVATE_KEY: UNDERWRITER_KEY },
      encoding: 'utf8',
    }
  );
  check('the deploy script deploys FlightGuard and funds the pool', deploy.status === 0, deploy.stdout + deploy.stderr);
  // The same way as the README reads the address after deploying on Base Sepolia
  const broadcast = JSON.parse(
    readFileSync(join(work, 'broadcast/DeployFlightGuard.s.sol/84532/run-latest.json'), 'utf8')
  );
  const GUARD = broadcast.transactions.find((t) => t.transactionType === 'CREATE').contractAddress;
  const guardAbi = JSON.parse(readFileSync(join(work, 'out/FlightGuard.sol/FlightGuard.json'), 'utf8')).abi;
  const readGuard = (functionName, args = []) =>
    publicClient.readContract({ address: GUARD, abi: guardAbi, functionName, args });
  const balance = (owner) =>
    publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  const aUSD = (text) => parseUnits(text, 6);
  const STATUS = ['None', 'Active', 'PaidOut', 'ClosedOnTime', 'Expired'];
  const policy = async (id) => {
    const p = await readGuard('policies', [BigInt(id)]);
    return { holder: p[0], payout: p[2], threshold: Number(p[3]), status: STATUS[p[5]], flight: p[6], date: p[7] };
  };
  check(`FlightGuard at ${GUARD} trusts the test Airnode`, (await readGuard('airnode')) === AIRNODE);
  check(
    'the pool holds 3 aUSD and the keeper reward is 0.1 aUSD',
    (await balance(GUARD)) === aUSD('3') && (await readGuard('keeperReward')) === aUSD('0.1')
  );

  // ---------------------------------------------------------------- the world the stand-in Airnode answers from

  const WORLD = join(work, 'e2e-world.json');
  const world = { offset: 0, signerKey: AIRNODE_KEY, published: AIRNODE, flights: {} };
  const saveWorld = () => {
    writeFileSync(`${WORLD}.tmp`, JSON.stringify(world, null, 2));
    renameSync(`${WORLD}.tmp`, WORLD);
  };
  saveWorld();
  // The agent's clock: the real one plus the offset, the same as the chain's
  const agentNow = () => Math.floor(Date.now() / 1000) + world.offset;
  const utc = (seconds) =>
    `${new Date(Math.floor(seconds / 60) * 60_000).toISOString().slice(0, 16).replace('T', ' ')}Z`;
  const seconds = (utcText) => Date.parse(utcText.replace(' ', 'T')) / 1000;
  const later = (utcText, minutes) => utc(seconds(utcText) + minutes * 60);
  const addFlight = (number, { departsIn, departsAt = agentNow() + departsIn, duration = 2 * 3600, ...rest }) => {
    const date = utc(departsAt).slice(0, 10);
    world.flights[`${number}|${date}`] = {
      status: 'Expected',
      from: 'MUC',
      to: 'PMI',
      dep: utc(departsAt),
      arr: utc(departsAt + duration),
      ...rest,
    };
    saveWorld();
    return date;
  };
  const flight = (number, date) => world.flights[`${number}|${date}`];
  const update = (number, date, changes) => {
    Object.assign(flight(number, date), changes);
    saveWorld();
  };
  // Moves the clock of the agent, the stand-in Airnode and the chain forward together
  const setClock = async (offset) => {
    world.offset = offset;
    saveWorld();
    await rpc('anvil_setTime', [Math.floor(Date.now() / 1000) + offset]);
    await rpc('evm_mine');
  };
  const clockTo = async (target) => {
    if (target <= agentNow())
      throw new Error(`The clock only moves forward: ${utc(target)} is not after ${utc(agentNow())}`);
    await setClock(target - Math.floor(Date.now() / 1000));
  };

  const env = {
    ...process.env,
    PAYER_PRIVATE_KEY: UNDERWRITER_KEY,
    TRAVELLER_PRIVATE_KEY: TRAVELLER_KEY,
    FLIGHTGUARD_ADDRESS: GUARD,
    BASE_SEPOLIA_RPC: RPC,
    EXPLORER: 'local',
    MOCK_WORLD: WORLD,
  };
  const nodeArgs = (script, args) => [
    '--import',
    pathToFileURL(join(work, 'e2e/mock-airnode.mjs')).href,
    script,
    ...args,
  ];
  const run = (script, ...args) => {
    console.log(`  $ node ${script} ${args.join(' ')}`);
    const result = spawnSync(process.execPath, nodeArgs(script, args), {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 180_000,
    });
    const out = `${result.stdout}${result.stderr}`;
    console.log(indent(out));
    return { ok: result.status === 0, out };
  };
  const agent = (...args) => run('src/agent.ts', ...args);

  // ---------------------------------------------------------------- 1. the data source

  step('1. The agent checks its data source before paying for anything');
  const fg100 = addFlight('FG100', { departsIn: 3 * 3600 });
  world.published = IMPOSTOR;
  saveWorld();
  let r = agent('quote', 'FG100', fg100, '1', '15');
  check(
    'refuses to buy data when the Airnode publishes another signer',
    !r.ok && r.out.includes(`now publishes ${IMPOSTOR}`),
    r.out
  );
  world.published = AIRNODE;
  world.signerKey = IMPOSTOR_KEY;
  saveWorld();
  r = agent('quote', 'FG100', fg100, '1', '15');
  check('refuses a proof of sale signed by any other key', !r.ok && r.out.includes(`signed by ${IMPOSTOR}`), r.out);
  world.signerKey = AIRNODE_KEY;
  world.documentDown = true;
  const fg150 = addFlight('FG150', { departsIn: 2.5 * 3600, status: 'CheckIn' });
  r = agent('quote', 'FG150', fg150, '1', '15');
  check(
    'quotes a flight in CheckIn, verifying every response when the signer document is down',
    r.ok && r.out.includes('Could not read the signer') && r.out.includes('Signed by quote signer'),
    r.out
  );
  check(
    'a first quote on a flight buys 8 signed responses: schedule, proof of sale, dates, 5 past flights',
    r.out.includes('Data bought for this quote: 8 signed responses = 0.4 aUSD'),
    r.out
  );
  world.documentDown = false;
  saveWorld();

  // ---------------------------------------------------------------- 2. what the underwriter will not sell

  step('2. Flights the underwriter will not insure');
  const fourHours = agentNow() + 4 * 3600;
  const refusals = [
    ['FG200', { departsIn: 1.5 * 3600 }, 'sales closed'],
    ['FG300', { departsAt: fourHours, status: 'Delayed' }, 'status is Delayed'],
    ['FG310', { departsAt: fourHours, status: 'Canceled' }, 'status is Canceled'],
    ['FG400', { departsAt: fourHours, depRevised: utc(fourHours + 30 * 60) }, 'already revised 30 min late'],
    ['FG500', { departsAt: fourHours, history: 'noarrival' }, 'only 0 of 5 past flights have an actual arrival time'],
    ['FG510', { departsAt: fourHours, history: 'late' }, 'would not be below the payout'],
  ];
  const refusedOn = {};
  for (const [number, setup, expected] of refusals) {
    refusedOn[number] = addFlight(number, setup);
    r = agent('quote', number, refusedOn[number], '1', '15');
    check(`${number}: "${expected}"`, !r.ok && r.out.includes(expected), r.out);
  }
  r = agent('quote', 'FG999', fg100, '1', '15');
  check('a flight AeroDataBox does not know', !r.ok && r.out.includes('AeroDataBox has no FG999'), r.out);
  r = agent('quote', 'LH-400', fg100, '1', '15');
  check('a malformed flight number', !r.ok && r.out.includes('is not like LH400'), r.out);
  r = agent('quote', 'FG100', '31.10.2026', '1', '15');
  check('a malformed date', !r.ok && r.out.includes('is not YYYY-MM-DD'), r.out);
  r = agent('quote', 'FG100', fg100, '2', '15');
  check(
    'too much cover on one flight for the pool: 2 of 3 aUSD',
    !r.ok && r.out.includes('would exceed 50 % of the pool'),
    r.out
  );
  // More capital, so that a day of test policies fits within the exposure caps
  await send(
    wallet.writeContract({ address: AUSD, abi: erc20Abi, functionName: 'transfer', args: [GUARD, aUSD('10')] })
  );

  // ---------------------------------------------------------------- 3. buying

  step('3. Quote and buy: the contract checks the signed proof of sale');
  const travellerStart = await balance(TRAVELLER);
  r = agent('quote', 'FG100', fg100, '1', '15');
  check(
    'quotes FG100 from its history',
    r.ok && /Premium: .* keeper reward/.test(r.out) && r.out.includes('Signed by quote signer'),
    r.out
  );
  r = agent('buy');
  check(
    'buys policy #0 with the proof of sale',
    r.ok && r.out.includes('Policy #0 bought') && r.out.includes("verified AeroDataBox's signed proof of sale"),
    r.out
  );
  let p = await policy(0);
  check(
    'policy #0 is active for the traveller: FG100, 1 aUSD if 15+ min late',
    p.status === 'Active' &&
      p.holder === TRAVELLER &&
      p.flight === 'FG100' &&
      p.threshold === 15 &&
      p.payout === aUSD('1')
  );

  const fg600 = addFlight('FG600', { departsIn: 3 * 3600, to: 'LIS' });
  r = agent('quote', 'FG600', fg600, '1', '15');
  check('quotes FG600', r.ok, r.out);
  const quoteFile = join(work, 'quote.json');
  const saved = JSON.parse(readFileSync(quoteFile, 'utf8'));
  const edited = {
    ...saved,
    saleProof: { ...saved.saleProof, data: saved.saleProof.data.replace('Expected', 'CheckIn') },
  };
  writeFileSync(quoteFile, JSON.stringify(edited));
  r = agent('buy');
  check('the contract refuses an edited proof of sale', !r.ok && r.out.includes('NotSignedByAirnode'), r.out);
  writeFileSync(quoteFile, JSON.stringify(saved));
  r = agent('buy');
  check('buys policy #1 on FG600 with the real proof', r.ok && r.out.includes('Policy #1 bought'), r.out);

  r = agent('quote', 'FG100', fg100, '1', '15');
  check(
    'a second quote on FG100 within 5 min buys no data: same proof of sale, history and dates',
    r.ok &&
      r.out.includes('Reusing the schedule check and proof of sale of FG100') &&
      r.out.includes('Data bought for this quote: 0 signed responses = 0 aUSD'),
    r.out
  );
  await setClock(11 * 60);
  r = agent('buy');
  check('refuses a quote after its 10 minutes', !r.ok && r.out.includes('The quote expired'), r.out);
  // Quotes of 2 aUSD on FG100 until the open ones fill half the pool: each one that is signed counts against the cap
  const halfPool = (await balance(GUARD)) / 2n;
  let signed = 0n;
  for (;;) {
    r = agent('quote', 'FG100', fg100, '2', '15');
    if (!r.ok) break;
    signed += 1n;
  }
  check(
    `signs ${signed} more quotes of 2 aUSD on FG100, then refuses the one that would take it past half the pool`,
    signed > 0n &&
      aUSD('1') + signed * aUSD('2') <= halfPool &&
      aUSD('1') + (signed + 1n) * aUSD('2') > halfPool &&
      r.out.includes(`would exceed 50 % of the pool, counting ${signed} open quote(s)`),
    r.out
  );

  // ---------------------------------------------------------------- 4. self-transfer cover

  step('4. Self-transfer cover: two separate tickets');
  const fg700 = addFlight('FG700', { departsIn: 3 * 3600, from: 'LIS', to: 'MUC' });
  // Leaves Munich 3 hours after FG700 is due there
  const fg800 = addFlight('FG800', {
    departsAt: seconds(flight('FG700', fg700).arr) + 3 * 3600,
    from: 'MUC',
    to: 'JFK',
    duration: 9 * 3600,
  });
  const fg810 = addFlight('FG810', {
    departsAt: seconds(flight('FG700', fg700).arr) + 3 * 3600,
    from: 'FRA',
    to: 'JFK',
    duration: 9 * 3600,
  });
  r = agent('quote-connection', 'FG700', fg700, 'FG810', fg810, '1', '90');
  check(
    'refuses a connection from another airport',
    !r.ok && r.out.includes('FG700 lands in MUC but FG810 departs from FRA'),
    r.out
  );
  r = agent('quote-connection', 'FG700', fg700, 'FG800', fg800, '1', '170');
  check(
    'refuses a connection with less than 15 min of slack',
    !r.ok && r.out.includes('less than 15 min of slack'),
    r.out
  );
  r = agent('quote-connection', 'FG700', fg700, 'FG800', fg800, '1', '90');
  check(
    '180 min gap - 90 min to change = pays if FG700 lands 90+ min late',
    r.ok && r.out.includes('180 min gap - 90 min to change = pays if FG700 lands 90+ min late'),
    r.out
  );
  r = agent('buy');
  p = await policy(2);
  check('buys policy #2: FG700 with a 90 min threshold', r.ok && p.flight === 'FG700' && p.threshold === 90, r.out);

  // ---------------------------------------------------------------- 5. an AI assistant over MCP

  step('5. An AI assistant quotes and buys over MCP');
  // Departs later than the others, so that it is still in the air when they have landed
  const fg1000 = addFlight('FG1000', { departsIn: 5 * 3600, to: 'BCN' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: nodeArgs('src/mcp.ts', []),
    cwd: work,
    env,
    stderr: 'pipe',
  });
  let serverLog = '';
  transport.stderr?.on('data', (chunk) => (serverLog += chunk));
  const client = new Client({ name: 'flightguard-e2e', version: '1.0.0' });
  const protocolErrors = [];
  client.onerror = (error) => protocolErrors.push(error);
  await client.connect(transport);
  const call = async (name, args = {}) => {
    console.log(`  > ${name} ${JSON.stringify(args)}`);
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.map((c) => c.text).join('\n');
    console.log(indent(text));
    return { isError: Boolean(result.isError), text };
  };
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(
    `offers ${names.join(', ')}`,
    JSON.stringify(names) ===
      JSON.stringify(['buy_cover', 'policy_status', 'quote_connection_cover', 'quote_flight_cover', 'settle_policies'])
  );
  check(
    'tells the assistant to confirm the premium before buying',
    (client.getInstructions() ?? '').includes('ask them to confirm')
  );
  let t = await call('quote_flight_cover', { flight: 'FG 200', date: refusedOn.FG200, payout_aUSD: 1 });
  check('a refusal comes back as a tool error with the reason', t.isError && t.text.includes('sales closed'), t.text);
  t = await call('quote_flight_cover', { flight: 'FG1000', date: fg1000, payout_aUSD: 1, delay_minutes: 30 });
  check(
    'quote_flight_cover explains the price',
    !t.isError && t.text.includes('P(delay)') && t.text.includes('"premium"'),
    t.text
  );
  t = await call('buy_cover');
  check('buy_cover buys policy #3', !t.isError && t.text.includes('Policy #3 bought'), t.text);
  t = await call('policy_status');
  check('policy_status lists it', !t.isError && t.text.includes('#3 FG1000'), t.text);
  await client.close();
  check(
    'nothing but the protocol on stdout',
    protocolErrors.length === 0,
    protocolErrors.map(String).join('\n') + serverLog
  );

  // ---------------------------------------------------------------- 6. the flights land

  step(
    '6. Hours later: FG100 was retimed 30 min later and landed 40 min after the schedule the traveller bought, ' +
      'FG600 was cancelled, FG700 landed 100 min late, FG1000 is in the air'
  );
  // The airline moved FG100's schedule after the sale: 10 min late against the new one, 40 against the one bought
  const fg100Bought = flight('FG100', fg100).arr;
  update('FG100', fg100, { status: 'Arrived', arr: later(fg100Bought, 30), arrRevised: later(fg100Bought, 40) });
  update('FG600', fg600, { status: 'Canceled' });
  update('FG700', fg700, { status: 'Arrived', arrRevised: later(flight('FG700', fg700).arr, 100) });
  update('FG1000', fg1000, { status: 'EnRoute', arrRevised: later(flight('FG1000', fg1000).arr, 20) });
  await clockTo(seconds(flight('FG700', fg700).arrRevised) + 5 * 60);
  const before = { traveller: await balance(TRAVELLER), underwriter: await balance(UNDERWRITER) };
  r = agent('keeper');
  check(
    'the keeper pays out the late, the cancelled and the missed connection',
    r.ok && (r.out.match(/PAID OUT 1 aUSD/g) ?? []).length === 3 && r.out.includes('cancelled flight'),
    r.out
  );
  check(
    'the retimed FG100 counts 40 min late, from the schedule the traveller bought',
    r.out.includes(`when bought, now ${later(fg100Bought, 30)} -> 40 min late`),
    r.out
  );
  check(
    'and waits for FG1000, which is still flying',
    r.out.includes('status EnRoute, expected to arrive') && r.out.includes('not settled yet'),
    r.out
  );
  const statuses = await Promise.all([0, 1, 2, 3].map(async (id) => (await policy(id)).status));
  check(
    `policies #0-#3: ${statuses.join(', ')}`,
    JSON.stringify(statuses) === JSON.stringify(['PaidOut', 'PaidOut', 'PaidOut', 'Active'])
  );
  check('the traveller received 3 aUSD', (await balance(TRAVELLER)) - before.traveller === aUSD('3'));
  check(
    'whoever settled earned 3 x 0.1 aUSD keeper rewards',
    (await balance(UNDERWRITER)) - before.underwriter === aUSD('0.3')
  );
  check('only policy #3 is still reserved: 1 + 0.1 aUSD', (await readGuard('totalReserved')) === aUSD('1.1'));

  step('7. FG1000 lands 20 min late, below its 30 min threshold; the assistant settles it over MCP');
  update('FG1000', fg1000, { status: 'Arrived' });
  await clockTo(seconds(flight('FG1000', fg1000).arrRevised) + 5 * 60);
  const mcp = new Client({ name: 'flightguard-e2e', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: nodeArgs('src/mcp.ts', []),
      cwd: work,
      env,
      stderr: 'ignore',
    })
  );
  const settled = await mcp.callTool({ name: 'settle_policies', arguments: {} });
  const settledText = settled.content.map((c) => c.text).join('\n');
  console.log(indent(settledText));
  await mcp.close();
  check(
    'settle_policies closes it without payout and earns the keeper reward',
    !settled.isError &&
      settledText.includes('on time, closed without payout') &&
      settledText.includes('keeper reward 0.1 aUSD'),
    settledText
  );
  check('policy #3 is ClosedOnTime', (await policy(3)).status === 'ClosedOnTime');

  // ---------------------------------------------------------------- 8. the watch

  step('8. watch: settles on its own, including a policy bought while it runs');
  const fg900 = addFlight('FG900', { departsIn: 2.5 * 3600 });
  r = agent('quote', 'FG900', fg900, '1', '15');
  r = agent('buy');
  check('buys policy #4 on FG900', r.ok && r.out.includes('Policy #4 bought'), r.out);
  let watchOut = '';
  watcher = spawn(process.execPath, nodeArgs('src/agent.ts', ['watch', '24']), { cwd: work, env });
  const collect = (chunk) => {
    watchOut += chunk;
    process.stdout.write(indent(String(chunk), '    [watch] ') + '\n');
  };
  watcher.stdout.on('data', collect);
  watcher.stderr.on('data', collect);
  const watchExit = new Promise((resolve) => watcher.on('exit', resolve));
  const waitFor = async (pattern, timeoutSeconds = 100) => {
    const until = Date.now() + timeoutSeconds * 1000;
    while (!pattern.test(watchOut)) {
      if (Date.now() > until)
        throw new Error(`The watch did not log ${pattern} within ${timeoutSeconds} s:\n${watchOut}`);
      await sleep(500);
    }
  };
  await waitFor(/Sleeping until/);
  check('the watch sleeps until FG900 is due', /Policy #4 FG900: first look at its scheduled arrival/.test(watchOut));
  const fg910 = addFlight('FG910', { departsIn: 2.5 * 3600 + 10 * 60 });
  r = agent('quote', 'FG910', fg910, '1', '15');
  r = agent('buy');
  check('buys policy #5 on FG910 while the watch runs', r.ok && r.out.includes('Policy #5 bought'), r.out);
  await waitFor(/Policy #5 FG910: first look at its scheduled arrival/);
  check('the watch picks up policy #5 at its own arrival time', true);

  update('FG900', fg900, { status: 'Arrived', arrRevised: later(flight('FG900', fg900).arr, 5) });
  await clockTo(seconds(flight('FG900', fg900).arrRevised) + 30);
  await waitFor(/on time, closed without payout/);
  check(
    'FG900 lands 5 min late: the watch closes policy #4 without payout',
    (await policy(4)).status === 'ClosedOnTime'
  );

  update('FG910', fg910, { status: 'Arrived', arrRevised: later(flight('FG910', fg910).arr, 50) });
  await clockTo(seconds(flight('FG910', fg910).arrRevised) + 30);
  await waitFor(/No active policies left/);
  const code = await watchExit;
  check(
    'FG910 lands 50 min late: the watch pays out policy #5 and stops',
    (await policy(5)).status === 'PaidOut' && code === 0,
    watchOut
  );

  // ---------------------------------------------------------------- 9. expiry and withdrawal

  step('9. A flight that is never reported: expired after the settlement window, reserve released');
  const fg950 = addFlight('FG950', { departsIn: 2.5 * 3600 });
  agent('quote', 'FG950', fg950, '1', '15');
  r = agent('buy');
  check('buys policy #6 on FG950', r.ok && r.out.includes('Policy #6 bought'), r.out);
  r = agent('keeper');
  check(
    'the keeper does not expire it inside the window',
    r.ok && r.out.includes('not settled yet') && (await policy(6)).status === 'Active',
    r.out
  );
  await setClock(world.offset + 4 * 24 * 3600);
  r = agent('keeper');
  check(
    'after the window: tries the arrival and the status, then expires it',
    r.ok &&
      r.out.includes('no arrival time yet') &&
      r.out.includes('expired, reserve released') &&
      (await policy(6)).status === 'Expired',
    r.out
  );
  check('nothing is reserved any more', (await readGuard('totalReserved')) === 0n);
  r = agent('withdraw');
  check(
    'the underwriter withdraws the whole pool',
    r.ok && r.out.includes('Withdrew') && (await balance(GUARD)) === 0n,
    r.out
  );
  r = agent('status');
  check(
    'status shows every policy',
    r.ok && ['PaidOut', 'ClosedOnTime', 'Expired'].every((s) => r.out.includes(s)),
    r.out
  );
  r = agent('pause');
  const pausedStatus = agent('status');
  const fg970 = addFlight('FG970', { departsIn: 2.5 * 3600 });
  const pausedQuote = agent('quote', 'FG970', fg970, '1', '15');
  check(
    'pause stops sales: status shows it and the agent refuses to quote',
    r.ok &&
      (await readGuard('paused')) === true &&
      pausedStatus.out.includes('Sales PAUSED') &&
      !pausedQuote.ok &&
      pausedQuote.out.includes('paused sales'),
    r.out + pausedStatus.out + pausedQuote.out
  );
  r = agent('resume');
  check('resume opens sales again', r.ok && (await readGuard('paused')) === false, r.out);
  const bigQuote = agent('quote', 'FG970', fg970, '3', '15');
  check(
    'a payout above the 2 aUSD limit is refused before any data is bought',
    !bigQuote.ok && bigQuote.out.includes('above the 2 aUSD limit') && !bigQuote.out.includes('Pricing'),
    bigQuote.out
  );

  // ---------------------------------------------------------------- 10. fixtures for the real-data tests

  step('10. find-cancelled and fetch-flight --sale write fixtures that the Solidity tests accept');
  r = run('src/find-cancelled.ts', 'MUC');
  const cancelled = r.ok ? JSON.parse(readFileSync(join(work, 'test/fixtures/cancelled.json'), 'utf8')) : {};
  check(
    `find-cancelled finds ${cancelled.flightNumber} cancelled on the MUC board and saves its signed status`,
    r.ok && ['FG310', 'FG600'].includes(cancelled.flightNumber) && cancelled.data === '{"status":"Canceled"}',
    r.out
  );
  const fg960 = addFlight('FG960', { departsIn: 3 * 3600 });
  r = run('src/fetch-flight.ts', 'FG960', fg960, '--sale');
  check(
    'fetch-flight --sale saves a proof of sale',
    r.ok && r.out.includes('saved to test/fixtures/sale-proof.json'),
    r.out
  );
  const forgeTest = spawnSync(
    bin('forge'),
    [
      'test',
      '--match-contract',
      'FlightGuardRealDataTest',
      '--match-test',
      'test_RealCancelledFlight_PaysOut|test_RealSaleProof_BuysThroughBuyPolicy',
      ...FORGE_ARGS,
    ],
    { cwd: work, encoding: 'utf8' }
  );
  console.log(
    indent(
      forgeTest.stdout
        .split('\n')
        .filter((l) => /PASS|FAIL|Suite result/.test(l))
        .join('\n')
    )
  );
  check(
    'test_RealCancelledFlight_PaysOut and test_RealSaleProof_BuysThroughBuyPolicy pass with them',
    forgeTest.status === 0 && (forgeTest.stdout.match(/\[PASS\]/g) ?? []).length === 2,
    forgeTest.stdout + forgeTest.stderr
  );

  console.log(`\nE2E passed: ${passed} checks in ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
  stopAll();
  rmSync(work, { recursive: true, force: true });
} catch (error) {
  console.error(`\n${error.message}\n\nThe test copy is kept in ${work}`);
  stopAll();
  process.exit(1);
}
