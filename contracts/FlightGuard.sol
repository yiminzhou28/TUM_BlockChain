// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {AirnodeV2Attestation} from "./AirnodeV2Attestation.sol";
import {IsoTimestamp} from "./IsoTimestamp.sol";
import {ProjectedJson} from "./ProjectedJson.sol";

/// @title FlightGuard: parametric flight delay insurance settled by signed AeroDataBox data
/// @notice An underwriter agent prices a policy and signs a quote. The traveller buys it with the quote. After the flight
/// lands, anyone (usually a keeper agent) submits the AeroDataBox response that the Airnode signed, and the contract
/// pays out if the flight arrived at least `delayThresholdMinutes` late. Nobody has to trust whoever submits the data:
/// the contract checks that the AeroDataBox Airnode signed it, for exactly this flight on exactly this date.
contract FlightGuard {
    using SafeERC20 for IERC20;

    /// @notice Address that the AeroDataBox Airnode v2 signs with, from the x-airnode extension at its URL
    address public immutable airnode;

    /// @notice Token that premiums and payouts are paid in, such as aUSD
    IERC20 public immutable token;

    /// @notice Address that owns the pool and whose agent signs quotes
    address public immutable underwriter;

    /// @notice Longest time from the Airnode signing a response to the contract accepting it
    uint256 public constant MAX_RESPONSE_AGE = 1 hours;

    /// @notice After this long past the flight date, an unsettled policy can be expired and its reserve released
    uint256 public constant SETTLEMENT_WINDOW = 3 days;

    // The projection the request hash commits to. Pointers into the first (operating) flight of the list.
    string private constant PROJECTION =
        '[["actualArrival","/0/arrival/revisedTime/utc"],["scheduledArrival","/0/arrival/scheduledTime/utc"],["status","/0/status"]]';

    struct Quote {
        address holder;
        string flightNumber; // such as LH400, upper case letters and digits only
        string dateLocal; // departure date local to the airport, YYYY-MM-DD
        uint256 premium;
        uint256 payout;
        uint256 delayThresholdMinutes;
        uint256 validUntil; // Unix seconds after which the quote cannot be used, set before the scheduled departure
        uint256 nonce;
    }

    enum Status {
        None,
        Active,
        PaidOut,
        ClosedOnTime,
        Expired
    }

    struct Policy {
        address holder;
        bytes32 requestHash;
        uint256 payout;
        uint256 delayThresholdMinutes;
        uint256 settleBy;
        Status status;
        string flightNumber;
        string dateLocal;
    }

    Policy[] public policies;
    uint256 public totalReserved;
    mapping(bytes32 => bool) public usedQuotes;

    event PolicyBought(uint256 indexed policyId, address indexed holder, string flightNumber, string dateLocal, uint256 premium, uint256 payout);
    event PolicySettled(uint256 indexed policyId, Status status, uint256 delayMinutes, uint256 paid);
    event PolicyExpired(uint256 indexed policyId);

    error InvalidQuoteSignature();
    error QuoteExpired();
    error QuoteAlreadyUsed();
    error NotQuoteHolder();
    error InvalidFlightNumber();
    error InvalidDate();
    error InsufficientPool(uint256 available, uint256 needed);
    error PolicyNotActive(uint256 policyId);
    error ResponseTooOld(uint256 responseTimestamp);
    error FlightNotArrived(string status);
    error SettlementWindowOpen(uint256 settleBy);
    error NotUnderwriter();
    error TooLateToBuy(uint256 latestDeparture);

    constructor(address airnode_, IERC20 token_, address underwriter_) {
        airnode = airnode_;
        token = token_;
        underwriter = underwriter_;
    }

    // ---------------------------------------------------------------- buying

    /// @notice Buys a policy with a quote that the underwriter signed. Pulls the premium, reserves the payout.
    function buyPolicy(Quote calldata quote, bytes calldata underwriterSignature) external returns (uint256 policyId) {
        if (msg.sender != quote.holder) revert NotQuoteHolder();
        if (block.timestamp > quote.validUntil) revert QuoteExpired();
        // The underwriter sets validUntil from the flight's scheduled departure, before which it must be bought, and signs
        // it, so the traveller cannot insure a flight that has already departed. As a backstop the contract refuses any
        // purchase after the last moment a flight on that local date could depart anywhere on Earth.
        uint256 latestDeparture = latestDepartureAt(quote.dateLocal);
        if (block.timestamp >= latestDeparture) revert TooLateToBuy(latestDeparture);
        bytes32 quoteHash = hashQuote(quote);
        if (usedQuotes[quoteHash]) revert QuoteAlreadyUsed();
        if (ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(quoteHash), underwriterSignature) != underwriter) {
            revert InvalidQuoteSignature();
        }
        usedQuotes[quoteHash] = true;

        // The premium joins the pool before the payout is reserved from it.
        token.safeTransferFrom(msg.sender, address(this), quote.premium);
        uint256 available = availableLiquidity();
        if (available < quote.payout) revert InsufficientPool(available, quote.payout);
        totalReserved += quote.payout;

        policyId = policies.length;
        policies.push(
            Policy({
                holder: quote.holder,
                requestHash: deriveRequestHash(quote.flightNumber, quote.dateLocal),
                payout: quote.payout,
                delayThresholdMinutes: quote.delayThresholdMinutes,
                settleBy: IsoTimestamp.parse(quote.dateLocal) + SETTLEMENT_WINDOW,
                status: Status.Active,
                flightNumber: quote.flightNumber,
                dateLocal: quote.dateLocal
            })
        );
        emit PolicyBought(policyId, quote.holder, quote.flightNumber, quote.dateLocal, quote.premium, quote.payout);
    }

    /// @notice The last moment a flight on a local departure date can depart: 24:00 of that date in UTC-12, the
    /// latest time zone on Earth, which is 36 hours after 00:00 UTC of the date.
    /// @dev A backstop only. The real cut-off is the quote's validUntil, which the underwriter sets before the
    /// scheduled departure of the flight.
    function latestDepartureAt(string calldata dateLocal) public pure returns (uint256) {
        return IsoTimestamp.parse(dateLocal) + 36 hours;
    }

    /// @notice What the underwriter signs, with EIP-191. Binds the quote to this contract and this chain.
    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                q.holder,
                keccak256(bytes(q.flightNumber)),
                keccak256(bytes(q.dateLocal)),
                q.premium,
                q.payout,
                q.delayThresholdMinutes,
                q.validUntil,
                q.nonce
            )
        );
    }

    // ---------------------------------------------------------------- settling

    /// @notice Settles a policy with the signed AeroDataBox response for its flight. Anyone can call it.
    /// @param timestamp `timestamp` of the response
    /// @param data `data` of the response, the projected JSON string exactly as the Airnode signed it
    /// @param signature `signature` of the response
    function settle(uint256 policyId, uint256 timestamp, bytes calldata data, bytes calldata signature) external {
        Policy storage policy = policies[policyId];
        if (policy.status != Status.Active) revert PolicyNotActive(policyId);

        // 1. Signer and request: the stored request hash goes into the digest, so a response for another flight or
        //    another date, or one signed by any other key, recovers a different signer and reverts.
        AirnodeV2Attestation.verify(airnode, policy.requestHash, timestamp, data, signature);
        // 2. Time: the signature covers the timestamp, so it can be trusted from here on.
        if (timestamp + MAX_RESPONSE_AGE < block.timestamp) revert ResponseTooOld(timestamp);

        // 3. The data. The request hash fixes the projection, so these three fields are there.
        string memory flightStatus = ProjectedJson.readString(data, "status");
        if (keccak256(bytes(flightStatus)) != keccak256("Arrived")) revert FlightNotArrived(flightStatus);
        uint256 scheduledArrival = ProjectedJson.readTimestamp(data, "scheduledArrival");
        uint256 actualArrival = ProjectedJson.readTimestamp(data, "actualArrival");
        uint256 delayMinutes = actualArrival > scheduledArrival ? (actualArrival - scheduledArrival) / 60 : 0;

        totalReserved -= policy.payout;
        if (delayMinutes >= policy.delayThresholdMinutes) {
            policy.status = Status.PaidOut;
            token.safeTransfer(policy.holder, policy.payout);
            emit PolicySettled(policyId, Status.PaidOut, delayMinutes, policy.payout);
        } else {
            policy.status = Status.ClosedOnTime;
            emit PolicySettled(policyId, Status.ClosedOnTime, delayMinutes, 0);
        }
    }

    /// @notice Releases the reserve of a policy that nobody settled in time, such as for a cancelled flight
    function expire(uint256 policyId) external {
        Policy storage policy = policies[policyId];
        if (policy.status != Status.Active) revert PolicyNotActive(policyId);
        if (block.timestamp <= policy.settleBy) revert SettlementWindowOpen(policy.settleBy);
        policy.status = Status.Expired;
        totalReserved -= policy.payout;
        emit PolicyExpired(policyId);
    }

    // ---------------------------------------------------------------- pool

    function availableLiquidity() public view returns (uint256) {
        return token.balanceOf(address(this)) - totalReserved;
    }

    /// @notice The underwriter takes out what is not reserved for active policies
    function withdraw(uint256 amount) external {
        if (msg.sender != underwriter) revert NotUnderwriter();
        uint256 available = availableLiquidity();
        if (available < amount) revert InsufficientPool(available, amount);
        token.safeTransfer(msg.sender, amount);
    }

    function policyCount() external view returns (uint256) {
        return policies.length;
    }

    // ---------------------------------------------------------------- request hash

    /// @notice The hash of the AeroDataBox request for a flight departing on a date, built the way the Airnode builds it:
    /// keccak256(JSON.stringify([operation, parameterEntriesSortedByName, projectionEntriesSortedByName]))
    /// @dev Building it here means the traveller cannot buy a policy for one flight and settle it with another.
    /// dateLocalRole is pinned to Departure: with the default (Both), the date could also match the arrival date of an
    /// overnight flight that departed the day before, after sales closed for its real departure date.
    function deriveRequestHash(string memory flightNumber, string memory dateLocal) public pure returns (bytes32) {
        _checkFlightNumber(flightNumber);
        _checkDate(dateLocal);
        return keccak256(
            bytes(
                string.concat(
                    '["flightStatusOnDate",[["dateLocal","',
                    dateLocal,
                    '"],["dateLocalRole","Departure"],["searchBy","number"],["searchParam","',
                    flightNumber,
                    '"]],',
                    PROJECTION,
                    "]"
                )
            )
        );
    }

    // Only characters that JSON.stringify leaves as they are, so the string above is what the Airnode hashed.
    function _checkFlightNumber(string memory flightNumber) private pure {
        bytes memory b = bytes(flightNumber);
        if (b.length < 3 || b.length > 8) revert InvalidFlightNumber();
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            if (!((c >= "A" && c <= "Z") || (c >= "0" && c <= "9"))) revert InvalidFlightNumber();
        }
    }

    function _checkDate(string memory dateLocal) private pure {
        bytes memory b = bytes(dateLocal);
        if (b.length != 10 || b[4] != "-" || b[7] != "-") revert InvalidDate();
        for (uint256 i; i < 10; i++) {
            if (i == 4 || i == 7) continue;
            if (b[i] < "0" || b[i] > "9") revert InvalidDate();
        }
    }
}
