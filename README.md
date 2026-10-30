# FlightGuard

**Parametric flight delay insurance that settles itself with signed AeroDataBox data.**

A traveller buys a policy for a flight. If the flight lands late, a keeper agent fetches the flight's status from the
AeroDataBox Airnode on AirnodeHub, and the contract pays out on its own. Nobody files a claim and nobody has to be
trusted: the contract checks that the AeroDataBox Airnode signed the data, for exactly that flight on exactly that date.

Built for the API3 AirnodeHub track of the TUM Blockchain & AI Hackathon 2026.

| | |
| --- | --- |
| Network | Base Sepolia (chain id 84532) |
| FlightGuard contract | [`0xE12a3238ca345b45d34D4A8E9A244228EdfcBc73`](https://sepolia.basescan.org/address/0xE12a3238ca345b45d34D4A8E9A244228EdfcBc73) |
| Data source | [AeroDataBox on AirnodeHub](https://airnodehub.api3.org/explore/aerodatabox), `flightStatusOnDate` |
| AeroDataBox Airnode signer | `0x83FE2E8F24E66520B1902C3507De4F471248f2Ec` |
| Payment token | aUSD `0xbeA34973e5f67F18F656A2C6070C64326C791808` |

## Why signed data matters here

Flight delay insurance is only as honest as its delay data. If the contract accepted a plain JSON from whoever submits
it, anyone could submit "LH400 arrived 3 hours late" and drain the pool. With AirnodeHub, the data carries a signature
from the AeroDataBox Airnode over the request (flight number, date and the fields asked for) and the time it was signed.
The contract recovers the signer itself, so it can pay out without trusting the submitter, the traveller or us.

## How it works

```
 Underwriter agent                 Traveller                    Keeper agent                 FlightGuard (Base Sepolia)
 ─────────────────                 ─────────                    ────────────                 ──────────────────────────
 buys N days of flight history
 from AeroDataBox over x402
 estimates P(delay ≥ threshold)
 signs a quote ──────────────────► buyPolicy(quote, sig) ──────────────────────────────────► checks quote signature,
                                                                                             takes premium, reserves payout,
                                                                                             derives the request hash
                                                               flight lands
                                                               fetches signed status
                                                               over x402, verifies it
                                                               off-chain ──────────────────► settle(id, timestamp, data, sig)
                                                                                             1. signer = AeroDataBox Airnode
                                                                                             2. for this flight + date
                                                                                             3. signed within the last hour
                                                                                             pays out if delay ≥ threshold
```

### The three checks in `settle`

1. **The signer.** `AirnodeV2Attestation.verify` recovers the address that signed and compares it with the AeroDataBox
   Airnode address stored in the contract. The `airnode` field of the response is never trusted.
2. **The request.** The contract builds the request hash itself from the policy's flight number and date
   (`deriveRequestHash`), the same way the Airnode does, with `dateLocalRole: Departure`. That hash goes into the signed digest, so a real response for
   another flight or another date recovers a different signer and reverts.
3. **The time.** The signed `timestamp` must be at most `MAX_RESPONSE_AGE` (1 hour) old.

The signed data is projected to exactly three fields, so the contract knows what it reads:

```json
{"actualArrival":"2026-10-29 18:39Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}
```

### Pricing

The underwriter agent prices each flight from its own track record, which it buys from AeroDataBox over x402:

1. `flightDates` gives the dates the flight number operated on, so a flight that runs only on some weekdays is priced
   from its own last N departures, not from empty calendar days.
2. `flightStatusOnDate` for each of those dates gives how late it arrived (`n` flights with an actual arrival, `k` of
   them at least `threshold` minutes late).
3. The probability uses a Beta(1,1) prior, so a short history never gives zero:

```
P(delay) = (k + 1) / (n + 2)
premium  = payout × P(delay) × 1.2        (20 % margin, minimum 0.05 aUSD)
```

The agent refuses to sell when:

- fewer than 2 of the past flights have an actual arrival time in AeroDataBox: the contract settles from that time,
  so the policy might never be settleable;
- the premium would reach the payout (P(delay) above 1/1.2): no one should pay that.

A quote is valid for 10 minutes, so there is no time to wait for delay news before buying.

### No cover after departure

A traveller must never be able to insure a flight that is already late. FlightGuard closes sales before departure in
two layers:

1. **The underwriter's cut-off.** Before quoting, the agent buys the flight's schedule for that date. It refuses if
   the status is not `Expected`, `Unknown` or `CheckIn`, if the departure is already revised 15+ minutes late, or if
   departure is less than 2 hours away. The quote's `validUntil` is at most 2 hours before the scheduled departure.
   The underwriter signs it and the contract enforces it, so the traveller cannot extend it.
2. **The contract's backstop.** Whatever the quote says, `buyPolicy` reverts after `latestDepartureAt(dateLocal)`,
   24:00 of that date in UTC-12, the last moment any flight on that local date can depart.

The request also pins `dateLocalRole` to `Departure`. With AeroDataBox's default (`Both`), a date can match the
*arrival* date of an overnight flight that departed the day before.

### Other safeguards

- A quote is signed by the underwriter and binds holder, flight, date, premium, payout, threshold, expiry, nonce, chain
  id and contract address. It can be used once and only by its holder.
- The payout is reserved when the policy is bought. The underwriter can never withdraw reserved funds.
- Each policy settles once. An unsettled policy (for example a cancelled flight) can be expired 3 days after its date,
  which releases its reserve.
- Flight numbers are restricted to `A–Z0–9` so the on-chain request hash matches the Airnode's JSON encoding exactly.

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

### Wallet and test funds

Everything runs on Base Sepolia with test tokens. Use a fresh wallet that never holds real funds.

1. Create a key: `cast wallet new`. It prints an address and a private key.
2. Copy the env file: `cp .env.example .env`, and set the last line to `PAYER_PRIVATE_KEY=0x<your private key>`.
3. Get Base Sepolia ETH for gas from the [Coinbase faucet](https://portal.cdp.coinbase.com/products/faucet).
4. Mint 10 aUSD at the [AirnodeHub aUSD faucet](https://airnodehub.api3.org/faucet) (import the key into MetaMask,
   connect, mint).

## Commands

All commands run from the project folder.

### Tests

```sh
forge test --match-contract FlightGuard
```

27 tests: buying and its cut-offs, settling, the pool, and the four tamper cases (edited value, too old, another request, wrong key).
`FlightGuardRealData.t.sol` settles policies with a response that the real AeroDataBox Airnode signed
(`test/fixtures/flight-LH400-2026-10-29.json`).

### Look at the data

```sh
# Full signed status of a flight, saved to flight-<number>-<date>.json
node --env-file=.env src/explore-flight.ts LH400 2026-10-29

# The exact projected response that settle() takes, verified and saved to test/fixtures/
node --env-file=.env src/fetch-flight.ts LH400 2026-10-29
```

Each call costs 0.05 aUSD and prints the transaction that settled the payment.

### Deploy

```sh
source .env && forge script script/DeployFlightGuard.s.sol --rpc-url https://sepolia.base.org --broadcast
```

Deploys FlightGuard with the key in `PAYER_PRIVATE_KEY` as underwriter and moves 5 aUSD into the pool. Put the printed
address in `.env` as `FLIGHTGUARD_ADDRESS=0x...` to use your own deployment with the agent; without it the agent uses
the deployment above.

### Agent

```sh
node --env-file=.env src/agent.ts quote <flight> <YYYY-MM-DD> [payout aUSD] [threshold minutes] [history flights]
node --env-file=.env src/agent.ts buy
node --env-file=.env src/agent.ts keeper
node --env-file=.env src/agent.ts status
```

| Command | What it does |
| --- | --- |
| `quote` | Checks the flight's schedule for that date and refuses if it has departed, is already late or leaves within 2 hours. Looks up the dates the flight operated on, buys its last `history` flights (default 5, 2 to 14) over x402, prices the policy and signs a quote as underwriter, valid for 10 minutes and never past 2 hours before departure. Refuses if the flight's arrivals are not reported or the premium would reach the payout. Saves the quote to `quote.json`. Defaults: payout 2 aUSD, threshold 120 minutes. |
| `buy` | Approves exactly the premium in aUSD and buys the policy in `quote.json`. |
| `keeper` | For every active policy, fetches the signed flight status over x402, verifies it off-chain, and calls `settle`. Skips flights that have not landed yet. `keeper --file <response.json>` submits a saved response instead. |
| `status` | Shows the pool, the reserved amount and every policy with its status. |
| `withdraw` | Underwriter only: takes back everything in the pool that is not reserved for active policies. |

## Demo

Insure a flight that has not departed yet, then settle it after it lands:

```sh
# Before departure (at least 2 h): price and buy, payout 1 aUSD if 15+ min late
node --env-file=.env src/agent.ts quote <flight> <YYYY-MM-DD> 1 15 5
node --env-file=.env src/agent.ts buy

# After landing: the keeper settles every active policy with signed AeroDataBox data
node --env-file=.env src/agent.ts keeper
node --env-file=.env src/agent.ts status
```

## Files

| Path | What it is |
| --- | --- |
| `contracts/FlightGuard.sol` | The insurance contract |
| `contracts/AirnodeV2Attestation.sol`, `ProjectedJson.sol`, `IsoTimestamp.sol` | Signature check and JSON reading, from the AirnodeHub starter |
| `test/FlightGuard.t.sol` | Unit tests and the four tamper cases |
| `test/FlightGuardRealData.t.sol` | Tests with a real AeroDataBox response |
| `script/DeployFlightGuard.s.sol` | Deploys and funds the pool |
| `src/agent.ts` | Underwriter, buyer and keeper agent |
| `src/flight.ts` | The AeroDataBox request and its projection, shared by the scripts |
| `src/fetch-flight.ts`, `src/explore-flight.ts` | Fetch and inspect signed flight data |

## Limitations and next steps

- **Cancelled and diverted flights are not covered.** They never reach `Arrived`, so they cannot settle; the policy
  expires after 3 days and the reserve returns to the pool. Covering them needs a second projection on the status.
- If AeroDataBox has no `revisedTime` for an arrival, the projected request fails and the policy can only expire.
  A second projection on `runwayTime` would cover that case.
- AeroDataBox returns a list when one flight number has several legs; the projection reads the first one.
- Settlement uses the first `Arrived` response that anyone submits within its one-hour freshness window.
- The Airnode signature proves that the data came from the AeroDataBox Airnode, not that AeroDataBox is right. That is
  the same trust any delay insurance places in its flight data provider.
- In the demo the underwriter and the traveller are the same wallet. They are separate roles in the contract.
- The pricing model uses only the same flight's recent history. Route, airport and weather data from other AirnodeHub
  listings would sharpen it.
- A flight that AeroDataBox reported well in the past can still miss an arrival time; the underwriter carries that
  risk, and the policy expires with its reserve returned to the pool.

Built on the [AirnodeHub hackathon starter](https://github.com/api3dao/airnodehub-hackathon-starter) (MIT).
