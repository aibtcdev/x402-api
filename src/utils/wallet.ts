/**
 * Wallet utilities for deriving Stacks accounts from mnemonics
 */

import { StacksNetworkName } from "@stacks/network";
import {
  generateNewAccount,
  generateWallet,
  getStxAddress,
} from "@stacks/wallet-sdk";

export async function deriveChildAccount(
  network: string,
  mnemonic: string,
  index: number
) {
  // Create wallet with empty password (wallet isn't persisted)
  const wallet = await generateWallet({
    secretKey: mnemonic,
    password: "",
  });
  // Generate accounts up to the requested index
  for (let i = 0; i <= index; i++) {
    generateNewAccount(wallet);
  }
  // Return address and key for selected index
  return {
    address: getStxAddress({
      account: wallet.accounts[index],
      network: network as StacksNetworkName,
    }),
    key: wallet.accounts[index].stxPrivateKey,
  };
}
