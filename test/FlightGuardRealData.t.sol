// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {FlightGuard} from "../contracts/FlightGuard.sol";
import {TestUSD} from "./FlightGuard.t.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

/// @notice Issues a policy without a proof of sale, so that a test can settle a flight that has already flown with the
/// real response the AeroDataBox Airnode signed afterwards. Test only: the real contract always requires the proof.
contract FlightGuardHarness is FlightGuard {
    constructor(address airnode_, IERC20 token_, address underwriter_, uint256 keeperReward_)
        FlightGuard(airnode_, token_, underwriter_, keeperReward_, 500e6)
    {}

    function issue(Quote calldata quote, uint256 scheduledArrival) external returns (uint256) {
        return _issuePolicy(quote, scheduledArrival);
    }
}

/// @notice Runs the contract against responses that the real AeroDataBox Airnode signed, saved by src/fetch-flight.ts
/// and src/find-cancelled.ts. LH400 FRA-JFK departing 2026-10-29 arrived 18:39Z against 18:35Z scheduled, 4 minutes late.
contract FlightGuardRealDataTest is AirnodeV2Test {
    address constant AERODATABOX_AIRNODE = 0x83FE2E8F24E66520B1902C3507De4F471248f2Ec;
    uint256 constant UNDERWRITER_KEY = 0xB0B;
    uint256 constant KEEPER_REWARD = 0.1e6;

    TestUSD usd;
    FlightGuardHarness guard;
    address traveller = makeAddr("traveller");
    address keeper = makeAddr("keeper");

    uint256 timestamp;
    bytes data;
    bytes signature;

    function setUp() public {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile("test/fixtures/flight-LH400-2026-10-29.json");
        timestamp = vm.parseJsonUint(json, ".timestamp");
        data = bytes(vm.parseJsonString(json, ".data"));
        signature = vm.parseJsonBytes(json, ".signature");

        usd = new TestUSD();
        guard =
            new FlightGuardHarness(AERODATABOX_AIRNODE, IERC20(address(usd)), vm.addr(UNDERWRITER_KEY), KEEPER_REWARD);
        usd.mint(address(guard), 1_000e6);
        usd.mint(traveller, 100e6);
        vm.prank(traveller);
        usd.approve(address(guard), type(uint256).max);
    }

    function quoteFor(string memory flightNumber, string memory dateLocal, uint256 threshold, uint256 validUntil)
        internal
        view
        returns (FlightGuard.Quote memory)
    {
        return FlightGuard.Quote({
            holder: traveller,
            flightNumber: flightNumber,
            dateLocal: dateLocal,
            premium: 5e6,
            payout: 100e6,
            delayThresholdMinutes: threshold,
            validUntil: validUntil,
            nonce: threshold
        });
    }

    /// LH400's scheduled arrival, 2026-10-29 18:35Z, which the proof of sale would have carried
    uint256 constant LH400_SCHEDULED_ARRIVAL = 1793298900;

    /// The flight has already flown, so the policy is issued without a proof of sale, with the scheduled arrival the
    /// proof of sale would have carried (LH400's; a cancelled flight never uses it)
    function issue(string memory flightNumber, string memory dateLocal, uint256 threshold) internal returns (uint256) {
        FlightGuard.Quote memory q = quoteFor(flightNumber, dateLocal, threshold, 0);
        vm.prank(traveller);
        return guard.issue(q, LH400_SCHEDULED_ARRIVAL);
    }

    function readFixture(string memory path) internal view returns (string memory) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        return vm.readFile(path);
    }

    // ------------------------------------------------------------ a flight that landed

    function test_RealResponse_ClosesOnTimePolicy() public {
        uint256 id = issue("LH400", "2026-10-29", 120);
        vm.warp(timestamp + 60);
        vm.expectEmit(address(guard));
        emit FlightGuard.PolicySettled(id, FlightGuard.Status.ClosedOnTime, 4, 0);
        vm.prank(keeper);
        guard.settle(id, timestamp, data, signature);
        assertEq(usd.balanceOf(keeper), KEEPER_REWARD);
    }

    function test_RealResponse_PaysOutWhenThresholdIsLow() public {
        uint256 id = issue("LH400", "2026-10-29", 3); // 4 minutes late is enough for a 3 minute threshold
        vm.warp(timestamp + 60);
        vm.prank(keeper);
        guard.settle(id, timestamp, data, signature);
        assertEq(usd.balanceOf(traveller), 195e6);
    }

    function test_RealResponse_RevertWhen_ArrivalEdited() public {
        uint256 id = issue("LH400", "2026-10-29", 120);
        vm.warp(timestamp + 60);
        bytes memory edited =
            bytes('{"actualArrival":"2026-10-29 21:39Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}');
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.settle(id, timestamp, edited, signature);
    }

    function test_RealResponse_RevertWhen_TooOld() public {
        uint256 id = issue("LH400", "2026-10-29", 120);
        vm.warp(timestamp + guard.MAX_RESPONSE_AGE() + 1);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.ResponseTooOld.selector, timestamp));
        guard.settle(id, timestamp, data, signature);
    }

    /// @notice The status request of the same flight, saved by `src/fetch-flight.ts LH400 2026-10-29 --status`. The real
    /// signature verifies against the request hash that the contract builds, and since LH400 arrived, the cancellation
    /// path refuses it.
    function test_RealStatusResponse_VerifiesButDoesNotPayAnArrivedFlight() public {
        string memory path = "test/fixtures/status-LH400-2026-10-29.json";
        // forge-lint: disable-next-line(unsafe-cheatcode)
        if (!vm.exists(path)) vm.skip(true, "run src/fetch-flight.ts LH400 2026-10-29 --status first");
        string memory json = readFixture(path);
        assertEq(vm.parseJsonBytes32(json, ".requestHash"), guard.deriveStatusRequestHash("LH400", "2026-10-29"));
        uint256 statusTimestamp = vm.parseJsonUint(json, ".timestamp");
        bytes memory statusData = bytes(vm.parseJsonString(json, ".data"));
        bytes memory statusSignature = vm.parseJsonBytes(json, ".signature");

        uint256 id = issue("LH400", "2026-10-29", 120);
        vm.warp(statusTimestamp + 60);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.FlightNotCancelledOrDiverted.selector, "Arrived"));
        guard.settleCancelledOrDiverted(id, statusTimestamp, statusData, statusSignature);
    }

    // ------------------------------------------------------------ a flight that was really cancelled

    /// @notice A flight that AeroDataBox reports as cancelled, found and saved by `src/find-cancelled.ts`. The policy
    /// pays out with the real signed status, and whoever settles is paid the keeper reward.
    function test_RealCancelledFlight_PaysOut() public {
        string memory path = "test/fixtures/cancelled.json";
        // forge-lint: disable-next-line(unsafe-cheatcode)
        if (!vm.exists(path)) vm.skip(true, "run src/find-cancelled.ts first");
        string memory json = readFixture(path);
        string memory flightNumber = vm.parseJsonString(json, ".flightNumber");
        string memory dateLocal = vm.parseJsonString(json, ".dateLocal");
        assertEq(vm.parseJsonBytes32(json, ".requestHash"), guard.deriveStatusRequestHash(flightNumber, dateLocal));
        uint256 signedAt = vm.parseJsonUint(json, ".timestamp");

        uint256 id = issue(flightNumber, dateLocal, 15);
        vm.warp(signedAt + 60);
        vm.prank(keeper);
        guard.settleCancelledOrDiverted(
            id, signedAt, bytes(vm.parseJsonString(json, ".data")), vm.parseJsonBytes(json, ".signature")
        );
        assertEq(usd.balanceOf(traveller), 195e6);
        assertEq(usd.balanceOf(keeper), KEEPER_REWARD);
    }

    // ------------------------------------------------------------ a real proof of sale

    /// @notice A proof of sale that the real AeroDataBox Airnode signed, saved by `src/fetch-flight.ts <flight> <date>
    /// --sale` at least two hours before departure. It goes through the real `buyPolicy` and its checks.
    function test_RealSaleProof_BuysThroughBuyPolicy() public {
        string memory path = "test/fixtures/sale-proof.json";
        // forge-lint: disable-next-line(unsafe-cheatcode)
        if (!vm.exists(path)) vm.skip(true, "run src/fetch-flight.ts <flight> <date> --sale first");
        string memory json = readFixture(path);
        string memory flightNumber = vm.parseJsonString(json, ".flightNumber");
        string memory dateLocal = vm.parseJsonString(json, ".dateLocal");
        assertEq(vm.parseJsonBytes32(json, ".requestHash"), guard.deriveSaleRequestHash(flightNumber, dateLocal));
        FlightGuard.AirnodeResponse memory sale = FlightGuard.AirnodeResponse({
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });

        vm.warp(sale.timestamp + 60);
        FlightGuard.Quote memory q = quoteFor(flightNumber, dateLocal, 15, block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(UNDERWRITER_KEY, MessageHashUtils.toEthSignedMessageHash(guard.hashQuote(q)));
        vm.prank(traveller);
        uint256 id = guard.buyPolicy(q, abi.encodePacked(r, s, v), sale);
        assertEq(id, 0);
        assertEq(guard.totalReserved(), 100e6 + KEEPER_REWARD);

        // The same proof is refused once it is older than 15 minutes
        vm.warp(sale.timestamp + guard.MAX_SALE_PROOF_AGE() + 1);
        FlightGuard.Quote memory later = quoteFor(flightNumber, dateLocal, 30, block.timestamp + 10 minutes);
        (v, r, s) = vm.sign(UNDERWRITER_KEY, MessageHashUtils.toEthSignedMessageHash(guard.hashQuote(later)));
        vm.prank(traveller);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.SaleProofTooOld.selector, sale.timestamp));
        guard.buyPolicy(later, abi.encodePacked(r, s, v), sale);
    }
}
