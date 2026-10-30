// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {FlightGuard} from "../contracts/FlightGuard.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

contract TestUSD is ERC20 {
    constructor() ERC20("Test USD", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FlightGuardTest is AirnodeV2Test {
    uint256 constant AIRNODE_KEY = 0xA11CE;
    uint256 constant UNDERWRITER_KEY = 0xB0B;
    address airnode;
    address underwriter;
    address traveller = makeAddr("traveller");

    TestUSD usd;
    FlightGuard guard;

    // From the TypeScript deriveRequestHash in src/airnode-v2.ts, the same function the Airnode uses, for
    // flightStatusOnDate LH400 2026-10-29 with dateLocalRole Departure and the three-field projection.
    bytes32 constant LH400_20261029_HASH = 0xa15da25eb629cf246d838db2dfb6f5794ffa31205d402430db0469c5038aad03;

    // Landed 2026-10-29 18:39Z, so the response is signed a little after that.
    uint256 constant SIGNED_AT = 1793300000;

    bytes constant DELAYED_DATA =
        bytes('{"actualArrival":"2026-10-29 21:10Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}');
    bytes constant ON_TIME_DATA =
        bytes('{"actualArrival":"2026-10-29 18:39Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}');

    function setUp() public {
        airnode = vm.addr(AIRNODE_KEY);
        underwriter = vm.addr(UNDERWRITER_KEY);
        usd = new TestUSD();
        guard = new FlightGuard(airnode, IERC20(address(usd)), underwriter);

        usd.mint(address(guard), 1_000e6); // the underwriter's pool
        usd.mint(traveller, 100e6);
        vm.prank(traveller);
        usd.approve(address(guard), type(uint256).max);
        vm.warp(SIGNED_AT - 2 days); // buying happens before the flight
    }

    // ------------------------------------------------------------ helpers

    function quoteFor(string memory flight, string memory date, uint256 nonce)
        internal
        view
        returns (FlightGuard.Quote memory)
    {
        return FlightGuard.Quote({
            holder: traveller,
            flightNumber: flight,
            dateLocal: date,
            premium: 5e6,
            payout: 100e6,
            delayThresholdMinutes: 120,
            validUntil: block.timestamp + 1 hours,
            nonce: nonce
        });
    }

    function signQuote(FlightGuard.Quote memory q, uint256 key) internal view returns (bytes memory) {
        bytes32 h = guard.hashQuote(q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(h));
        return abi.encodePacked(r, s, v);
    }

    function buyLH400() internal returns (uint256) {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(traveller);
        return guard.buyPolicy(q, sig);
    }

    // ------------------------------------------------------------ request hash

    function test_DerivesTheSameRequestHashAsTheAirnode() public view {
        assertEq(guard.deriveRequestHash("LH400", "2026-10-29"), LH400_20261029_HASH);
    }

    function test_RevertWhen_FlightNumberHasCharactersThatJsonWouldEscape() public {
        vm.expectRevert(FlightGuard.InvalidFlightNumber.selector);
        guard.deriveRequestHash('LH4"0', "2026-10-29");
        vm.expectRevert(FlightGuard.InvalidFlightNumber.selector);
        guard.deriveRequestHash("lh400", "2026-10-29");
    }

    // ------------------------------------------------------------ buying

    function test_BuyPolicyTakesPremiumAndReservesPayout() public {
        uint256 id = buyLH400();
        assertEq(id, 0);
        assertEq(usd.balanceOf(traveller), 95e6);
        assertEq(guard.totalReserved(), 100e6);
        assertEq(guard.availableLiquidity(), 905e6);
    }

    function test_RevertWhen_QuoteNotSignedByUnderwriter() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, 0xBAD);
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.InvalidQuoteSignature.selector);
        guard.buyPolicy(q, sig);
    }

    function test_RevertWhen_QuoteUsedTwice() public {
        buyLH400();
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.QuoteAlreadyUsed.selector);
        guard.buyPolicy(q, sig);
    }

    function test_RevertWhen_TravellerChangesThePremium() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        q.premium = 1;
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.InvalidQuoteSignature.selector);
        guard.buyPolicy(q, sig);
    }

    function test_RevertWhen_QuoteExpired() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.warp(q.validUntil + 1);
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.QuoteExpired.selector);
        guard.buyPolicy(q, sig);
    }

    // The last flight on 2026-10-29 can depart at 24:00 in UTC-12, which is 2026-10-30 12:00 UTC.
    uint256 constant LATEST_DEPARTURE_20261029 = 1793361600;

    function test_LatestDepartureIs24h00InTheLatestTimeZone() public view {
        assertEq(guard.latestDepartureAt("2026-10-29"), LATEST_DEPARTURE_20261029);
    }

    function test_RevertWhen_BuyingAfterTheUnderwritersCutOff() public {
        // The underwriter's agent sets validUntil before the scheduled departure, here 2026-10-29 09:00 UTC
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        q.validUntil = 1793264400;
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.warp(1793264400 + 1);
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.QuoteExpired.selector);
        guard.buyPolicy(q, sig);
    }

    function test_RevertWhen_TravellerExtendsTheCutOff() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        q.validUntil = 1793264400;
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        q.validUntil = 1793300000; // after landing
        vm.warp(1793264400 + 1);
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.InvalidQuoteSignature.selector);
        guard.buyPolicy(q, sig);
    }

    function test_CanBuyOneSecondBeforeLatestDeparture() public {
        vm.warp(LATEST_DEPARTURE_20261029 - 1);
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(traveller);
        guard.buyPolicy(q, sig);
        assertEq(guard.policyCount(), 1);
    }

    function test_RevertWhen_BuyingAfterLatestDepartureEvenWithALongQuote() public {
        vm.warp(LATEST_DEPARTURE_20261029);
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        q.validUntil = block.timestamp + 30 days; // an underwriter mistake
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(traveller);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.TooLateToBuy.selector, LATEST_DEPARTURE_20261029));
        guard.buyPolicy(q, sig);
    }

    // ------------------------------------------------------------ settling

    function test_PaysOutWhenDelayedPastThreshold() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, DELAYED_DATA);
        guard.settle(id, SIGNED_AT, DELAYED_DATA, sig); // anyone can settle, here the test contract

        assertEq(usd.balanceOf(traveller), 195e6);
        assertEq(guard.totalReserved(), 0);
        (,,,,, FlightGuard.Status status,,) = guard.policies(id);
        assertEq(uint256(status), uint256(FlightGuard.Status.PaidOut));
    }

    function test_ClosesWithoutPayoutWhenOnTime() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, ON_TIME_DATA);
        guard.settle(id, SIGNED_AT, ON_TIME_DATA, sig);

        assertEq(usd.balanceOf(traveller), 95e6);
        assertEq(guard.availableLiquidity(), 1_005e6);
        (,,,,, FlightGuard.Status status,,) = guard.policies(id);
        assertEq(uint256(status), uint256(FlightGuard.Status.ClosedOnTime));
    }

    function test_RevertWhen_SettledTwice() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, DELAYED_DATA);
        guard.settle(id, SIGNED_AT, DELAYED_DATA, sig);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.PolicyNotActive.selector, id));
        guard.settle(id, SIGNED_AT, DELAYED_DATA, sig);
    }

    function test_RevertWhen_FlightHasNotLandedYet() public {
        uint256 id = buyLH400();
        bytes memory data =
            bytes('{"actualArrival":"2026-10-29 18:39Z","scheduledArrival":"2026-10-29 18:35Z","status":"EnRoute"}');
        vm.warp(SIGNED_AT + 10);
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, data);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.FlightNotArrived.selector, "EnRoute"));
        guard.settle(id, SIGNED_AT, data, sig);
    }

    // ------------------------------------------------------------ the four tamper cases

    function test_RevertWhen_ValueEdited() public {
        uint256 id = buyLH400();
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, ON_TIME_DATA);
        vm.warp(SIGNED_AT + 10);
        // The on-time response with its arrival moved to look delayed
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.settle(id, SIGNED_AT, DELAYED_DATA, sig);
    }

    function test_RevertWhen_ResponseTooOld() public {
        uint256 id = buyLH400();
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, DELAYED_DATA);
        vm.warp(SIGNED_AT + guard.MAX_RESPONSE_AGE() + 1);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.ResponseTooOld.selector, SIGNED_AT));
        guard.settle(id, SIGNED_AT, DELAYED_DATA, sig);
    }

    function test_RevertWhen_ResponseIsForAnotherFlight() public {
        uint256 id = buyLH400();
        // A real, delayed response, but for LH401
        bytes32 otherHash = guard.deriveRequestHash("LH401", "2026-10-29");
        bytes memory sig = signResponse(AIRNODE_KEY, otherHash, SIGNED_AT, DELAYED_DATA);
        vm.warp(SIGNED_AT + 10);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.settle(id, SIGNED_AT, DELAYED_DATA, sig);
    }

    function test_RevertWhen_ResponseIsForAnotherDate() public {
        uint256 id = buyLH400();
        bytes32 otherHash = guard.deriveRequestHash("LH400", "2026-10-28");
        bytes memory sig = signResponse(AIRNODE_KEY, otherHash, SIGNED_AT, DELAYED_DATA);
        vm.warp(SIGNED_AT + 10);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.settle(id, SIGNED_AT, DELAYED_DATA, sig);
    }

    function test_RevertWhen_SignedWithWrongKey() public {
        uint256 id = buyLH400();
        uint256 wrongKey = 0xDEAD;
        bytes memory sig = signResponse(wrongKey, LH400_20261029_HASH, SIGNED_AT, DELAYED_DATA);
        vm.warp(SIGNED_AT + 10);
        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, vm.addr(wrongKey)));
        guard.settle(id, SIGNED_AT, DELAYED_DATA, sig);
    }

    // ------------------------------------------------------------ pool and expiry

    function test_UnderwriterCannotWithdrawReservedFunds() public {
        buyLH400();
        vm.prank(underwriter);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.InsufficientPool.selector, 905e6, 906e6));
        guard.withdraw(906e6);
        vm.prank(underwriter);
        guard.withdraw(905e6);
        assertEq(usd.balanceOf(underwriter), 905e6);
    }

    function test_ExpireReleasesReserveAfterWindow() public {
        uint256 id = buyLH400();
        vm.expectRevert();
        guard.expire(id);
        (,,,, uint256 settleBy,,,) = guard.policies(id);
        vm.warp(settleBy + 1);
        guard.expire(id);
        assertEq(guard.totalReserved(), 0);
    }
}
