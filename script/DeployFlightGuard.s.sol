// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console} from "forge-std/Script.sol";
import {FlightGuard} from "../contracts/FlightGuard.sol";

/// @notice Deploys FlightGuard on Base Sepolia and funds its pool with aUSD.
/// The deployer is also the underwriter, so the same key signs quotes later. Travellers buy with their own wallets.
contract DeployFlightGuard is Script {
    address constant AERODATABOX_AIRNODE = 0x83FE2E8F24E66520B1902C3507De4F471248f2Ec;
    address constant AUSD = 0xbeA34973e5f67F18F656A2C6070C64326C791808;
    uint256 constant POOL_FUNDING = 3e6; // 3 aUSD
    // Paid to whoever settles a policy: covers the 0.05 aUSD signed outcome it buys, so settling never costs the keeper
    uint256 constant KEEPER_REWARD = 0.1e6; // 0.1 aUSD
    // Largest payout of one policy
    uint256 constant MAX_PAYOUT = 2e6; // 2 aUSD

    function run() external {
        uint256 key = vm.envUint("PAYER_PRIVATE_KEY");
        address underwriter = vm.addr(key);

        vm.startBroadcast(key);
        FlightGuard guard = new FlightGuard(AERODATABOX_AIRNODE, IERC20(AUSD), underwriter, KEEPER_REWARD, MAX_PAYOUT);
        IERC20(AUSD).transfer(address(guard), POOL_FUNDING);
        vm.stopBroadcast();

        console.log("FlightGuard deployed at", address(guard));
        console.log("Underwriter", underwriter);
        console.log(
            "Pool funded with 3 aUSD, keeper reward 0.1 aUSD, payouts up to 2 aUSD, quotes signed by the underwriter"
        );
    }
}
