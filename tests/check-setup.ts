#!/usr/bin/env bun
/**
 * Setup Verification Script
 *
 * Verifies test environment is correctly configured:
 * 1. X402_CLIENT_PK is set
 * 2. Wallet address can be derived
 * 3. Balances are sufficient for testing
 *
 * Usage:
 *   bun run tests/check-setup.ts
 *   npm run test:setup
 */

import { deriveChildAccount } from "../src/utils/wallet";
import {
  COLORS,
  X402_CLIENT_PK,
  X402_NETWORK,
  X402_WORKER_URL,
} from "./_shared_utils";

// Minimum balances recommended for testing (in base units)
const MIN_BALANCES = {
  STX: 1_000_000, // 1 STX
  sBTC: 1_000, // 0.00001 sBTC
  USDCx: 100_000, // 0.1 USDCx
};

// Token contract identifiers (testnet)
const TESTNET_TOKENS = {
  sBTC: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token::sbtc-token",
  USDCx: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.usdcx-token::usdcx-token",
};

// Token contract identifiers (mainnet)
const MAINNET_TOKENS = {
  sBTC: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
  USDCx: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx::USDCx",
};

interface BalanceResponse {
  stx: {
    balance: string;
    locked: string;
  };
  fungible_tokens: Record<string, { balance: string }>;
}

async function getBalances(address: string): Promise<{
  stx: number;
  sbtc: number;
  usdcx: number;
}> {
  const apiBase =
    X402_NETWORK === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";

  const url = `${apiBase}/extended/v1/address/${address}/balances`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch balances: ${res.status} ${res.statusText}`
    );
  }

  const data = (await res.json()) as BalanceResponse;

  const tokens = X402_NETWORK === "mainnet" ? MAINNET_TOKENS : TESTNET_TOKENS;

  return {
    stx: parseInt(data.stx.balance, 10) || 0,
    sbtc: parseInt(data.fungible_tokens[tokens.sBTC]?.balance || "0", 10),
    usdcx: parseInt(data.fungible_tokens[tokens.USDCx]?.balance || "0", 10),
  };
}

function formatBalance(
  amount: number,
  decimals: number,
  symbol: string
): string {
  const value = amount / Math.pow(10, decimals);
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: decimals > 4 ? 4 : decimals,
    maximumFractionDigits: decimals > 4 ? 4 : decimals,
  })} ${symbol}`;
}

function checkIcon(ok: boolean): string {
  return ok
    ? `${COLORS.green}✓${COLORS.reset}`
    : `${COLORS.red}✗${COLORS.reset}`;
}

