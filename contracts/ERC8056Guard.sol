// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal surface of a Robinhood Chain ERC-8056 Stock Token.
interface IStockToken {
    function balanceOf(address account) external view returns (uint256);
    function uiMultiplier() external view returns (uint256);
    function oraclePaused() external view returns (bool);
}

/// @notice Chainlink AggregatorV3 surface.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * @title ERC8056Guard
 * @notice Free, permissionless, ownerless. Reads ERC-8056 Stock Tokens correctly, or refuses.
 *
 * WHY THIS EXISTS.
 *
 * Under ERC-8056 a corporate action moves `uiMultiplier()`, not balances. So `balanceOf()` returns
 * TOKENS, and the share-equivalent count is `balance * uiMultiplier() / 1e18`. Measured on chain
 * 4663: of the addresses holding these tokens, roughly 80% are contracts, and the substantial ones
 * sampled contain no `uiMultiplier()` selector in their bytecode at all — they cannot make that
 * correction even in principle.
 *
 * ASSAY detects that off-chain and publishes it. This is the other half: the preventive primitive
 * that makes the mistake impossible for anyone who opts in, deployed at a known address so a
 * single external call replaces a defect class.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 * It has no owner, no upgrade path, no storage and no privileged caller. It never moves a token and
 * never blocks anything: it is `view` only. ASSAY has no control path over what it audits, and this
 * contract preserves that exactly — it emits something *executable* without ever holding a key.
 * A caller chooses to read it. Nothing is imposed.
 *
 * THE REFUSAL IS THE PRODUCT.
 *
 * `safe == false` with a reason is the correct answer when the inputs do not support a number.
 * Returning a plausible-looking wrong figure is the failure this whole project exists to prevent,
 * and it is the one thing a naive integration does by default. The ladder below mirrors, on-chain,
 * the exact order used off-chain in ASSAY's paid `truePosition()` primitive.
 */
