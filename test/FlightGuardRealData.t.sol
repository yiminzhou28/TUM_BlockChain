// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {FlightGuard} from "../contracts/FlightGuard.sol";
import {TestUSD} from "./FlightGuard.t.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

/// @notice Settles a policy with a response that the real AeroDataBox Airnode signed, saved by src/fetch-flight.ts.
/// LH400 FRA-JFK on 2026-10-29 arrived 18:39Z against 18:35Z scheduled, 4 minutes late.
contract FlightGuardRealDataTest is AirnodeV2Test {
    address constant AERODATABOX_AIRNODE = 0x83FE2E8F24E66520B1902C3507De4F471248f2Ec;
    uint256 constant UNDERWRITER_KEY = 0xB0B;

    TestUSD usd;
    FlightGuard guard;
    address traveller = makeAddr("traveller");

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
        guard = new FlightGuard(AERODATABOX_AIRNODE, IERC20(address(usd)), vm.addr(UNDERWRITER_KEY));
        usd.mint(address(guard), 1_000e6);
        usd.mint(traveller, 100e6);
        vm.prank(traveller);
        usd.approve(address(guard), type(uint256).max);
        vm.warp(timestamp - 2 days);
    }

    function buy(uint256 thresholdMinutes) internal returns (uint256) {
        FlightGuard.Quote memory q = FlightGuard.Quote({
            holder: traveller,
            flightNumber: "LH400",
            dateLocal: "2026-10-29",
            premium: 5e6,
            payout: 100e6,
            delayThresholdMinutes: thresholdMinutes,
            validUntil: block.timestamp + 1 hours,
            nonce: thresholdMinutes
        });
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(UNDERWRITER_KEY, MessageHashUtils.toEthSignedMessageHash(guard.hashQuote(q)));
        vm.prank(traveller);
        return guard.buyPolicy(q, abi.encodePacked(r, s, v));
    }

    function test_RealResponse_ClosesOnTimePolicy() public {
        uint256 id = buy(120);
        vm.warp(timestamp + 60);
        vm.expectEmit(address(guard));
        emit FlightGuard.PolicySettled(id, FlightGuard.Status.ClosedOnTime, 4, 0);
        guard.settle(id, timestamp, data, signature);
    }

    function test_RealResponse_PaysOutWhenThresholdIsLow() public {
        uint256 id = buy(3); // 4 minutes late is enough for a 3 minute threshold
        vm.warp(timestamp + 60);
        guard.settle(id, timestamp, data, signature);
        assertEq(usd.balanceOf(traveller), 195e6);
    }

    function test_RealResponse_RevertWhen_ArrivalEdited() public {
        uint256 id = buy(120);
        vm.warp(timestamp + 60);
        bytes memory edited =
            bytes('{"actualArrival":"2026-10-29 21:39Z","scheduledArrival":"2026-10-29 18:35Z","status":"Arrived"}');
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        guard.settle(id, timestamp, edited, signature);
    }

    function test_RealResponse_RevertWhen_TooOld() public {
        uint256 id = buy(120);
        vm.warp(timestamp + guard.MAX_RESPONSE_AGE() + 1);
        vm.expectRevert(abi.encodeWithSelector(FlightGuard.ResponseTooOld.selector, timestamp));
        guard.settle(id, timestamp, data, signature);
    }
}