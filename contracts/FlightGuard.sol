// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {AirnodeV2Attestation} from "./AirnodeV2Attestation.sol";
import {IsoTimestamp} from "./IsoTimestamp.sol";
import {ProjectedJson} from "./ProjectedJson.sol";

/// @title FlightGuard: parametric flight insurance where both the sale and the claim are proven by signed AeroDataBox data
/// @notice An underwriter agent prices a policy and signs a quote. The traveller buys it with the quote and a fresh
/// AeroDataBox response showing that the flight is still expected and at least two hours from departure, so nobody can
/// insure a flight that is already in trouble. After the flight, anyone submits the signed outcome and the contract pays
/// out if the flight arrived at least `delayThresholdMinutes` late, was cancelled or was diverted. Whoever settles is paid
/// a keeper reward, so payouts do not depend on the underwriter's goodwill. Nobody who submits data has to be trusted:
/// the contract checks that the AeroDataBox Airnode signed it, for exactly this flight on exactly this date.
contract FlightGuard {
    using SafeERC20 for IERC20;

    /// @notice Address that the AeroDataBox Airnode v2 signs with, from the x-airnode extension at its URL
    address public immutable airnode;

    /// @notice Token that premiums, payouts and keeper rewards are paid in, such as aUSD
    IERC20 public immutable token;

    /// @notice Address that owns the pool and whose agent signs quotes
    address public immutable underwriter;

    /// @notice Paid from the pool to whoever settles a policy, which covers buying the signed outcome. It is reserved
    /// together with the payout when the policy is bought.
    uint256 public immutable keeperReward;

    /// @notice Longest time from the Airnode signing a response to the contract accepting it as an outcome
    uint256 public constant MAX_RESPONSE_AGE = 1 hours;

    /// @notice Longest time from the Airnode signing the proof of sale to the purchase
    uint256 public constant MAX_SALE_PROOF_AGE = 15 minutes;

    /// @notice Sales close this long before the scheduled departure in the signed proof of sale
    uint256 public constant SALES_CLOSE_BEFORE_DEPARTURE = 2 hours;

    /// @notice After this long past the flight date, an unsettled policy can be expired and its reserve released
    uint256 public constant SETTLEMENT_WINDOW = 3 days;

    // The three requests this contract accepts. All are flightStatusOnDate for one flight number departing on one local
    // date; they differ in their projection, so a response to one can never be used as another.

    // At purchase: the flight is still expected, and when it departs
    string private constant SALE_PROJECTION =
        '[["scheduledArrival","/0/arrival/scheduledTime/utc"],["scheduledDeparture","/0/departure/scheduledTime/utc"],["status","/0/status"]]';

    // At settlement, for a flight that landed: when it arrived against when it should have
    string private constant PROJECTION =
        '[["actualArrival","/0/arrival/revisedTime/utc"],["scheduledArrival","/0/arrival/scheduledTime/utc"],["status","/0/status"]]';

    // At settlement, for a flight that was cancelled or diverted: it has no actual arrival time, only its status
    string private constant STATUS_PROJECTION = '[["status","/0/status"]]';

    struct Quote {
        address holder;
        string flightNumber; // such as LH400, upper case letters and digits only
        string dateLocal; // departure date local to the airport, YYYY-MM-DD
        uint256 premium;
        uint256 payout;
        uint256 delayThresholdMinutes;
        uint256 validUntil; // Unix seconds after which the quote cannot be used
        uint256 nonce;
    }

    /// @notice A response that the Airnode signed: its `timestamp`, its `data` as the JSON string it signed, and its
    /// `signature`. The request it answers is not part of it: the contract derives that itself.
    struct AirnodeResponse {
        uint256 timestamp;
        bytes data;
        bytes signature;
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

    event PolicyBought(
        uint256 indexed policyId,
        address indexed holder,
        string flightNumber,
        string dateLocal,
        uint256 premium,
        uint256 payout
    );
    event PolicySettled(uint256 indexed policyId, Status status, uint256 delayMinutes, uint256 paid);
    event PolicyPaidForNoArrival(uint256 indexed policyId, string flightStatus, uint256 paid);
    event KeeperRewarded(uint256 indexed policyId, address indexed keeper, uint256 reward);
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
    error SaleProofTooOld(uint256 responseTimestamp);
    error FlightNotSellable(string status);
    error TooCloseToDeparture(uint256 scheduledDeparture);
    error FlightNotArrived(string status);
    error FlightNotCancelledOrDiverted(string status);
    error SettlementWindowOpen(uint256 settleBy);
    error NotUnderwriter();
    error ZeroAddress();

    constructor(address airnode_, IERC20 token_, address underwriter_, uint256 keeperReward_) {
        if (airnode_ == address(0) || address(token_) == address(0) || underwriter_ == address(0)) {
            revert ZeroAddress();
        }
        airnode = airnode_;
        token = token_;
        underwriter = underwriter_;
        keeperReward = keeperReward_;
    }

    // ---------------------------------------------------------------- buying

    /// @notice Buys a policy with a quote that the underwriter signed and a fresh signed proof that the flight is still
    /// sellable. Pulls the premium and reserves the payout and the keeper reward.
    /// @param saleProof A response to the sale request for this flight on this date, signed at most
    /// `MAX_SALE_PROOF_AGE` ago, with status Expected or CheckIn and a scheduled departure at least
    /// `SALES_CLOSE_BEFORE_DEPARTURE` away
    function buyPolicy(Quote calldata quote, bytes calldata underwriterSignature, AirnodeResponse calldata saleProof)
        external
        returns (uint256 policyId)
    {
        if (msg.sender != quote.holder) revert NotQuoteHolder();
        if (block.timestamp > quote.validUntil) revert QuoteExpired();
        bytes32 quoteHash = hashQuote(quote);
        if (usedQuotes[quoteHash]) revert QuoteAlreadyUsed();
        if (ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(quoteHash), underwriterSignature) != underwriter) {
            revert InvalidQuoteSignature();
        }
        _checkSellable(quote.flightNumber, quote.dateLocal, saleProof);
        usedQuotes[quoteHash] = true;
        policyId = _issuePolicy(quote);
    }

    /// @dev The same three checks as settlement, on the sale request: the AeroDataBox Airnode signed it, for this flight
    /// on this date, recently. Then the flight must still be expected and far enough from departure.
    function _checkSellable(string calldata flightNumber, string calldata dateLocal, AirnodeResponse calldata proof)
        internal
        view
    {
        AirnodeV2Attestation.verify(
            airnode, deriveSaleRequestHash(flightNumber, dateLocal), proof.timestamp, proof.data, proof.signature
        );
        if (proof.timestamp + MAX_SALE_PROOF_AGE < block.timestamp) revert SaleProofTooOld(proof.timestamp);
        string memory flightStatus = ProjectedJson.readString(proof.data, "status");
        bytes32 statusHash = keccak256(bytes(flightStatus));
        if (statusHash != keccak256("Expected") && statusHash != keccak256("CheckIn")) {
            revert FlightNotSellable(flightStatus);
        }
        uint256 scheduledDeparture = ProjectedJson.readTimestamp(proof.data, "scheduledDeparture");
        if (block.timestamp + SALES_CLOSE_BEFORE_DEPARTURE > scheduledDeparture) {
            revert TooCloseToDeparture(scheduledDeparture);
        }
    }

    /// @dev Takes the premium, reserves the payout and the keeper reward, and records the policy
    function _issuePolicy(Quote calldata quote) internal returns (uint256 policyId) {
        // The premium joins the pool before the reserve is taken from it.
        token.safeTransferFrom(msg.sender, address(this), quote.premium);
        uint256 reserve = quote.payout + keeperReward;
        uint256 available = availableLiquidity();
        if (available < reserve) revert InsufficientPool(available, reserve);
        totalReserved += reserve;

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

    /// @notice Settles a policy with the signed AeroDataBox arrival of its flight. Anyone can call it, and the caller
    /// receives the keeper reward.
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

        totalReserved -= policy.payout + keeperReward;
        if (delayMinutes >= policy.delayThresholdMinutes) {
            policy.status = Status.PaidOut;
            token.safeTransfer(policy.holder, policy.payout);
            emit PolicySettled(policyId, Status.PaidOut, delayMinutes, policy.payout);
        } else {
            policy.status = Status.ClosedOnTime;
            emit PolicySettled(policyId, Status.ClosedOnTime, delayMinutes, 0);
        }
        _rewardKeeper(policyId);
    }

    /// @notice Pays out a policy whose flight was cancelled or diverted, with the signed AeroDataBox status of the flight.
    /// Such a flight never arrives at its destination, so it has no actual arrival time and `settle` cannot be used.
    /// Anyone can call it, and the caller receives the keeper reward. CanceledUncertain does not count: AeroDataBox is
    /// not sure yet.
    /// @param timestamp `timestamp` of the response to the status request
    /// @param data `data` of that response, such as {"status":"Canceled"}
    /// @param signature `signature` of that response
    function settleCancelledOrDiverted(
        uint256 policyId,
        uint256 timestamp,
        bytes calldata data,
        bytes calldata signature
    ) external {
        Policy storage policy = policies[policyId];
        if (policy.status != Status.Active) revert PolicyNotActive(policyId);

        // The same three checks as settle, with the status request of this flight on this date
        AirnodeV2Attestation.verify(
            airnode, deriveStatusRequestHash(policy.flightNumber, policy.dateLocal), timestamp, data, signature
        );
        if (timestamp + MAX_RESPONSE_AGE < block.timestamp) revert ResponseTooOld(timestamp);
        string memory flightStatus = ProjectedJson.readString(data, "status");
        bytes32 statusHash = keccak256(bytes(flightStatus));
        if (statusHash != keccak256("Canceled") && statusHash != keccak256("Diverted")) {
            revert FlightNotCancelledOrDiverted(flightStatus);
        }

        totalReserved -= policy.payout + keeperReward;
        policy.status = Status.PaidOut;
        token.safeTransfer(policy.holder, policy.payout);
        emit PolicyPaidForNoArrival(policyId, flightStatus, policy.payout);
        _rewardKeeper(policyId);
    }

    /// @dev Whoever brings the signed outcome is paid for it, so a payout never waits for the underwriter to act
    function _rewardKeeper(uint256 policyId) private {
        if (keeperReward == 0) return;
        token.safeTransfer(msg.sender, keeperReward);
        emit KeeperRewarded(policyId, msg.sender, keeperReward);
    }

    /// @notice Releases the reserve of a policy that nobody settled in time, such as a flight whose arrival AeroDataBox
    /// never reported. Until someone calls it, the policy can still be settled. Pays no keeper reward.
    function expire(uint256 policyId) external {
        Policy storage policy = policies[policyId];
        if (policy.status != Status.Active) revert PolicyNotActive(policyId);
        if (block.timestamp <= policy.settleBy) revert SettlementWindowOpen(policy.settleBy);
        policy.status = Status.Expired;
        totalReserved -= policy.payout + keeperReward;
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

    // ---------------------------------------------------------------- request hashes

    /// @notice The hash of the AeroDataBox sale request for a flight departing on a date, which `buyPolicy` takes
    function deriveSaleRequestHash(string memory flightNumber, string memory dateLocal) public pure returns (bytes32) {
        return _deriveRequestHash(flightNumber, dateLocal, SALE_PROJECTION);
    }

    /// @notice The hash of the AeroDataBox arrival request for a flight departing on a date, which `settle` takes
    function deriveRequestHash(string memory flightNumber, string memory dateLocal) public pure returns (bytes32) {
        return _deriveRequestHash(flightNumber, dateLocal, PROJECTION);
    }

    /// @notice The hash of the AeroDataBox status request for a flight departing on a date, which
    /// `settleCancelledOrDiverted` takes
    function deriveStatusRequestHash(string memory flightNumber, string memory dateLocal)
        public
        pure
        returns (bytes32)
    {
        return _deriveRequestHash(flightNumber, dateLocal, STATUS_PROJECTION);
    }

    /// @dev Built the way the Airnode builds it:
    /// keccak256(JSON.stringify([operation, parameterEntriesSortedByName, projectionEntriesSortedByName])).
    /// Building it here means the traveller cannot buy a policy for one flight and settle it with another, and the three
    /// projections give three different hashes, so a response to one request cannot be used for another.
    /// dateLocalRole is pinned to Departure: with the default (Both), the date could also match the arrival date of an
    /// overnight flight that departed the day before.
    function _deriveRequestHash(string memory flightNumber, string memory dateLocal, string memory projection)
        private
        pure
        returns (bytes32)
    {
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
                    projection,
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
