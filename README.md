# FlightGuard

**Flight delay and self-transfer cover where both the sale and the payout are proven by signed AeroDataBox data, sold
and settled by agents that pay for that data per call.**

A traveller buys cover for a flight, or for a connection between two separately booked flights. The contract only sells
it with a fresh signed status showing that the flight is still expected and at least 2 hours from departure. When the
flight lands late, is cancelled or is diverted, anyone can submit the signed outcome; the contract pays the traveller
and pays whoever settled a keeper reward. Nobody files a claim, and nobody who submits data has to be trusted: the
contract checks that the AeroDataBox Airnode signed it, for exactly that flight on exactly that date.

Built for the API3 AirnodeHub track of the TUM Blockchain & AI Hackathon 2026.

|                            |                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Network                    | Base Sepolia (chain id 84532)                                                                                                        |
| FlightGuard contract       | [`0xbce017f3ebccf26bcf28dcf125501b9aafb3d931`](https://sepolia.basescan.org/address/0xbce017f3ebccf26bcf28dcf125501b9aafb3d931)      |
| Data source                | [AeroDataBox on AirnodeHub](https://airnodehub.api3.org/explore/aerodatabox): `flightStatusOnDate`, `flightDates`, `airportSchedule` |
| AeroDataBox Airnode signer | `0x83FE2E8F24E66520B1902C3507De4F471248f2Ec`                                                                                         |
| Payment token              | aUSD `0xbeA34973e5f67F18F656A2C6070C64326C791808`                                                                                    |
| Try everything locally     | `pnpm e2e`: a day of flights on a local chain, 62 checks, nothing real spent                                                         |

## What is new

Flight delay insurance on a blockchain has been tried before: Etherisc's FlightDelay and AXA's fizzy (2017 to 2019)
settled policies with smart contracts, but the flight data reached the contract through an oracle service that had to be
trusted, and nothing proved on-chain that a flight was still insurable when it was sold. FlightGuard differs in five
ways:

1. **Both ends are proven by signed data.** `buyPolicy` takes a signed AeroDataBox response from the last 15 minutes and
   requires the flight to be `Expected` or `CheckIn` with its scheduled departure at least 2 hours away. Nobody can
   insure a flight that has departed or is already marked delayed or cancelled, and that is checked by the contract,
   not by a backend that has to be trusted. The payout is proven the same way, by the signed arrival or status.
2. **Anyone settles, and is paid for it.** Whoever submits the signed outcome receives a keeper reward from the pool,
   paid for by the premium. Payouts never wait for the insurer: the traveller's own assistant can settle.
3. **An underwriter agent that buys its own data.** It pays per call over x402, prices each flight from the history it
   bought (empirical Bayes), refuses cover it cannot settle or should not sell, caps its exposure, and shares what it
   bought across travellers, so data is paid per flight, not per traveller.
4. **Self-transfer cover.** Two flights on separate tickets are not protected by EU 261: a delay on the first one that
   makes the traveller miss the second is their own loss. FlightGuard turns the slack in the connection into the delay
   threshold of a policy on the first flight.
5. **Sold where travellers already ask.** An MCP server lets an AI assistant quote, explain the price, buy and settle.
   AXA said fizzy stopped because it "did not find the right distribution channels"; an assistant planning a trip is
   one.

## Why signed data is necessary

If the contract accepted plain JSON from whoever submits it, anyone could submit "LH400 arrived 3 hours late" or
"LH400 was cancelled" and drain the pool, or buy cover for a flight already known to be late. Every input that moves
money is therefore a response the AeroDataBox Airnode signed, over the request and the time:

| When                  | Request (projection) | Signed data                                                                                             | Contract                    | Accepted when                                                                  |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| Buying                | sale: 3 fields       | `{"scheduledArrival":"2026-10-31 09:35Z","scheduledDeparture":"2026-10-31 07:35Z","status":"Expected"}` | `buyPolicy`                 | status `Expected` or `CheckIn`, departure 2+ h away, signed in the last 15 min |
| Landed                | arrival: 3 fields    | `{"actualArrival":"2026-10-29 18:39Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}`       | `settle`                    | pays if `actualArrival - scheduledArrival >= threshold`, else closes           |
| Cancelled or diverted | status only          | `{"status":"Canceled"}`                                                                                 | `settleCancelledOrDiverted` | status `Canceled` or `Diverted`                                                |

All three are `flightStatusOnDate` for one flight number departing on one local date, with different projections. The
contract builds each request hash itself from the policy's flight number and date, the way the Airnode does, so a
response for another flight, another date or another of the three requests recovers a different signer and reverts.
Then three checks:

1. **The signer.** `AirnodeV2Attestation.verify` recovers the address that signed and compares it with the AeroDataBox
   Airnode address stored in the contract. The `airnode` field of the response is never trusted.
2. **The request.** The derived request hash is part of the signed digest (see above).
3. **The time.** A proof of sale must be at most 15 minutes old, an outcome at most 1 hour.

A cancelled or diverted flight has no actual arrival time, and a missing projection pointer is an error for which
nothing is signed, so those outcomes use the status request. `CanceledUncertain` does not pay: AeroDataBox is not sure
yet.

## Real-world use

**Who needs it.** Self-transfer travellers first. Booking two cheaper tickets and connecting yourself is common with
low-cost carriers and with virtual interlining, and EU 261 does not help: "You're only covered when both flights share a
single booking reference" ([AirHelp](https://www.airhelp.com/en-int/blog/what-are-your-rights-for-self-connecting-flights/)).
Kiwi.com offers [Connection Protection](https://www.kiwi.com/en/help/travel-disruptions-and-cancellations-272/article/what-s-connection-protection-558)
for self-transfers booked with Kiwi.com, which shows the need; FlightGuard covers any two tickets bought anywhere.
Beyond connections: EU 261 compensation starts at 3 hours, needs a claim, takes weeks and excludes extraordinary
circumstances, while shorter delays already cost a missed meeting, train or hotel night.

**Who runs it.** Selling insurance needs a licence. A licensed insurer, an MGA or a travel platform runs the underwriter
agent and funds the pool; FlightGuard is the settlement layer that makes their payouts automatic and verifiable. The
traveller does not have to trust them to pay: the payout is reserved when the policy is bought, and the contract pays it.

**What the data costs.** Each AeroDataBox call costs 0.05 aUSD. A first quote on a flight buys 8 signed responses
(schedule, proof of sale, past dates, 5 past flights): 0.40 aUSD. Every later traveller on that flight reuses the
history and dates, and for 5 minutes the proof of sale too, because a proof of sale is about the flight, not the buyer,
so a quote in that window buys nothing; after it, 0.10 aUSD. Settling buys one signed outcome, 0.05 aUSD (a request
that fails, such as the arrival of a cancelled flight, is not charged), covered by the 0.1 aUSD keeper reward. For a
50 aUSD payout at a 20 % delay probability (premium 12 aUSD), the data of even the first quote on a flight is about 3 %
of the premium. The demo uses 1 aUSD payouts because the faucet is small.

**How the traveller pays.** In this demo with testnet aUSD from their own wallet. In production, in a stablecoin such as
USDC, paid by the platform or the assistant at checkout, with the payout sent to the traveller's wallet minutes after
landing.

**How it reaches travellers.** At checkout on a travel platform, or in the assistant that plans the trip, through the
MCP server below.

## How it works

```
 Underwriter agent                Traveller (or their assistant)    Anyone: keeper agent (watch)      FlightGuard
 ─────────────────                ──────────────────────────────    ────────────────────────────      ───────────
 checks the Airnode publishes
 the signer FlightGuard trusts
 checks the schedule, fetches
 the signed proof of sale
 checks the exposure caps
 buys the flight's history over
 x402, prices it
 signs a quote ─────────────────► buyPolicy(quote, sig, proof) ──────────────────────────────────────► quote signed by the
                                                                                                        underwriter, proof of
                                                                                                        sale signed by the
                                                                                                        Airnode: Expected, 2+ h
                                                                                                        takes the premium,
                                                                                                        reserves payout + reward
                                                                    sleeps until the scheduled
                                                                    arrival, fetches the signed
                                                                    outcome over x402, verifies
                                                                    it off-chain ──────────────────────► settle(...)
                                                                                                        settleCancelledOrDiverted(...)
                                                                                                        pays the traveller if due,
                                                                                                        pays the keeper reward
```

### Pricing

The underwriter agent prices each flight from its own track record, which it buys from AeroDataBox over x402:

1. `flightDates` gives the dates the flight number operated on, so a flight that runs only on some weekdays is priced
   from its own last departures, not from empty calendar days.
2. `flightStatusOnDate` for each of those dates gives how late it arrived: `n` flights with an actual arrival, `k` of
   them at least `threshold` minutes late. Every outcome it buys is kept in `flight-history.json` and reused for free.
3. **Empirical Bayes.** The prior is estimated from every other flight in the agent's history (`m` = smoothed share of
   them at least `threshold` late, worth `s = 4` flights), so a flight with a short record shrinks toward how often
   flights are late in general, not toward a coin flip. Until the agent has seen 10 other flights it uses Beta(1,1).

```
P(delay) = (k + s·m) / (n + s)                         Beta(1,1): s = 2, m = 0.5, which is (k + 1) / (n + 2)
premium  = payout × P(delay) × 1.2 + keeper reward     (20 % margin, risk part at least 0.05 aUSD)
```

The agent explains every number in its output and refuses to sell when:

- the flight is not `Expected` or `CheckIn`, its departure is already revised 15+ minutes late, or it departs within
  2 hours;
- fewer than 2 of its past flights have an actual arrival time in AeroDataBox: the contract settles from that time, so
  the policy might never be settleable;
- the premium would reach the payout: no one should pay that;
- the cover on that flight would exceed 50 % of the pool, or on all flights departing that date 80 %, counting the
  quotes it signed that are still open: one strike or storm hits every policy on a flight, and often every flight on a
  day;
- the AeroDataBox Airnode publishes a different signer from the one FlightGuard trusts: every response would be refused
  on-chain after being paid for.

A quote is valid for 10 minutes and expires before its proof of sale is too old for the contract.

### Self-transfer cover

```
first flight lands (scheduled)                second flight departs (scheduled)
            │◄──────────────── gap: 180 min ─────────────►│
            │◄── threshold: 90 min ──►│◄─ minutes to change: 90 ─►│
```

`quote-connection` reads both schedules and quotes a delay policy on the first flight with
`threshold = gap - minutes to change`: it pays if the first flight lands so late that the traveller cannot make the
second, or if it is cancelled or diverted. The second flight must leave from the airport where the first one lands, and a
connection with less than 15 minutes of slack is not insured.

### Other safeguards

- A quote is signed by the underwriter and binds holder, flight, date, premium, payout, threshold, expiry, nonce, chain
  id and contract address. It can be used once and only by its holder, from the holder's own wallet.
- The payout and the keeper reward are reserved when the policy is bought, so every payout is fully funded: the pool can
  lose money but never fail to pay. The underwriter can never withdraw reserved funds.
- Each policy settles once, on either path. An unsettled policy can be expired 3 days after its date, which releases its
  reserve without a reward; until then, and until someone expires it, it can still be settled.
- The keeper tries the arrival, then the status, and expires a policy only if neither settles it and its window is over.
- The traveller approves exactly the premium, never an unlimited amount.
- The requests pin `dateLocalRole` to `Departure`: with AeroDataBox's default (`Both`), a date can also match the arrival
  date of an overnight flight that departed the day before.
- Flight numbers are restricted to `A-Z0-9`, so the on-chain request hash matches the Airnode's JSON encoding exactly.

### Trust model

- **Not trusted:** whoever submits data, the traveller and the keeper.
- **Trusted:** the AeroDataBox Airnode key and AeroDataBox's data itself. The signature proves where the data came from,
  not that it is right; that is the trust any flight insurance places in its flight data provider.
- **The underwriter** prices and sells; the contract enforces what it signed and the proof of sale. It cannot touch
  reserved payouts.

## Use it from an AI assistant (MCP)

`src/mcp.ts` offers the agent as five tools over the Model Context Protocol:

| Tool                     | What it does                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `quote_flight_cover`     | Prices cover for one flight and explains the price; does not buy                                      |
| `quote_connection_cover` | Prices self-transfer cover for two flights on separate tickets; does not buy                          |
| `buy_cover`              | Buys the last quote from the traveller wallet; the assistant is told to confirm the premium first     |
| `policy_status`          | The pool, the reserve, the traveller's balance and every policy                                       |
| `settle_policies`        | Settles every policy whose flight has landed, been cancelled or diverted, and earns the keeper reward |

In Claude Desktop: Settings > Developer > Edit Config, and add this to `claude_desktop_config.json`, with the output of
`which node` as the command and this project's folder in both paths:

```json
{
  "mcpServers": {
    "flightguard": {
      "command": "/opt/homebrew/bin/node",
      "args": ["--env-file=/Users/you/flight-guard/.env", "/Users/you/flight-guard/src/mcp.ts"]
    }
  }
}
```

Restart Claude Desktop, then ask, for example: "Insure my flight `<flight>` tomorrow for 1 aUSD if it lands 15 minutes
late", or "I land on `<flight>` and fly on with `<flight>` on a separate ticket, I need 90 minutes to change: what would
cover cost?", then "Settle my policies".

## Setup from zero (macOS)

You need Node.js 22.18 or later, pnpm and Foundry.

```sh
# Homebrew, if not installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node
npm install -g pnpm

curl -L https://foundry.paradigm.xyz | bash
echo 'export PATH="$PATH:$HOME/.foundry/bin"' >> ~/.zshrc
export PATH="$PATH:$HOME/.foundry/bin"
foundryup
```

Clone and install:

```sh
git clone --recurse-submodules <this repo> flight-guard
cd flight-guard
pnpm install
forge build
```

### Wallets and test funds

Everything runs on Base Sepolia with test tokens. Use fresh wallets that never hold real funds.

1. Create the underwriter key: `cast wallet new`. It prints an address and a private key.
2. Copy the env file: `cp .env.example .env`, and set `PAYER_PRIVATE_KEY=0x<underwriter private key>`.
3. Get Base Sepolia ETH for gas from the [Coinbase faucet](https://portal.cdp.coinbase.com/products/faucet).
4. Mint 10 aUSD at the [AirnodeHub aUSD faucet](https://airnodehub.api3.org/faucet) (import the key into MetaMask,
   connect, mint).
5. Create a second key for the traveller with `cast wallet new`, add `TRAVELLER_PRIVATE_KEY=0x<traveller private key>`
   to `.env`, and run `node --env-file=.env src/agent.ts fund-traveller` to give it 1.5 aUSD and some ETH for gas.
   Without a traveller key, the underwriter buys its own policies.

## Commands

All commands run from the project folder. The ones that call AeroDataBox cost 0.05 aUSD per call and print the
transaction that settled each payment.

### Tests

```sh
forge test --match-contract FlightGuard   # contract: 53 tests (2 skip until their fixtures exist, see below)
pnpm test                                 # TypeScript: pricing, connections, exposure, Airnode helpers (24 tests)
pnpm e2e                                  # end to end on a local chain (about 4 minutes, needs Foundry)
```

`test/FlightGuard.t.sol` covers the proof of sale (each unsellable status, exactly 2 hours, too old, edited, another
flight or date, wrong key, an arrival or status response used as a proof of sale), both settlement paths and their
tamper cases, the keeper reward on every path, expiry and the pool.

`test/FlightGuardRealData.t.sol` runs the contract against responses the real AeroDataBox Airnode signed: LH400's
arrival and status (included), a real cancelled flight (`find-cancelled`) and a real proof of sale bought through
`buyPolicy` (`fetch-flight --sale`).

`pnpm e2e` copies the project to a temporary folder, replaces the AeroDataBox signer with a local test key in the copy,
starts anvil with Base Sepolia's chain id, deploys with the real deploy script and runs the real agent, keeper, watch,
MCP server and fixture scripts against a stand-in Airnode (`e2e/mock-airnode.mjs`) that signs like AeroDataBox, while
flights depart, land late, are cancelled or are never reported. It checks every outcome on-chain. It uses nothing real:
not `.env`, not Base Sepolia, not aUSD.

### Look at the data

```sh
# Full signed status of a flight, saved to flight-<number>-<date>.json
node --env-file=.env src/explore-flight.ts LH400 2026-10-29

# The exact responses the contract takes, verified and saved to test/fixtures/
node --env-file=.env src/fetch-flight.ts LH400 2026-10-29            # arrival request, for settle
node --env-file=.env src/fetch-flight.ts LH400 2026-10-29 --status   # status request, for settleCancelledOrDiverted
node --env-file=.env src/fetch-flight.ts DE1130 2026-10-31 --sale    # proof of sale, for buyPolicy: 2+ h before departure

# Finds a flight cancelled in the last 12 hours on the departure boards and saves its signed status
node --env-file=.env src/find-cancelled.ts            # default MUC FRA, or name airports: LHR CDG AMS
```

### Deploy

```sh
source .env && forge script script/DeployFlightGuard.s.sol --rpc-url https://sepolia.base.org --broadcast
```

Deploys FlightGuard with the key in `PAYER_PRIVATE_KEY` as underwriter, a keeper reward of 0.1 aUSD, and moves 3 aUSD
into the pool (the underwriter needs 3 aUSD). Then put the new address in `.env`:

```sh
NEW=$(node -e "console.log(require('./broadcast/DeployFlightGuard.s.sol/84532/run-latest.json').transactions.find(t => t.transactionType === 'CREATE').contractAddress)")
echo $NEW
grep -q '^FLIGHTGUARD_ADDRESS=' .env && sed -i '' "s/^FLIGHTGUARD_ADDRESS=.*/FLIGHTGUARD_ADDRESS=$NEW/" .env || echo "FLIGHTGUARD_ADDRESS=$NEW" >> .env
```

(`sed -i ''` is the macOS form; on Linux use `sed -i`.) Without `FLIGHTGUARD_ADDRESS`, the agent uses the deployment
above.

### Agent

| Command                                                                                                | Role        | What it does                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quote <flight> <YYYY-MM-DD> [payout] [threshold] [history]`                                           | underwriter | Checks the data source, the schedule and the exposure caps, fetches the proof of sale, buys the flight's last `history` outcomes (default 5, 2 to 14) unless it has them, prices and signs a quote valid for 10 minutes. Saves it to `quote.json`. Defaults: payout 2 aUSD, threshold 120 minutes. |
| `quote-connection <first flight> <date> <second flight> <date> [payout] [minutes to change] [history]` | underwriter | Self-transfer cover: the same, with the threshold set by the connection. Default 90 minutes to change.                                                                                                                                                                                             |
| `buy`                                                                                                  | traveller   | Approves exactly the premium and buys the policy in `quote.json` with its proof of sale.                                                                                                                                                                                                           |
| `watch [hours]`                                                                                        | keeper      | Runs on its own: sleeps until each flight's scheduled arrival, settles it on whichever path the signed data allows, checks again after the estimated arrival if it is not down yet, picks up policies bought while it runs, and stops when none is left or after `hours` (default 12).             |
| `keeper`                                                                                               | keeper      | The same, once, for every active policy.                                                                                                                                                                                                                                                           |
| `status`                                                                                               | anyone      | The pool, the reserve, the keeper reward, both wallets' aUSD and every policy.                                                                                                                                                                                                                     |
| `fund-traveller [aUSD] [ETH]`                                                                          | underwriter | Sends the traveller aUSD for premiums and ETH for gas (defaults 1.5 and 0.00002).                                                                                                                                                                                                                  |
| `withdraw`                                                                                             | underwriter | Takes back everything in the pool that is not reserved for active policies.                                                                                                                                                                                                                        |

All of them start with `node --env-file=.env src/agent.ts`. On a Mac, run `watch` under `caffeinate -i` so the
computer does not sleep while it waits.

## Demo

```sh
# At least 2 h before departure: price and buy, payout 1 aUSD if 15+ min late, cancelled or diverted
node --env-file=.env src/agent.ts quote <flight> <YYYY-MM-DD> 1 15
node --env-file=.env src/agent.ts buy

# Or a self-transfer: the first flight, then the separately booked second one, 90 minutes to change
node --env-file=.env src/agent.ts quote-connection <first flight> <date> <second flight> <date> 1 90
node --env-file=.env src/agent.ts buy

# Leave the keeper running; it settles each flight when it lands
caffeinate -i node --env-file=.env src/agent.ts watch
node --env-file=.env src/agent.ts status
```

## Deployments

| Version | Address                                                                                                                         |                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v4      | [`0xbce017f3ebccf26bcf28dcf125501b9aafb3d931`](https://sepolia.basescan.org/address/0xbce017f3ebccf26bcf28dcf125501b9aafb3d931) | This code: proof of sale, keeper reward                                                                                                                                                           |
| v3      | [`0x170ED8eeAD82B1a56d7d00938E94b8200Db801B1`](https://sepolia.basescan.org/address/0x170ED8eeAD82B1a56d7d00938E94b8200Db801B1) | Before the proof of sale. Two real policies on DE1130 and DE1598 departing 31 Oct 2026, bought on 30 Oct and left to the watch keeper overnight; their `PolicySettled` events show how they ended |

## Files

| Path                                                                          | What it is                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `contracts/FlightGuard.sol`                                                   | The insurance contract                                                                  |
| `contracts/AirnodeV2Attestation.sol`, `ProjectedJson.sol`, `IsoTimestamp.sol` | Signature check and JSON reading, from the AirnodeHub starter                           |
| `test/FlightGuard.t.sol`                                                      | Unit tests: proof of sale, both settlement paths, tamper cases, keeper reward           |
| `test/FlightGuardRealData.t.sol`                                              | Tests with real AeroDataBox responses                                                   |
| `script/DeployFlightGuard.s.sol`                                              | Deploys and funds the pool                                                              |
| `src/agent.ts`                                                                | Underwriter, traveller and keeper agent                                                 |
| `src/mcp.ts`                                                                  | The agent as tools for an AI assistant                                                  |
| `src/pricing.ts`, `src/pricing.test.ts`                                       | How the agent reads flight data, prices cover and sizes connections, and its unit tests |
| `src/flight.ts`                                                               | The three AeroDataBox requests and their projections, shared by the scripts             |
| `src/fetch-flight.ts`, `src/find-cancelled.ts`, `src/explore-flight.ts`       | Fetch, find and inspect signed flight data                                              |
| `e2e/run.mjs`, `e2e/mock-airnode.mjs`                                         | The end-to-end test and its stand-in Airnode                                            |

## Limitations and next steps

- **A richer prior.** AeroDataBox's airport and route delay statistics are not served on AirnodeHub, so the prior comes
  from the flights the agent has observed. Route and airport rates, and weather from other AirnodeHub listings, would
  sharpen it, and would counter the traveller who knows a storm is coming.
- **The proof of sale cannot show a known delay.** A projection pointer that is missing is an error, and most flights
  have no revised departure time until they are late, so the sale projection leaves it out. The agent checks it off-chain
  before it signs, and the quote expires within 10 minutes.
- **A second data source.** Requiring two independent flight data providers to agree would remove the single trusted
  Airnode key.
- **Exposure caps are the agent's, not the contract's.** Concentration can only hurt the underwriter, because every
  payout is reserved; the contract could enforce the caps too.
- If AeroDataBox reports an arrival without a `revisedTime`, the arrival request fails and the policy can only expire;
  the agent refuses flights whose past arrivals lacked it. Falling back to `runwayTime` would let whoever settles first
  choose the more favourable field.
- AeroDataBox returns a list when one flight number has several legs; the projections read the first one.
- Settlement uses the first final response that anyone submits within its one-hour freshness window.
- Selling insurance needs a licensed carrier. FlightGuard is settlement infrastructure for a licensed insurer or a travel
  platform.

Built on the [AirnodeHub hackathon starter](https://github.com/api3dao/airnodehub-hackathon-starter) (MIT).