contract ERC8056Guard {
    /// @dev ERC-8056 multipliers are 1e18 fixed point regardless of the token's own decimals().
    uint256 private constant ONE = 1e18;

    /// @dev Feeds on this chain publish an 86400s heartbeat; callers may supply their own.
    uint256 public constant DEFAULT_HEARTBEAT = 86400;

    /**
     * @notice Share-equivalents for `holder`, and whether the reading is safe to act on.
     * @dev Never reverts. A caller that wants a revert should use `safeShareEquivalents`.
     * @return shares balance * uiMultiplier() / 1e18. Zero when unsafe.
     * @return safe   False when any check did not COMPLETE or did not pass.
     * @return reason Empty when safe; otherwise why the number must not be used.
     */
    function shareEquivalents(address token, address holder)
        public
        view
        returns (uint256 shares, bool safe, string memory reason)
    {
        (bool okBal, uint256 balance) = _balanceOf(token, holder);
        if (!okBal) return (0, false, "balanceOf() unreadable");

        (bool okMul, uint256 multiplier) = _uiMultiplier(token);
        if (!okMul) return (0, false, "uiMultiplier() unreadable");
        // A zero multiplier zeroes every share count and makes every derived price infinite.
        if (multiplier == 0) return (0, false, "uiMultiplier() is zero");

        // oraclePaused() is a SAFETY check. Failing to read it is not the same as reading false.
        (bool okPaused, bool paused) = _oraclePaused(token);
        if (!okPaused) return (0, false, "oraclePaused() unreadable - corporate-action check did not complete");
        if (paused) return (0, false, "oraclePaused() is true");

        return ((balance * multiplier) / ONE, true, "");
    }

    /// @notice As `shareEquivalents`, but reverts instead of returning `safe == false`.
    function safeShareEquivalents(address token, address holder) external view returns (uint256) {
        (uint256 shares, bool safe, string memory reason) = shareEquivalents(token, holder);
        require(safe, reason);
        return shares;
    }

    /**
     * @notice Position value in USD, using the Chainlink TOKEN price.
     * @dev The feed is ALREADY multiplier-adjusted, so the multiplier must NOT be applied again --
     *      Robinhood's own documentation says so explicitly, and double-applying it is the most
     *      common way to get this wrong. Value is therefore tokenUnits * feedPrice, not shares.
     * @param heartbeat Seconds before the feed is considered stale; pass 0 for DEFAULT_HEARTBEAT.
     */
    function positionValue(address token, address holder, address feed, uint256 heartbeat)
        external
        view
        returns (uint256 valueUsd8, bool safe, string memory reason)
    {
        (, bool ok, string memory why) = shareEquivalents(token, holder);
        if (!ok) return (0, false, why);

        (bool okPrice, uint256 price, uint8 feedDecimals) = _price(feed, heartbeat);
        if (!okPrice) return (0, false, "feed unusable: stale, non-positive, incomplete round, or unreadable");

        (, uint256 balance) = _balanceOf(token, holder);
        // Normalise to 8dp, the Chainlink convention on this chain.
        uint256 scaled = feedDecimals <= 8
            ? price * (10 ** (8 - feedDecimals))
            : price / (10 ** (feedDecimals - 8));
        return ((balance * scaled) / ONE, true, "");
    }

    /// @notice Whether a feed is currently usable, and why not when it is not.
    function feedUsable(address feed, uint256 heartbeat) external view returns (bool usable, string memory reason) {
        (bool ok,,) = _price(feed, heartbeat);
        if (ok) return (true, "");
        return (false, "stale, non-positive, incomplete round, or unreadable");
    }

    /**
     * @notice Does `account` reference uiMultiplier() in its own deployed bytecode?
     * @dev The on-chain form of ASSAY's integrator audit. FALSE IS NOT AN ACCUSATION: a contract
     *      that only custodies or routes the token never needs the multiplier. It means only that
     *      the call cannot be made from this bytecode. Proxies report on the STUB, which is why the
     *      off-chain auditor resolves EIP-1967, beacon and EIP-1167 proxies and this cannot.
     */
    function referencesMultiplier(address account) external view returns (bool found, uint256 codeSize) {
        codeSize = account.code.length;
        if (codeSize == 0) return (false, 0);
        bytes memory code = account.code;
        bytes4 sel = IStockToken.uiMultiplier.selector;
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2] && code[i + 3] == sel[3]) {
                return (true, codeSize);
            }
        }
        return (false, codeSize);
    }

    // --- internals: every external read is bounded and never propagates a revert ---

    function _balanceOf(address token, address holder) private view returns (bool, uint256) {
        try IStockToken(token).balanceOf(holder) returns (uint256 v) {
            return (true, v);
        } catch {
            return (false, 0);
        }
    }

    function _uiMultiplier(address token) private view returns (bool, uint256) {
        try IStockToken(token).uiMultiplier() returns (uint256 v) {
            return (true, v);
        } catch {
            return (false, 0);
        }
    }

    function _oraclePaused(address token) private view returns (bool, bool) {
        try IStockToken(token).oraclePaused() returns (bool v) {
            return (true, v);
        } catch {
            return (false, false);
        }
    }

    function _price(address feed, uint256 heartbeat) private view returns (bool, uint256, uint8) {
        if (feed == address(0)) return (false, 0, 0);
        uint256 maxAge = heartbeat == 0 ? DEFAULT_HEARTBEAT : heartbeat;
        try IAggregatorV3(feed).latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0) return (false, 0, 0);
            // An incomplete round carries an answer from an earlier one; updatedAt does not reveal it.
            if (answeredInRound < roundId) return (false, 0, 0);
            if (updatedAt == 0 || block.timestamp - updatedAt > maxAge) return (false, 0, 0);
            try IAggregatorV3(feed).decimals() returns (uint8 d) {
                return (true, uint256(answer), d);
            } catch {
                // A wrong exponent is a 10^n error, so an unread decimals() refuses rather than guesses.
                return (false, 0, 0);
            }
        } catch {
            return (false, 0, 0);
        }
    }
}
