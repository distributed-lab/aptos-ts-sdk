import { aptos, getTestAccount, TOKEN_ADDRESS } from "../helpers";

describe("should check if user veiled account is frozen", () => {
  const alice = getTestAccount();

  it("should check if user veiled account is frozen", async () => {
    const isFrozen = await aptos.veiledCoin.isBalanceFrozen({
      accountAddress: alice.accountAddress,
      tokenAddress: TOKEN_ADDRESS,
    });

    console.log(`${alice.accountAddress.toString()} frozen status is:`, isFrozen);

    expect(isFrozen).toBeDefined();
  });
});