# FlightGuard

**Parametric flight delay insurance that settles itself with signed AeroDataBox data.**

A traveller buys a policy for a flight. If the flight lands late, a keeper agent fetches the flight's status from the
AeroDataBox Airnode on AirnodeHub, and the contract pays out on its own. Nobody files a claim and nobody has to be
trusted: the contract checks that the AeroDataBox Airnode signed the data, for exactly that flight on exactly that date.

Built for the API3 AirnodeHub track of the TUM Blockchain & AI Hackathon 2026.

| | |
| --- | --- |
| Network | Base Sepolia (chain id 84532) |
| FlightGuard contract | [`0x1Ff69Fd5D73cA61095421E6c67aDB5AF0479976A`](https://sepolia.basescan.org/address/0x1Ff69Fd5D73cA61095421E6c67aDB5AF0479976A) |
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
   (`deriveRequestHash`), the same way the Airnode does. That hash goes into the signed digest, so a real response for
   another flight or another date recovers a different signer and reverts.
3. **The time.** The signed `timestamp` must be at most `MAX_RESPONSE_AGE` (1 hour) old.

The signed data is projected to exactly three fields, so the contract knows what it reads:

```json
{"actualArrival":"2026-10-29 18:39Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}
```

### Pricing

The underwriter agent buys the last N days of the same flight from AeroDataBox (0.05 aUSD per call over x402),
counts how many of the `n` observed flights arrived at least `threshold` minutes late (`k`), and prices with a
Beta(1,1) prior so a short history never gives a zero price:

```
P(delay) = (k + 1) / (n + 2)
premium  = payout × P(delay) × 1.2        (20 % margin, minimum 0.05 aUSD)
```

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

22 tests: buying, settling, the pool, and the four tamper cases (edited value, too old, another request, wrong key).
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
node --env-file=.env src/agent.ts quote <flight> <YYYY-MM-DD> [payout aUSD] [threshold minutes] [history days]
node --env-file=.env src/agent.ts buy
node --env-file=.env src/agent.ts keeper
node --env-file=.env src/agent.ts status
```

| Command | What it does |
| --- | --- |
| `quote` | Buys `history days` (default 5) of the flight's history over x402, estimates the delay probability, prices the policy and signs a quote as underwriter. Saves it to `quote.json`. Defaults: payout 2 aUSD, threshold 120 minutes. |
| `buy` | Approves aUSD if needed and buys the policy in `quote.json`. |
| `keeper` | For every active policy, fetches the signed flight status over x402, verifies it off-chain, and calls `settle`. Skips flights that have not landed yet. `keeper --file <response.json>` submits a saved response instead. |
| `status` | Shows the pool, the reserved amount and every policy with its status. |

## Demo

```sh
node --env-file=.env src/agent.ts quote LH400 2026-10-29 2 3 5   # price: payout 2 aUSD if 3+ min late
node --env-file=.env src/agent.ts buy                            # buy the policy
node --env-file=.env src/agent.ts keeper                         # LH400 landed 4 min late -> pays out
node --env-file=.env src/agent.ts status                         # policy shows PaidOut
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

- **The demo insures a flight that has already landed**, so settlement can be shown live. In production the underwriter
  agent would only quote flights that have not departed; the contract would also check that `dateLocal` is in the
  future at purchase time.
- In the demo the underwriter and the traveller are the same wallet. They are separate roles in the contract.
- AeroDataBox returns a list when one flight number has several legs; the projection reads the first one.
- If AeroDataBox has no `revisedTime` for an arrival, the projected request fails and the policy can only expire.
  A second projection on `runwayTime` would cover that case.
- The pricing model uses only the same flight's recent history. Route, airport and weather data from other AirnodeHub
  listings would sharpen it.

Built on the [AirnodeHub hackathon starter](https://github.com/api3dao/airnodehub-hackathon-starter) (MIT).
