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
    uint256 constant KEEPER_REWARD = 0.1e6;
    uint256 constant MAX_PAYOUT = 500e6;
    address airnode;
    address underwriter;
    address traveller = makeAddr("traveller");
    address keeper = makeAddr("keeper");

    TestUSD usd;
    FlightGuard guard;

    // From the TypeScript deriveRequestHash in src/airnode-v2.ts, the same function the Airnode uses, for
    // flightStatusOnDate LH400 departing 2026-10-29 (dateLocalRole Departure) with each of the three projections.
    bytes32 constant LH400_20261029_HASH = 0xa15da25eb629cf246d838db2dfb6f5794ffa31205d402430db0469c5038aad03;
    bytes32 constant LH400_20261029_STATUS_HASH = 0x1a8421d7312811a8abed3430641c29274848fb61467ab86c554378dad3a1fdc1;
    bytes32 constant LH400_20261029_SALE_HASH = 0x16b272f83b5f1f48bcc80c2a9f83eb554efd6a76bc5a6784622641eeddb34f78;

    // LH400 is scheduled to depart 2026-10-29 10:00Z, so sales close at 08:00Z.
    string constant DEPARTURE = "2026-10-29 10:00Z";
    uint256 constant DEPARTURE_AT = 1793268000;
    uint256 constant SALES_CLOSE = DEPARTURE_AT - 2 hours;

    // Landed 2026-10-29 18:39Z, so the outcome is signed a little after that.
    uint256 constant SIGNED_AT = 1793300000;

    bytes constant DELAYED_DATA =
        bytes('{"actualArrival":"2026-10-29 21:10Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}');
    bytes constant ON_TIME_DATA =
        bytes('{"actualArrival":"2026-10-29 18:39Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}');

    function setUp() public {
        airnode = vm.addr(AIRNODE_KEY);
        underwriter = vm.addr(UNDERWRITER_KEY);
        usd = new TestUSD();
        guard = new FlightGuard(airnode, IERC20(address(usd)), underwriter, KEEPER_REWARD, MAX_PAYOUT);

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
            validUntil: block.timestamp + 10 minutes,
            nonce: nonce
        });
    }

    function signQuote(FlightGuard.Quote memory q, uint256 key) internal view returns (bytes memory) {
        bytes32 h = guard.hashQuote(q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(h));
        return abi.encodePacked(r, s, v);
    }

    function saleData(string memory status) internal pure returns (bytes memory) {
        return bytes(
            string.concat(
                '{"scheduledArrival":"2026-10-29 18:35Z","scheduledDeparture":"',
                DEPARTURE,
                '","status":"',
                status,
                '"}'
            )
        );
    }

    function proof(uint256 key, bytes32 requestHash, uint256 signedAt, bytes memory data)
        internal
        pure
        returns (FlightGuard.AirnodeResponse memory)
    {
        return FlightGuard.AirnodeResponse({
            timestamp: signedAt, data: data, signature: signResponse(key, requestHash, signedAt, data)
        });
    }

    /// A proof of sale for LH400 on 2026-10-29 that the Airnode signed just now, with the given status
    function saleProof(string memory status) internal view returns (FlightGuard.AirnodeResponse memory) {
        return proof(AIRNODE_KEY, LH400_20261029_SALE_HASH, block.timestamp, saleData(status));
    }

    function buyWith(FlightGuard.Quote memory q, FlightGuard.AirnodeResponse memory sale) internal returns (uint256) {
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(traveller);
        return guard.buyPolicy(q, sig, sale);
    }

    function expectBuyReverts(FlightGuard.AirnodeResponse memory sale, bytes memory revertData) internal {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(traveller);
        vm.expectRevert(revertData);
        guard.buyPolicy(q, sig, sale);
    }

    function buyLH400() internal returns (uint256) {
        return buyWith(quoteFor("LH400", "2026-10-29", 1), saleProof("Expected"));
    }

    function statusOf(uint256 id) internal view returns (FlightGuard.Status status) {
        (,,,,, status,,,) = guard.policies(id);
    }

    // ------------------------------------------------------------ request hashes

    function test_DerivesTheSameRequestHashesAsTheAirnode() public view {
        assertEq(guard.deriveRequestHash("LH400", "2026-10-29"), LH400_20261029_HASH);
        assertEq(guard.deriveStatusRequestHash("LH400", "2026-10-29"), LH400_20261029_STATUS_HASH);
        assertEq(guard.deriveSaleRequestHash("LH400", "2026-10-29"), LH400_20261029_SALE_HASH);
        assertTrue(LH400_20261029_HASH != LH400_20261029_STATUS_HASH);
        assertTrue(LH400_20261029_HASH != LH400_20261029_SALE_HASH);
        assertTrue(LH400_20261029_STATUS_HASH != LH400_20261029_SALE_HASH);
    }

    function test_RevertWhen_FlightNumberHasCharactersThatJsonWouldEscape() public {
        vm.expectRevert(FlightGuard.InvalidFlightNumber.selector);
        guard.deriveRequestHash('LH4"0', "2026-10-29");
        vm.expectRevert(FlightGuard.InvalidFlightNumber.selector);
        guard.deriveSaleRequestHash("lh400", "2026-10-29");
    }

    // ------------------------------------------------------------ buying

    function test_BuyPolicyTakesPremiumAndReservesPayoutAndKeeperReward() public {
        uint256 id = buyLH400();
        assertEq(id, 0);
        assertEq(usd.balanceOf(traveller), 95e6);
        assertEq(guard.totalReserved(), 100e6 + KEEPER_REWARD);
        assertEq(guard.availableLiquidity(), 1_005e6 - 100e6 - KEEPER_REWARD);
    }

    function test_RevertWhen_QuoteNotSignedByUnderwriter() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, 0xBAD);
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.InvalidQuoteSignature.selector);
        guard.buyPolicy(q, sig, sale);
    }

    function test_RevertWhen_QuoteUsedTwice() public {
        buyLH400();
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.QuoteAlreadyUsed.selector);
        guard.buyPolicy(q, sig, sale);
    }

    function test_RevertWhen_TravellerChangesThePremium() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        q.premium = 1;
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.InvalidQuoteSignature.selector);
        guard.buyPolicy(q, sig, sale);
    }

    function test_RevertWhen_QuoteExpired() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.warp(q.validUntil + 1);
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.QuoteExpired.selector);
        guard.buyPolicy(q, sig, sale);
    }

    function test_RevertWhen_TravellerExtendsTheQuote() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        q.validUntil += 1 days;
        vm.warp(block.timestamp + 1 hours);
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.InvalidQuoteSignature.selector);
        guard.buyPolicy(q, sig, sale);
    }

    function test_RevertWhen_SomeoneElseUsesTheQuote() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(keeper);
        vm.expectRevert(FlightGuard.NotQuoteHolder.selector);
        guard.buyPolicy(q, sig, sale);
    }

    function test_RevertWhen_PoolCannotCoverPayoutAndKeeperReward() public {
        // Empty the pool down to 100 aUSD, so a 100 aUSD payout is exactly the pool after the 5 aUSD premium minus 5
        vm.prank(underwriter);
        guard.withdraw(900e6);
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        q.payout = 105e6; // exactly the pool after the premium, but the keeper reward is reserved too
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.InsufficientPool.selector, 105e6, 105e6 + KEEPER_REWARD));
        guard.buyPolicy(q, sig, sale);
    }

    // ------------------------------------------------------------ the proof of sale

    function test_CanBuyWhileCheckInIsOpen() public {
        buyWith(quoteFor("LH400", "2026-10-29", 1), saleProof("CheckIn"));
        assertEq(guard.policyCount(), 1);
    }

    function test_CanBuyUntilTwoHoursBeforeDeparture() public {
        vm.warp(SALES_CLOSE);
        buyWith(quoteFor("LH400", "2026-10-29", 1), saleProof("Expected"));
        assertEq(guard.policyCount(), 1);
    }

    function test_RevertWhen_LessThanTwoHoursBeforeDeparture() public {
        vm.warp(SALES_CLOSE + 1);
        expectBuyReverts(
            saleProof("Expected"), abi.encodeWithSelector(FlightGuard.TooCloseToDeparture.selector, DEPARTURE_AT)
        );
    }

    function test_RevertWhen_UnderwriterSignedALongQuoteButSalesClosed() public {
        // An underwriter mistake: a quote valid for a month. The signed departure time still closes sales.
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        q.validUntil = block.timestamp + 30 days;
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.warp(DEPARTURE_AT + 10 hours); // the flight has landed, AeroDataBox even still says Expected
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.TooCloseToDeparture.selector, DEPARTURE_AT));
        guard.buyPolicy(q, sig, sale);
    }

    function test_RevertWhen_FlightIsAlreadyDelayedDepartedOrCancelled() public {
        string[8] memory unsellable =
            ["Delayed", "Boarding", "GateClosed", "Departed", "EnRoute", "Arrived", "Canceled", "Unknown"];
        for (uint256 i; i < unsellable.length; i++) {
            expectBuyReverts(
                saleProof(unsellable[i]), abi.encodeWithSelector(FlightGuard.FlightNotSellable.selector, unsellable[i])
            );
        }
    }

    function test_RevertWhen_SaleProofIsTooOld() public {
        uint256 signedAt = block.timestamp - 15 minutes - 1;
        expectBuyReverts(
            proof(AIRNODE_KEY, LH400_20261029_SALE_HASH, signedAt, saleData("Expected")),
            abi.encodeWithSelector(FlightGuard.SaleProofTooOld.selector, signedAt)
        );
    }

    function test_RevertWhen_SaleProofEditedToExpected() public {
        FlightGuard.AirnodeResponse memory sale = saleProof("Delayed");
        sale.data = saleData("Expected");
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(traveller);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.buyPolicy(q, sig, sale);
    }

    function test_RevertWhen_SaleProofIsForAnotherFlightOrDate() public {
        bytes32 anotherFlight = guard.deriveSaleRequestHash("LH401", "2026-10-29");
        bytes32 anotherDate = guard.deriveSaleRequestHash("LH400", "2026-10-30");
        FlightGuard.AirnodeResponse memory forAnotherFlight =
            proof(AIRNODE_KEY, anotherFlight, block.timestamp, saleData("Expected"));
        FlightGuard.AirnodeResponse memory forAnotherDate =
            proof(AIRNODE_KEY, anotherDate, block.timestamp, saleData("Expected"));
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(traveller);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.buyPolicy(q, sig, forAnotherFlight);
        vm.prank(traveller);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.buyPolicy(q, sig, forAnotherDate);
    }

    function test_RevertWhen_SaleProofSignedWithWrongKey() public {
        expectBuyReverts(
            proof(0xDEAD, LH400_20261029_SALE_HASH, block.timestamp, saleData("Expected")),
            abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, vm.addr(0xDEAD))
        );
    }

    function test_RevertWhen_AnotherRequestIsUsedAsSaleProof() public {
        // Real responses to the arrival or the status request of the same flight cannot stand in for the sale request
        FlightGuard.AirnodeResponse memory arrival =
            proof(AIRNODE_KEY, LH400_20261029_HASH, block.timestamp, saleData("Expected"));
        FlightGuard.AirnodeResponse memory status =
            proof(AIRNODE_KEY, LH400_20261029_STATUS_HASH, block.timestamp, saleData("Expected"));
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(traveller);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.buyPolicy(q, sig, arrival);
        vm.prank(traveller);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.buyPolicy(q, sig, status);
    }

    // ------------------------------------------------------------ settling a flight that landed

    function settleAs(address who, uint256 id, bytes32 requestHash, bytes memory signedData, bytes memory submittedData)
        internal
    {
        bytes memory sig = signResponse(AIRNODE_KEY, requestHash, SIGNED_AT, signedData);
        vm.prank(who);
        guard.settle(id, SIGNED_AT, submittedData, sig);
    }

    function test_PaysOutWhenDelayedPastThresholdAndRewardsTheKeeper() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        vm.expectEmit(address(guard));
        emit FlightGuard.KeeperRewarded(id, keeper, KEEPER_REWARD);
        settleAs(keeper, id, LH400_20261029_HASH, DELAYED_DATA, DELAYED_DATA);

        assertEq(usd.balanceOf(traveller), 195e6);
        assertEq(usd.balanceOf(keeper), KEEPER_REWARD);
        assertEq(guard.totalReserved(), 0);
        assertEq(uint256(statusOf(id)), uint256(FlightGuard.Status.PaidOut));
    }

    function test_ClosesWithoutPayoutWhenOnTimeAndStillRewardsTheKeeper() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        settleAs(keeper, id, LH400_20261029_HASH, ON_TIME_DATA, ON_TIME_DATA);

        assertEq(usd.balanceOf(traveller), 95e6);
        assertEq(usd.balanceOf(keeper), KEEPER_REWARD);
        assertEq(guard.availableLiquidity(), 1_005e6 - KEEPER_REWARD);
        assertEq(uint256(statusOf(id)), uint256(FlightGuard.Status.ClosedOnTime));
    }

    function test_TravellerCanSettleAndKeepsTheReward() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        settleAs(traveller, id, LH400_20261029_HASH, DELAYED_DATA, DELAYED_DATA);
        assertEq(usd.balanceOf(traveller), 195e6 + KEEPER_REWARD);
    }

    function test_RevertWhen_SettledTwice() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        settleAs(keeper, id, LH400_20261029_HASH, DELAYED_DATA, DELAYED_DATA);
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, DELAYED_DATA);
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

    // The four tamper cases

    function test_RevertWhen_ValueEdited() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        // The on-time response with its arrival moved to look delayed
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settleAs(keeper, id, LH400_20261029_HASH, ON_TIME_DATA, DELAYED_DATA);
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
        bytes32 otherHash = guard.deriveRequestHash("LH401", "2026-10-29");
        vm.warp(SIGNED_AT + 10);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settleAs(keeper, id, otherHash, DELAYED_DATA, DELAYED_DATA);
    }

    function test_RevertWhen_ResponseIsForAnotherDate() public {
        uint256 id = buyLH400();
        bytes32 otherHash = guard.deriveRequestHash("LH400", "2026-10-28");
        vm.warp(SIGNED_AT + 10);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settleAs(keeper, id, otherHash, DELAYED_DATA, DELAYED_DATA);
    }

    function test_RevertWhen_SignedWithWrongKey() public {
        uint256 id = buyLH400();
        uint256 wrongKey = 0xDEAD;
        bytes memory sig = signResponse(wrongKey, LH400_20261029_HASH, SIGNED_AT, DELAYED_DATA);
        vm.warp(SIGNED_AT + 10);
        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, vm.addr(wrongKey)));
        guard.settle(id, SIGNED_AT, DELAYED_DATA, sig);
    }

    function test_RevertWhen_SaleProofIsUsedToSettle() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory sale = saleData("Expected");
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settleAs(keeper, id, LH400_20261029_SALE_HASH, sale, sale);
    }

    // ------------------------------------------------------------ cancelled and diverted flights

    function settleStatus(
        address who,
        uint256 id,
        uint256 key,
        bytes32 requestHash,
        bytes memory signedData,
        bytes memory submittedData
    ) internal {
        bytes memory sig = signResponse(key, requestHash, SIGNED_AT, signedData);
        vm.prank(who);
        guard.settleCancelledOrDiverted(id, SIGNED_AT, submittedData, sig);
    }

    function test_PaysOutWhenCancelledAndRewardsTheKeeper() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory data = bytes('{"status":"Canceled"}');
        vm.expectEmit(address(guard));
        emit FlightGuard.PolicyPaidForNoArrival(id, "Canceled", 100e6);
        settleStatus(keeper, id, AIRNODE_KEY, LH400_20261029_STATUS_HASH, data, data);

        assertEq(usd.balanceOf(traveller), 195e6);
        assertEq(usd.balanceOf(keeper), KEEPER_REWARD);
        assertEq(guard.totalReserved(), 0);
        assertEq(uint256(statusOf(id)), uint256(FlightGuard.Status.PaidOut));
    }

    function test_PaysOutWhenDiverted() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory data = bytes('{"status":"Diverted"}');
        settleStatus(keeper, id, AIRNODE_KEY, LH400_20261029_STATUS_HASH, data, data);
        assertEq(usd.balanceOf(traveller), 195e6);
    }

    function test_RevertWhen_StatusIsNotCancelledOrDiverted() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        string[4] memory others = ["Arrived", "CanceledUncertain", "Delayed", "EnRoute"];
        for (uint256 i; i < others.length; i++) {
            bytes memory data = bytes(string.concat('{"status":"', others[i], '"}'));
            bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_STATUS_HASH, SIGNED_AT, data);
            vm.expectRevert(abi.encodeWithSelector(FlightGuard.FlightNotCancelledOrDiverted.selector, others[i]));
            guard.settleCancelledOrDiverted(id, SIGNED_AT, data, sig);
        }
    }

    function test_RevertWhen_CancelledPolicySettledAgain() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory data = bytes('{"status":"Canceled"}');
        settleStatus(keeper, id, AIRNODE_KEY, LH400_20261029_STATUS_HASH, data, data);
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_STATUS_HASH, SIGNED_AT, data);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.PolicyNotActive.selector, id));
        guard.settleCancelledOrDiverted(id, SIGNED_AT, data, sig);
        bytes memory arrivalSig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, ON_TIME_DATA);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.PolicyNotActive.selector, id));
        guard.settle(id, SIGNED_AT, ON_TIME_DATA, arrivalSig);
    }

    // The four tamper cases on the cancellation path

    function test_RevertWhen_StatusEditedToCancelled() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settleStatus(
            keeper,
            id,
            AIRNODE_KEY,
            LH400_20261029_STATUS_HASH,
            bytes('{"status":"Arrived"}'),
            bytes('{"status":"Canceled"}')
        );
    }

    function test_RevertWhen_CancellationIsTooOld() public {
        uint256 id = buyLH400();
        bytes memory data = bytes('{"status":"Canceled"}');
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_STATUS_HASH, SIGNED_AT, data);
        vm.warp(SIGNED_AT + guard.MAX_RESPONSE_AGE() + 1);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.ResponseTooOld.selector, SIGNED_AT));
        guard.settleCancelledOrDiverted(id, SIGNED_AT, data, sig);
    }

    function test_RevertWhen_CancellationIsForAnotherFlightOrDate() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory data = bytes('{"status":"Canceled"}');
        bytes32 anotherFlight = guard.deriveStatusRequestHash("LH401", "2026-10-29");
        bytes32 anotherDate = guard.deriveStatusRequestHash("LH400", "2026-10-28");
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settleStatus(keeper, id, AIRNODE_KEY, anotherFlight, data, data);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settleStatus(keeper, id, AIRNODE_KEY, anotherDate, data, data);
    }

    function test_RevertWhen_CancellationSignedWithWrongKey() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory data = bytes('{"status":"Canceled"}');
        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, vm.addr(0xDEAD)));
        settleStatus(keeper, id, 0xDEAD, LH400_20261029_STATUS_HASH, data, data);
    }

    // A response to one request cannot be used on the other path

    function test_RevertWhen_ArrivalResponseUsedOnCancellationPath() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        bytes memory data = bytes('{"status":"Canceled"}');
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settleStatus(keeper, id, AIRNODE_KEY, LH400_20261029_HASH, data, data);
    }

    function test_RevertWhen_StatusResponseUsedOnArrivalPath() public {
        uint256 id = buyLH400();
        vm.warp(SIGNED_AT + 10);
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settleAs(keeper, id, LH400_20261029_STATUS_HASH, DELAYED_DATA, DELAYED_DATA);
    }

    // ------------------------------------------------------------ pool and expiry

    function test_UnderwriterCannotWithdrawReservedFunds() public {
        buyLH400();
        uint256 available = 1_005e6 - 100e6 - KEEPER_REWARD;
        vm.prank(underwriter);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.InsufficientPool.selector, available, available + 1));
        guard.withdraw(available + 1);
        vm.prank(underwriter);
        guard.withdraw(available);
        assertEq(usd.balanceOf(underwriter), available);
    }

    function test_RevertWhen_SomeoneElseWithdraws() public {
        vm.prank(keeper);
        vm.expectRevert(FlightGuard.NotUnderwriter.selector);
        guard.withdraw(1);
    }

    function test_ExpireReleasesTheWholeReserveAfterTheWindowAndPaysNoReward() public {
        uint256 id = buyLH400();
        (,,,, uint256 settleBy,,,,) = guard.policies(id);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.SettlementWindowOpen.selector, settleBy));
        guard.expire(id);
        vm.warp(settleBy + 1);
        vm.prank(keeper);
        guard.expire(id);
        assertEq(guard.totalReserved(), 0);
        assertEq(usd.balanceOf(keeper), 0);
        assertEq(uint256(statusOf(id)), uint256(FlightGuard.Status.Expired));
    }

    function test_CanStillSettleAfterTheWindowUntilSomeoneExpires() public {
        uint256 id = buyLH400();
        (,,,, uint256 settleBy,,,,) = guard.policies(id);
        uint256 late = settleBy + 1 days;
        vm.warp(late);
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, late, DELAYED_DATA);
        vm.prank(traveller);
        guard.settle(id, late, DELAYED_DATA, sig);
        assertEq(usd.balanceOf(traveller), 195e6 + KEEPER_REWARD);
    }

    function test_RevertWhen_DeployedWithAZeroAddress() public {
        IERC20 token = IERC20(address(usd));
        vm.expectRevert(FlightGuard.ZeroAddress.selector);
        new FlightGuard(address(0), token, underwriter, KEEPER_REWARD, MAX_PAYOUT);
        vm.expectRevert(FlightGuard.ZeroAddress.selector);
        new FlightGuard(airnode, IERC20(address(0)), underwriter, KEEPER_REWARD, MAX_PAYOUT);
        vm.expectRevert(FlightGuard.ZeroAddress.selector);
        new FlightGuard(airnode, token, address(0), KEEPER_REWARD, MAX_PAYOUT);
    }

    // ------------------------------------------------------------ v5: the schedule bought, keys, caps, pause

    function test_RetimedFlightIsLateAgainstTheScheduleTheTravellerBought() public {
        uint256 id = buyLH400(); // bought with a scheduled arrival of 18:35Z, 120 minute threshold
        // The airline later moved the arrival to 20:35Z; the flight lands 20:40Z, "5 minutes late" by the new schedule
        bytes memory retimed =
            bytes('{"actualArrival":"2026-10-29 20:40Z","scheduledArrival":"2026-10-29 20:35Z","status":"Arrived"}');
        bytes memory sig = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, retimed);
        vm.warp(SIGNED_AT + 60);
        vm.prank(keeper);
        guard.settle(id, SIGNED_AT, retimed, sig);
        assertEq(uint256(statusOf(id)), uint256(FlightGuard.Status.PaidOut)); // 125 minutes after 18:35Z
    }

    function test_RevertWhen_PayoutAboveTheMaximum() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        q.payout = MAX_PAYOUT + 1;
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.PayoutTooLarge.selector, MAX_PAYOUT + 1, MAX_PAYOUT));
        guard.buyPolicy(q, sig, sale);
    }

    function test_RotatingTheQuoteSignerInvalidatesItsQuotes() public {
        uint256 newKey = 0xC0FFEE;
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        bytes memory oldSig = signQuote(q, UNDERWRITER_KEY);
        vm.prank(underwriter);
        guard.setQuoteSigner(vm.addr(newKey));
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.InvalidQuoteSignature.selector);
        guard.buyPolicy(q, oldSig, sale);
        bytes memory newSig = signQuote(q, newKey);
        vm.prank(traveller);
        guard.buyPolicy(q, newSig, sale);
        assertEq(guard.policyCount(), 1);
    }

    function test_RevertWhen_SomeoneElseRotatesTheSignerOrPauses() public {
        vm.startPrank(keeper);
        vm.expectRevert(FlightGuard.NotUnderwriter.selector);
        guard.setQuoteSigner(keeper);
        vm.expectRevert(FlightGuard.NotUnderwriter.selector);
        guard.setPaused(true);
        vm.stopPrank();
    }

    function test_PauseStopsSalesButNotPayouts() public {
        uint256 id = buyLH400();
        vm.prank(underwriter);
        guard.setPaused(true);
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 2);
        bytes memory sig = signQuote(q, UNDERWRITER_KEY);
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(FlightGuard.SalesArePaused.selector);
        guard.buyPolicy(q, sig, sale);

        bytes memory outcome = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, DELAYED_DATA);
        vm.warp(SIGNED_AT + 60);
        vm.prank(keeper);
        guard.settle(id, SIGNED_AT, DELAYED_DATA, outcome);
        assertEq(uint256(statusOf(id)), uint256(FlightGuard.Status.PaidOut));
    }

    function test_RevertWhen_CoverOnOneFlightExceedsHalfThePool() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        q.payout = 500e6; // the pool is 1005 aUSD after the premium: half is 502.5, so this fits
        buyWith(q, saleProof("Expected"));
        FlightGuard.Quote memory more = quoteFor("LH400", "2026-10-29", 2);
        more.payout = 10e6; // 510 on the flight, against half of 1010
        bytes memory sig = signQuote(more, UNDERWRITER_KEY);
        FlightGuard.AirnodeResponse memory sale = saleProof("Expected");
        vm.prank(traveller);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.FlightCoverTooHigh.selector, 510e6, 505e6));
        guard.buyPolicy(more, sig, sale);
    }

    function test_RevertWhen_CoverOnOneDateExceedsEightyPercentOfThePool() public {
        FlightGuard.Quote memory q = quoteFor("LH400", "2026-10-29", 1);
        q.payout = 450e6;
        buyWith(q, saleProof("Expected"));
        // Another flight the same day
        bytes32 otherSale = guard.deriveSaleRequestHash("LH402", "2026-10-29");
        FlightGuard.Quote memory other = quoteFor("LH402", "2026-10-29", 2);
        other.payout = 450e6; // 900 on the date, against 80 % of 1010 = 808
        bytes memory sig = signQuote(other, UNDERWRITER_KEY);
        FlightGuard.AirnodeResponse memory sale = proof(AIRNODE_KEY, otherSale, block.timestamp, saleData("Expected"));
        vm.prank(traveller);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.DateCoverTooHigh.selector, 900e6, 808e6));
        guard.buyPolicy(other, sig, sale);
    }

    function test_SettlingFreesTheCoverAgain() public {
        uint256 id = buyLH400();
        bytes32 key = guard.flightKey("LH400", "2026-10-29");
        assertEq(guard.flightCover(key), 100e6);
        assertEq(guard.dateCover(guard.dateKey("2026-10-29")), 100e6);
        bytes memory outcome = signResponse(AIRNODE_KEY, LH400_20261029_HASH, SIGNED_AT, ON_TIME_DATA);
        vm.warp(SIGNED_AT + 60);
        guard.settle(id, SIGNED_AT, ON_TIME_DATA, outcome);
        assertEq(guard.flightCover(key), 0);
        assertEq(guard.dateCover(guard.dateKey("2026-10-29")), 0);
    }
}
