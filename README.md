# FlightGuard

**Parametric flight insurance that settles itself with signed AeroDataBox data: it pays when a flight lands late, is
cancelled or is diverted.**

A traveller buys a policy for a flight. When the flight lands, or is cancelled or diverted, a keeper agent fetches the
flight's status from the AeroDataBox Airnode on AirnodeHub and the contract pays out on its own. Nobody files a claim,
and nobody who submits the data has to be trusted: the contract checks that the AeroDataBox Airnode signed it, for
exactly that flight on exactly that date.

Built for the API3 AirnodeHub track of the TUM Blockchain & AI Hackathon 2026.

| | |
| --- | --- |
| Network | Base Sepolia (chain id 84532) |
| FlightGuard contract | [`0x170ED8eeAD82B1a56d7d00938E94b8200Db801B1`](https://sepolia.basescan.org/address/0x170ED8eeAD82B1a56d7d00938E94b8200Db801B1) |
| Data source | [AeroDataBox on AirnodeHub](https://airnodehub.api3.org/explore/aerodatabox): `flightStatusOnDate`, `flightDates` |
| AeroDataBox Airnode signer | `0x83FE2E8F24E66520B1902C3507De4F471248f2Ec` |
| Payment token | aUSD `0xbeA34973e5f67F18F656A2C6070C64326C791808` |

## Why signed data matters here

Flight insurance is only as honest as its flight data. If the contract accepted a plain JSON from whoever submits it,
anyone could submit "LH400 arrived 3 hours late" or "LH400 was cancelled" and drain the pool. With AirnodeHub, the data
carries a signature from the AeroDataBox Airnode over the request (flight number, date and the fields asked for) and the
time it was signed. The contract recovers the signer itself, so it pays out without trusting the submitter, the
traveller or the underwriter.

## Who it is for

Travel platforms and AI travel agents that sell cover at booking, and pay it out in minutes. EU 261 compensation starts
at 3 hours of delay, needs a claim, takes weeks and excludes weather and other extraordinary circumstances. A parametric
policy pays for any cause as soon as the flight data says so, including the shorter delays that already cost money,
such as a missed connection.

## How it works

```
 Underwriter agent                  Traveller                  Keeper agent (watch)          FlightGuard (Base Sepolia)
 ─────────────────                  ─────────                  ────────────────────          ──────────────────────────
 checks the flight is still sellable
 checks the pool's exposure caps
 buys the flight's past outcomes
 over x402, prices them
 signs a quote ───────────────────► buyPolicy(quote, sig) ─────────────────────────────────► checks the quote signature,
                                                                                             takes the premium,
                                                                                             reserves the payout
                                                               sleeps until the
                                                               scheduled arrival
                                                               fetches signed data
                                                               over x402, verifies it
                                                               off-chain ──────────────────► settle(...)            landed
                                                                                             settleCancelledOrDiverted(...)
                                                                                             1. signer = AeroDataBox Airnode
                                                                                             2. this flight + date + request
                                                                                             3. signed within the last hour
```

### Two signed requests, one per outcome

| Outcome | Request (projection) | Signed data | Contract function | Pays when |
| --- | --- | --- | --- | --- |
| Landed | arrival: 3 fields | `{"actualArrival":"2026-10-29 18:39Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}` | `settle` | `actualArrival - scheduledArrival ≥ threshold` |
| Cancelled or diverted | status only | `{"status":"Canceled"}` | `settleCancelledOrDiverted` | status is `Canceled` or `Diverted` |

A cancelled or diverted flight has no actual arrival time, so AeroDataBox cannot answer the arrival request for it
(a projection pointer that is missing is an error, and nothing is signed). The status request still works. The two
projections give two different request hashes, so a response to one cannot be used on the other path.
`CanceledUncertain` does not pay: AeroDataBox is not sure yet.

### The three checks on both paths

1. **The signer.** `AirnodeV2Attestation.verify` recovers the address that signed and compares it with the AeroDataBox
   Airnode address stored in the contract. The `airnode` field of the response is never trusted.
2. **The request.** The contract builds the request hash itself from the policy's flight number and date
   (`deriveRequestHash`, `deriveStatusRequestHash`), the same way the Airnode does, with `dateLocalRole: Departure`.
   That hash goes into the signed digest, so a real response for another flight, another date or the other projection
   recovers a different signer and reverts.
3. **The time.** The signed `timestamp` must be at most `MAX_RESPONSE_AGE` (1 hour) old.

### Pricing

The underwriter agent prices each flight from its own track record, which it buys from AeroDataBox over x402:

1. `flightDates` gives the dates the flight number operated on, so a flight that runs only on some weekdays is priced
   from its own last N departures, not from empty calendar days.
2. `flightStatusOnDate` for each of those dates gives how late it arrived: `n` flights with an actual arrival, `k` of
   them at least `threshold` minutes late. Every outcome it buys is kept in `flight-history.json` and reused for free,
   for this flight and for every later quote.
3. **Empirical Bayes.** The prior is estimated from every other flight in the agent's history (`m` = smoothed share of
   them at least `threshold` late, worth `s = 4` flights), so a flight with a short record shrinks toward how often
   flights are late in general, not toward a coin flip. Until the agent has seen 10 other flights it uses Beta(1,1).

```
P(delay) = (k + s·m) / (n + s)            Beta(1,1): s = 2, m = 0.5, which is (k + 1) / (n + 2)
premium  = payout × P(delay) × 1.2        (20 % margin, minimum 0.05 aUSD)
```

The agent refuses to sell when:

- the flight has departed, is already known to be 15+ minutes late, or departs within 2 hours;
- fewer than 2 of its past flights have an actual arrival time in AeroDataBox: the contract settles from that time, so
  the policy might never be settleable;
- the premium would reach the payout (P(delay) above 1/1.2): no one should pay that;
- the cover on that flight would exceed 50 % of the pool, or the cover on all flights departing that date would exceed
  80 %: one strike or storm hits every policy on a flight, and often every flight on a day.

A quote is valid for 10 minutes, so there is no time to wait for delay news before buying.

### No cover after departure

1. **The underwriter's cut-off.** The quote's `validUntil` is at most 2 hours before the scheduled departure. The
   underwriter signs it and the contract enforces it, so the traveller cannot extend it.
2. **The contract's backstop.** Whatever the quote says, `buyPolicy` reverts after `latestDepartureAt(dateLocal)`,
   24:00 of that date in UTC-12, the last moment any flight on that local date can depart.

The request pins `dateLocalRole` to `Departure`. With AeroDataBox's default (`Both`), a date can also match the
*arrival* date of an overnight flight that departed the day before.

### Other safeguards

- A quote is signed by the underwriter and binds holder, flight, date, premium, payout, threshold, expiry, nonce, chain
  id and contract address. It can be used once and only by its holder, from the holder's own wallet.
- The payout is reserved when the policy is bought, so every payout is fully funded: the pool can lose money but never
  fail to pay. The underwriter can never withdraw reserved funds.
- Each policy settles once, on either path. An unsettled policy can be expired 3 days after its date, which releases
  its reserve; the keeper does that on its own.
- The traveller approves exactly the premium, never an unlimited amount.
- Flight numbers are restricted to `A–Z0–9` so the on-chain request hash matches the Airnode's JSON encoding exactly.

### Trust model

- **Not trusted:** whoever submits the data, the traveller, and the keeper. Anyone can settle a policy, including the
  traveller, by fetching the signed data over x402.
- **Trusted:** the AeroDataBox Airnode key, which API3 runs for AeroDataBox today, and AeroDataBox's data itself. The
  signature proves where the data came from, not that it is right; that is the trust any flight insurance places in
  its flight data provider. If AeroDataBox runs its own Airnode, only the address changes.
- **The underwriter** prices and sells; the contract enforces what it signed. It cannot touch reserved payouts.

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

All commands run from the project folder.

### Tests

```sh
forge test --match-contract FlightGuard   # contract: 39 tests
pnpm test                                 # TypeScript: pricing and Airnode helpers
```

The contract tests cover buying and its cut-offs, both settlement paths, the pool, and the four tamper cases on each
path (edited value, too old, another request, wrong key), plus using one path's response on the other.
`FlightGuardRealData.t.sol` runs both paths against responses that the real AeroDataBox Airnode signed
(`test/fixtures/flight-LH400-2026-10-29.json`, `test/fixtures/status-LH400-2026-10-29.json`).

### Look at the data

```sh
# Full signed status of a flight, saved to flight-<number>-<date>.json
node --env-file=.env src/explore-flight.ts LH400 2026-10-29

# The exact responses the contract settles with, verified and saved to test/fixtures/
node --env-file=.env src/fetch-flight.ts LH400 2026-10-29            # arrival request, for settle
node --env-file=.env src/fetch-flight.ts LH400 2026-10-29 --status   # status request, for settleCancelledOrDiverted
```

Each call costs 0.05 aUSD and prints the transaction that settled the payment.

### Deploy

```sh
source .env && forge script script/DeployFlightGuard.s.sol --rpc-url https://sepolia.base.org --broadcast
```

Deploys FlightGuard with the key in `PAYER_PRIVATE_KEY` as underwriter and moves 3 aUSD into the pool. Put the printed
address in `.env` as `FLIGHTGUARD_ADDRESS=0x...` to use your own deployment with the agent; without it the agent uses
the deployment above.

### Agent

| Command | Role | What it does |
| --- | --- | --- |
| `quote <flight> <YYYY-MM-DD> [payout] [threshold] [history]` | underwriter | Checks the flight is still sellable and the pool's exposure caps, buys the flight's last `history` outcomes (default 5, 2 to 14) over x402 unless it has them already, prices with the empirical-Bayes prior and signs a quote for the traveller, valid for 10 minutes. Saves it to `quote.json`. Defaults: payout 2 aUSD, threshold 120 minutes. |
| `buy` | traveller | Approves exactly the premium and buys the policy in `quote.json` from the traveller's wallet. |
| `watch [hours]` | keeper | Runs on its own: sleeps until each flight's scheduled arrival, then settles it on whichever path the signed data allows, checks again after the estimated arrival if it is not down yet, expires policies whose window is over, and stops when none is left or after `hours` (default 12). |
| `keeper` | keeper | The same, once, for every active policy. |
| `status` | anyone | Shows the pool, the reserve, both wallets' aUSD and every policy. |
| `fund-traveller [aUSD] [ETH]` | underwriter | Sends the traveller aUSD for premiums and ETH for gas (defaults 1.5 and 0.00002). |
| `withdraw` | underwriter | Takes back everything in the pool that is not reserved for active policies. |

All of them start with `node --env-file=.env src/agent.ts`. On a Mac, run `watch` under `caffeinate -i` so the
computer does not sleep while it waits.

## Demo

```sh
# At least 2 h before departure: price and buy, payout 1 aUSD if 15+ min late, cancelled or diverted
node --env-file=.env src/agent.ts quote <flight> <YYYY-MM-DD> 1 15 5
node --env-file=.env src/agent.ts buy

# Leave the keeper running; it settles each flight when it lands
caffeinate -i node --env-file=.env src/agent.ts watch
node --env-file=.env src/agent.ts status
```

## Files

| Path | What it is |
| --- | --- |
| `contracts/FlightGuard.sol` | The insurance contract |
| `contracts/AirnodeV2Attestation.sol`, `ProjectedJson.sol`, `IsoTimestamp.sol` | Signature check and JSON reading, from the AirnodeHub starter |
| `test/FlightGuard.t.sol` | Unit tests and the tamper cases on both paths |
| `test/FlightGuardRealData.t.sol` | Tests with real AeroDataBox responses |
| `script/DeployFlightGuard.s.sol` | Deploys and funds the pool |
| `src/agent.ts` | Underwriter, traveller and keeper agent |
| `src/pricing.ts`, `src/pricing.test.ts` | How the agent reads flight data and prices cover, and its unit tests |
| `src/flight.ts` | The two AeroDataBox requests and their projections, shared by the scripts |
| `src/fetch-flight.ts`, `src/explore-flight.ts` | Fetch and inspect signed flight data |

## Limitations and next steps

- **Prove the flight was sellable on-chain.** Today the underwriter's agent checks the schedule and signs the cut-off.
  `buyPolicy` could also take a fresh signed status response and require `Expected`, so the contract itself verifies
  that the flight had not departed or been cancelled at purchase.
- **A richer prior.** AeroDataBox's airport and route delay statistics are not served on AirnodeHub, so the prior comes
  from the flights the agent has observed. Route and airport rates, and weather from other AirnodeHub listings, would
  sharpen it.
- **A second data source.** Requiring two independent flight data providers to agree would remove the single trusted
  Airnode key.
- If AeroDataBox reports an arrival without a `revisedTime`, the arrival request fails and the policy can only expire.
  Falling back to `runwayTime` would let whoever settles first choose the more favourable field, because there is no
  signed proof that a field is missing; the agent instead refuses flights whose past arrivals lacked the time.
- AeroDataBox returns a list when one flight number has several legs; both projections read the first one.
- Settlement uses the first final response that anyone submits within its one-hour freshness window.
- An LLM front end that turns "insure my flight to Palma tomorrow" into a quote, with the AirnodeHub MCP server for
  discovery. Pricing stays deterministic, because a premium must be auditable.
- Selling insurance needs a licensed carrier. FlightGuard is settlement infrastructure for a licensed insurer or a
  travel platform.

Built on the [AirnodeHub hackathon starter](https://github.com/api3dao/airnodehub-hackathon-starter) (MIT).
