import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  getScaledUiAmountConfig,
} from "@solana/spl-token";
import { assert } from "chai";
import { Paritas } from "../target/types/paritas";

// Real mainnet mints from CONTEXT.md. Do not replace these with anything not
// written there.
const NVDAX_MINT = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
const NVDAON_MINT = new PublicKey("gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo");

// Mirrors multiplier.rs exactly: MULTIPLIER_SCALE and RATE_SCALE must match
// programs/paritas/src/multiplier.rs bit for bit, since this is used to
// independently recompute the expected rate for comparison against the
// on-chain result.
const MULTIPLIER_SCALE = 1_000_000_000_000_000_000; // 1e18, as an f64-safe number

// tsconfig targets es6, which has TypeScript downlevel the ** operator to
// Math.pow, and Math.pow rejects BigInt operands. Use a plain loop instead.
function pow10(exponent: bigint): bigint {
  let result = 1n;
  for (let i = 0n; i < exponent; i++) {
    result *= 10n;
  }
  return result;
}

const RATE_SCALE = pow10(9n);

/**
 * Selects multiplier or newMultiplier by comparing newMultiplierEffective
 * Timestamp against `now`, then converts the chosen f64 straight to a u128
 * fixed point BigInt. This is a line for line mirror of
 * multiplier::current_multiplier_fixed in the Rust program: the only
 * floating point step is `chosen * MULTIPLIER_SCALE`, rounded once, then
 * cast to an integer.
 */
function currentMultiplierFixed(
  multiplier: number,
  newMultiplier: number,
  effectiveTimestamp: bigint,
  now: bigint,
): bigint {
  const chosen = now >= effectiveTimestamp ? newMultiplier : multiplier;
  if (!Number.isFinite(chosen) || chosen <= 0) {
    throw new Error("invalid multiplier read from mint");
  }
  const fixed = chosen * MULTIPLIER_SCALE;
  if (!Number.isFinite(fixed) || fixed < 0) {
    throw new Error("multiplier overflowed fixed point conversion");
  }
  return BigInt(Math.round(fixed));
}

/**
 * Mirrors multiplier::compute_rate: amount_b = amount_a * rate / RATE_SCALE,
 * normalised for the difference in decimals between the two mints.
 */
function computeRate(
  multAFixed: bigint,
  decimalsA: number,
  multBFixed: bigint,
  decimalsB: number,
): bigint {
  if (multAFixed === 0n || multBFixed === 0n) {
    throw new Error("invalid multiplier");
  }
  let numerator = multAFixed * RATE_SCALE;
  let denominator: bigint;
  if (decimalsB >= decimalsA) {
    numerator *= pow10(BigInt(decimalsB - decimalsA));
    denominator = multBFixed;
  } else {
    denominator = multBFixed * pow10(BigInt(decimalsA - decimalsB));
  }
  return numerator / denominator;
}

describe("paritas: surfpool mainnet fork", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.paritas as Program<Paritas>;
  const connection = provider.connection;

  it("registers the real NVDAx/NVDAon pair and matches get_rate against an independent recomputation", async () => {
    // The program requires mint_a's key to sort lexicographically before
    // mint_b's; this is enforced on chain, not auto-sorted, so the client
    // must sort before calling register_pair.
    const [mintA, mintB] =
      Buffer.compare(NVDAX_MINT.toBuffer(), NVDAON_MINT.toBuffer()) < 0
        ? [NVDAX_MINT, NVDAON_MINT]
        : [NVDAON_MINT, NVDAX_MINT];

    const [pairPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pair"), mintA.toBuffer(), mintB.toBuffer()],
      program.programId,
    );

    const authority = provider.wallet.publicKey;
    const feeBps = 30; // 0.30%, arbitrary for this test

    await program.methods
      .registerPair(feeBps, authority)
      .accounts({
        payer: provider.wallet.publicKey,
        mintA,
        mintB,
        pair: pairPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const pairAccount = await program.account.pair.fetch(pairPda);
    assert.strictEqual(pairAccount.mintA.toBase58(), mintA.toBase58());
    assert.strictEqual(pairAccount.mintB.toBase58(), mintB.toBase58());

    // Read the same, real, forked mint accounts get_rate will read, and
    // independently recompute the expected rate off chain. This is not the
    // frozen CONTEXT.md fixture: Surfpool forks *current* mainnet state, so
    // the live multiplier may have moved since CONTEXT.md's slot 447023331
    // snapshot. What is being checked is that the on-chain math and this
    // off-chain mirror agree on whatever the fork actually returns.
    const [mintAInfo, mintBInfo] = await Promise.all([
      connection.getAccountInfo(mintA),
      connection.getAccountInfo(mintB),
    ]);
    assert.isNotNull(mintAInfo, "mint A did not clone from the mainnet fork");
    assert.isNotNull(mintBInfo, "mint B did not clone from the mainnet fork");

    const unpackedA = unpackMint(mintA, mintAInfo, TOKEN_2022_PROGRAM_ID);
    const unpackedB = unpackMint(mintB, mintBInfo, TOKEN_2022_PROGRAM_ID);

    const configA = getScaledUiAmountConfig(unpackedA);
    const configB = getScaledUiAmountConfig(unpackedB);
    assert.isNotNull(configA, "mint A missing ScaledUiAmountConfig");
    assert.isNotNull(configB, "mint B missing ScaledUiAmountConfig");

    const slot = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);
    const now = BigInt(blockTime ?? Math.floor(Date.now() / 1000));

    const multA = currentMultiplierFixed(
      configA.multiplier,
      configA.newMultiplier,
      BigInt(configA.newMultiplierEffectiveTimestamp.toString()),
      now,
    );
    const multB = currentMultiplierFixed(
      configB.multiplier,
      configB.newMultiplier,
      BigInt(configB.newMultiplierEffectiveTimestamp.toString()),
      now,
    );

    const expectedRate = computeRate(
      multA,
      unpackedA.decimals,
      multB,
      unpackedB.decimals,
    );

    const onChainRate: BN = await program.methods
      .getRate()
      .accounts({
        pair: pairPda,
        mintA,
        mintB,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .view();

    console.log(`mint A (${mintA.toBase58()}) decimals=${unpackedA.decimals} multiplier=${configA.multiplier} newMultiplier=${configA.newMultiplier}`);
    console.log(`mint B (${mintB.toBase58()}) decimals=${unpackedB.decimals} multiplier=${configB.multiplier} newMultiplier=${configB.newMultiplier}`);
    console.log(`get_rate() on-chain result:      ${onChainRate.toString()}`);
    console.log(`independently computed expected: ${expectedRate.toString()}`);

    assert.strictEqual(onChainRate.toString(), expectedRate.toString());
  });
});