async function main() {
  console.log(`\n${COLORS.bright}${"=".repeat(60)}${COLORS.reset}`);
  console.log(
    `${COLORS.bright}  X402 API Test Setup Verification${COLORS.reset}`
  );
  console.log(`${COLORS.bright}${"=".repeat(60)}${COLORS.reset}\n`);

  let hasErrors = false;

  // Check 1: X402_CLIENT_PK is set
  console.log(`${COLORS.cyan}1. Checking environment...${COLORS.reset}`);

  if (!X402_CLIENT_PK) {
    console.log(`   ${checkIcon(false)} X402_CLIENT_PK is not set`);
    console.log(
      `\n   ${COLORS.yellow}Set your testnet mnemonic:${COLORS.reset}`
    );
    console.log(
      `   export X402_CLIENT_PK="your twelve word mnemonic phrase here"\n`
    );
    process.exit(1);
  }
  console.log(`   ${checkIcon(true)} X402_CLIENT_PK is set`);

  // Check mnemonic format (basic validation)
  const wordCount = X402_CLIENT_PK.trim().split(/\s+/).length;
  if (wordCount !== 12 && wordCount !== 24) {
    console.log(
      `   ${checkIcon(
        false
      )} Mnemonic should be 12 or 24 words (got ${wordCount})`
    );
    hasErrors = true;
  } else {
    console.log(
      `   ${checkIcon(true)} Mnemonic format looks valid (${wordCount} words)`
    );
  }

  console.log(`   ${checkIcon(true)} Network: ${X402_NETWORK}`);
  console.log(`   ${checkIcon(true)} Server:  ${X402_WORKER_URL}`);

  // Check 2: Derive wallet address
  console.log(`\n${COLORS.cyan}2. Deriving wallet address...${COLORS.reset}`);

  let address: string;
  try {
    const account = await deriveChildAccount(X402_NETWORK, X402_CLIENT_PK, 0);
    address = account.address;
    console.log(`   ${checkIcon(true)} Address: ${address}`);
  } catch (error) {
    console.log(`   ${checkIcon(false)} Failed to derive address: ${error}`);
    process.exit(1);
  }

  // Check 3: Fetch balances
  console.log(`\n${COLORS.cyan}3. Checking balances...${COLORS.reset}`);

  try {
    const balances = await getBalances(address);

    // STX (6 decimals)
    const stxOk = balances.stx >= MIN_BALANCES.STX;
    console.log(
      `   ${checkIcon(stxOk)} STX:   ${formatBalance(balances.stx, 6, "STX")}${
        !stxOk ? ` (need ${formatBalance(MIN_BALANCES.STX, 6, "STX")})` : ""
      }`
    );
    if (!stxOk) hasErrors = true;

    // sBTC (8 decimals)
    const sbtcOk = balances.sbtc >= MIN_BALANCES.sBTC;
    console.log(
      `   ${checkIcon(sbtcOk)} sBTC:  ${formatBalance(
        balances.sbtc,
        8,
        "sBTC"
      )}${
        !sbtcOk ? ` (need ${formatBalance(MIN_BALANCES.sBTC, 8, "sBTC")})` : ""
      }`
    );
    if (!sbtcOk) hasErrors = true;

    // USDCx (6 decimals)
    const usdcxOk = balances.usdcx >= MIN_BALANCES.USDCx;
    console.log(
      `   ${checkIcon(usdcxOk)} USDCx: ${formatBalance(
        balances.usdcx,
        6,
        "USDCx"
      )}${
        !usdcxOk
          ? ` (need ${formatBalance(MIN_BALANCES.USDCx, 6, "USDCx")})`
          : ""
      }`
    );
    if (!usdcxOk) hasErrors = true;
  } catch (error) {
    console.log(`   ${checkIcon(false)} Failed to fetch balances: ${error}`);
    hasErrors = true;
  }

  // Check 4: Test server reachability
  console.log(`\n${COLORS.cyan}4. Checking server...${COLORS.reset}`);

  try {
    const res = await fetch(X402_WORKER_URL);
    if (res.ok) {
      console.log(`   ${checkIcon(true)} Server is reachable`);
    } else {
      console.log(`   ${checkIcon(false)} Server returned ${res.status}`);
      hasErrors = true;
    }
  } catch (error) {
    console.log(`   ${checkIcon(false)} Server unreachable: ${error}`);
    hasErrors = true;
  }

  // Summary
  console.log(`\n${COLORS.bright}${"=".repeat(60)}${COLORS.reset}`);

  if (hasErrors) {
    console.log(
      `${COLORS.yellow}${COLORS.bright}  Setup has warnings - some tests may fail${COLORS.reset}`
    );
    console.log(`${COLORS.bright}${"=".repeat(60)}${COLORS.reset}\n`);

    if (X402_NETWORK === "testnet") {
      console.log(`${COLORS.cyan}To get testnet tokens:${COLORS.reset}`);
      console.log(
        `  STX:   https://explorer.hiro.so/sandbox/faucet?chain=testnet`
      );
      console.log(`  sBTC:  https://platform.hiro.so/faucet`);
      console.log(`  USDCx: (no testnet faucet available yet)\n`);
    }

    process.exit(1);
  } else {
    console.log(
      `${COLORS.green}${COLORS.bright}  Setup verified - ready to run tests!${COLORS.reset}`
    );
    console.log(`${COLORS.bright}${"=".repeat(60)}${COLORS.reset}\n`);
    console.log(`Run tests with: ${COLORS.cyan}npm test${COLORS.reset}\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`\n${COLORS.red}Fatal error:${COLORS.reset}`, err);
  process.exit(1);
});
