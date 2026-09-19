/**
 * Creates the Investire devnet demo environment, and is safe to rerun.
 *
 * Every step checks the chain before it acts, so a second run against a
 * half-built environment finishes the job rather than failing or creating a
 * duplicate. Reruns are the normal case here, not the exception: devnet
 * accounts get wiped, a transaction times out halfway through, the vault
 * exists but one wrapper did not land.
 *
 * Devnet has no real xStock or Ondo mints, so this creates mock Token-2022
 * mints carrying the real ScaledUiAmountConfig values from CONTEXT.md,
 * including NVDAx's pending multiplier change. The mocks are economically
 * indistinguishable from the real wrappers as far as this program is
 * concerned, because the only thing it reads off a wrapper mint is that
 * config.
 *
 * Usage: npx ts-node scripts/setup-devnet.ts
 */
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  getScaledUiAmountConfig,
  unpackMint,
} from "@solana/spl-token";
import {
  ADDRESS_BOOK_PATH,
  AddressBook,
  ContextFacts,
  MintFacts,
  VaultEntry,
  REPO_ROOT,
  WrapperEntry,
  currentMultiplierFixed,
  formatAmount,
  loadAddressBookIfPresent,
  loadContext,
  saveAddressBook,
  withRetry,
} from "./devnet-lib";

/**
 * The vaults to build, and which CONTEXT.md mints each one accepts.
 *
 * displayName is what a person calls the thing. The vault symbol is a ticker
 * for the underlying, but nobody saving five dollars a week thinks of
 * themselves as buying NVDA, let alone NVDAx. It and the description live in
 * the address book so the frontend carries no per asset knowledge and a new
 * vault needs no frontend change. Neither may ever name a wrapper.
 *
 * The first entry is the one the address book's legacy `vault` and `wrappers`
 * fields mirror, so it stays NVDA.
 */
const VAULT_SPECS: {
  symbol: string;
  displayName: string;
  description: string;
  /** The Pyth symbol for the underlying; its id comes from CONTEXT.md. */
  priceFeed: string;
  mints: (context: ContextFacts) => MintFacts[];
}[] = [
  {
    symbol: "NVDA",
    displayName: "NVIDIA",
    description: "One company",
    priceFeed: "Equity.US.NVDA/USD",
    mints: (context) => [context.nvdax, context.nvdaon],
  },
  {
    symbol: "SPY",
    displayName: "S&P 500",
    description: "500 of the largest US companies in one",
    priceFeed: "Equity.US.SPY/USD",
    mints: (context) => [context.spyx],
  },
];

/**
 * Wrapper inventory the keeper is topped up to, per vault, in whole units of
 * the wrapper it delivers. While the swap leg is the devnet substitute every
 * execution is paid out of this, so a vault the keeper holds nothing of is a
 * vault whose plans are skipped on every run.
 */
const KEEPER_INVENTORY_WHOLE = 100n;

/**
 * Keeper fee for the demo vault: a quarter of a percent, but never less than
 * five cents. The absolute floor is the part that matters at these sizes, a
 * quarter of a percent of a five dollar buy is about a cent, which does not
 * cover a priority fee on a busy slot. Retunable later with set_keeper_fee.
 */
const KEEPER_FEE_BPS = 25;
const KEEPER_FEE_MIN = 50_000n; // 0.05 USDC, six decimals

/** Test balance minted to the wallet for each mock wrapper: 100 whole units. */
const WRAPPER_TEST_BALANCE_WHOLE = 100n;

function pow10(exponent: number): bigint {
  let result = 1n;
  for (let i = 0; i < exponent; i++) {
    result *= 10n;
  }
  return result;
}

function log(step: string, detail: string): void {
  console.log(`  ${step.padEnd(14)} ${detail}`);
}

/**
 * Where a created mint's keypair is kept between runs. Without this a rerun
 * would have no way to recognise the mint it made last time, since a mint
 * address is just a generated keypair. The address book records the public
 * key; this file keeps the secret so the script stays idempotent.
 */
function mockMintKeypairPath(label: string): string {
  return path.join(REPO_ROOT, ".devnet-keys", `${label}.json`);
}

function loadOrCreateKeypair(file: string): Keypair {
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")))
    );
  }
  const keypair = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

async function accountExists(
  connection: Connection,
  address: PublicKey
): Promise<boolean> {
  const info = await withRetry(`getAccountInfo ${address.toBase58()}`, () =>
    connection.getAccountInfo(address)
  );
  return info !== null;
}

/**
 * Sends a transaction, riding out transport blips on the public endpoint.
 *
 * The reset matters. A Transaction keeps the blockhash and signatures from its
 * last send attempt, so handing the same object back to
 * sendAndConfirmTransaction retries it with the stale blockhash that just
 * failed, and it fails again for the same reason. Clearing both makes each
 * attempt a genuinely fresh one.
 */
async function send(
  connection: Connection,
  what: string,
  transaction: Transaction,
  signers: Keypair[],
  idempotent = false
): Promise<string> {
  return withRetry(
    what,
    () => {
      transaction.recentBlockhash = undefined;
      transaction.lastValidBlockHeight = undefined;
      transaction.signatures = [];
      return sendAndConfirmTransaction(connection, transaction, signers);
    },
    { idempotent }
  );
}

async function tokenBalance(
  connection: Connection,
  address: PublicKey
): Promise<bigint> {
  const balance = await withRetry(`balance of ${address.toBase58()}`, () =>
    connection.getTokenAccountBalance(address)
  );
  return BigInt(balance.value.amount);
}

/**
 * The multiplier a mint is actually valued at right now, which is the only
 * number the program reads. Mirrors multiplier::current_multiplier_fixed's
 * branch: new_multiplier once its effective timestamp has passed, otherwise
 * multiplier.
 */
function liveMultiplierOf(facts: MintFacts, now: number): number {
  return now >= facts.newMultiplierEffectiveTimestamp
    ? facts.newMultiplier
    : facts.multiplier;
}

/**
 * Creates a mock Token-2022 wrapper mint valued at the real mint's live
 * multiplier, or verifies the one a previous run created.
 *
 * On what the mock can and cannot reproduce. CONTEXT.md records NVDAx with
 * multiplier and newMultiplier holding different values and an effective
 * timestamp that has since passed, so newMultiplier is live. That pair cannot
 * be recreated on a fresh mint: Token-2022's UpdateMultiplier refuses to leave
 * multiplier stale when the effective timestamp is already in the past, and
 * collapses both fields onto the new value. Asking for the mainnet triple gets
 * a mint that does not match it, which the readback below catches.
 *
 * The alternative, setting a future effective timestamp to keep the pending
 * shape, is worse: it would make the OLD multiplier the live one, so every
 * conversion in the demo would be computed at a rate mainnet is not using.
 *
 * So the mock is initialised directly at the live multiplier. The pending
 * change is the one thing lost, and it is the one thing that does not matter
 * here, because the program collapses it to a single value on the first line
 * of every conversion anyway. What is preserved is the part the whole thesis
 * rests on: NVDAx and NVDAon carry different live multipliers, drifted apart
 * by exactly what they are drifted apart by on mainnet.
 */
async function ensureMockMint(
  connection: Connection,
  payer: Keypair,
  facts: MintFacts,
  now: number
): Promise<{ mint: PublicKey; liveMultiplier: number }> {
  const keypair = loadOrCreateKeypair(mockMintKeypairPath(facts.label));
  const mint = keypair.publicKey;
  const live = liveMultiplierOf(facts, now);

  if (!(await accountExists(connection, mint))) {
    const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
    const lamports = await withRetry("rent exemption", () =>
      connection.getMinimumBalanceForRentExemption(space)
    );

    const create = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint,
        space,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      // The config must be initialised before InitializeMint, which is why
      // this is hand built rather than the createMint helper.
      createInitializeScaledUiAmountConfigInstruction(
        mint,
        payer.publicKey,
        live,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint,
        facts.decimals,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await send(connection, `create ${facts.label} mock mint`, create, [
      payer,
      keypair,
    ]);
    log("mint", `created ${facts.label} mock ${mint.toBase58()}`);
  } else {
    log("mint", `reusing ${facts.label} mock ${mint.toBase58()}`);
  }

  // Read the mint back and insist the program would value it exactly as it
  // values the real thing. The comparison is on the fixed point conversion the
  // program performs, not on the raw fields, because the fields are allowed to
  // differ in shape as long as the number they resolve to is identical.
  const info = await withRetry(`read ${facts.label} mock mint`, () =>
    connection.getAccountInfo(mint)
  );
  if (!info) {
    throw new Error(`${facts.label} mock mint vanished after creation`);
  }
  const unpacked = unpackMint(mint, info, TOKEN_2022_PROGRAM_ID);
  const config = getScaledUiAmountConfig(unpacked);
  if (!config) {
    throw new Error(`${facts.label} mock mint has no ScaledUiAmountConfig`);
  }

  const mismatches: string[] = [];
  if (unpacked.decimals !== facts.decimals) {
    mismatches.push(`decimals ${unpacked.decimals} != ${facts.decimals}`);
  }

  const mockFixed = currentMultiplierFixed(
    config.multiplier,
    config.newMultiplier,
    Number(config.newMultiplierEffectiveTimestamp.toString()),
    now
  );
  const mainnetFixed = currentMultiplierFixed(
    facts.multiplier,
    facts.newMultiplier,
    facts.newMultiplierEffectiveTimestamp,
    now
  );
  if (mockFixed !== mainnetFixed) {
    mismatches.push(
      `live multiplier ${mockFixed} != CONTEXT.md's ${mainnetFixed}`
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `${facts.label} mock mint does not match CONTEXT.md: ${mismatches.join(
        "; "
      )}. ` +
        `Delete ${mockMintKeypairPath(
          facts.label
        )} and rerun to build a fresh one.`
    );
  }

  log(
    "mint",
    `  verified: live multiplier ${live}, same as the real ${facts.label}`
  );

  return { mint, liveMultiplier: live };
}

/**
 * The keeper's public key, for stocking its inventory. Read from KEEPER_PUBKEY
 * if set, otherwise from the keypair the keeper README has deployed out of
 * .devnet-keys. Only the public half is used; setup never signs as the keeper.
 * Null when neither is present, in which case stocking is skipped and said so.
 */
function keeperPublicKey(): PublicKey | null {
  if (process.env.KEEPER_PUBKEY) {
    return new PublicKey(process.env.KEEPER_PUBKEY);
  }
  const file = path.join(REPO_ROOT, ".devnet-keys", "keeper.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")))
  ).publicKey;
}

/**
 * Confirms a price feed id from CONTEXT.md is the feed its symbol says, by
 * asking Hermes' feed list, which is keyless. Guards against an id copied
 * against the wrong line, or a wrapper feed standing in for the underlying:
 * the symbol, the asset type and the id all have to agree.
 */
async function verifyPriceFeed(symbol: string, id: string): Promise<void> {
  const ticker = symbol.split(".").pop()!.split("/")[0];
  const url = `https://hermes.pyth.network/v2/price_feeds?query=${encodeURIComponent(
    ticker
  )}&asset_type=equity`;
  const feeds = (await withRetry(`pyth feed list for ${ticker}`, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Hermes feed list returned ${response.status}`);
    }
    return response.json();
  })) as { id: string; attributes: { symbol: string } }[];
  const match = feeds.find((feed) => feed.attributes.symbol === symbol);
  if (!match) {
    throw new Error(`Pyth has no feed named ${symbol}`);
  }
  if (match.id.replace(/^0x/, "") !== id) {
    throw new Error(
      `Pyth lists ${symbol} as ${match.id}, but CONTEXT.md says ${id}`
    );
  }
  log("price feed", `verified ${symbol} ${id.slice(0, 8)}...`);
}

/**
 * Tops a token account up to a target, minting only the shortfall, so reruns
 * never inflate a balance without bound.
 */
async function topUp(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  account: PublicKey,
  facts: MintFacts,
  whole: bigint,
  who: string
): Promise<void> {
  const target = whole * pow10(facts.decimals);
  const held = await tokenBalance(connection, account);
  if (held >= target) {
    log(
      "balance",
      `${who} already holds ${formatAmount(held, facts.decimals)} ${facts.label}`
    );
    return;
  }
  const shortfall = target - held;
  await send(
    connection,
    `mint ${facts.label} to ${who}`,
    new Transaction().add(
      createMintToInstruction(
        mint,
        account,
        wallet.publicKey,
        shortfall,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    ),
    [wallet]
  );
  log(
    "balance",
    `minted ${formatAmount(shortfall, facts.decimals)} ${facts.label} to ${who}`
  );
}

/**
 * One vault end to end: its mock mints, the vault itself, each wrapper
 * registered with the vault's holding account, test balances for the setup
 * wallet, and keeper inventory of the wrapper the keeper delivers.
 */
async function ensureVault(params: {
  connection: Connection;
  program: Program<anchor.Idl>;
  wallet: Keypair;
  spec: (typeof VAULT_SPECS)[number];
  facts: MintFacts[];
  usdcDecimals: number;
  keeper: PublicKey | null;
  now: number;
  priceFeeds: Record<string, string>;
}): Promise<VaultEntry> {
  const { connection, program, wallet, spec, facts, usdcDecimals, keeper, now } =
    params;
  const owner = wallet.publicKey;

  console.log(`Vault ${spec.symbol}:`);
  const feedId = params.priceFeeds[spec.priceFeed];
  if (!feedId) {
    throw new Error(`CONTEXT.md has no id for price feed ${spec.priceFeed}`);
  }
  await verifyPriceFeed(spec.priceFeed, feedId);
  console.log("  Mock wrapper mints (devnet has no real xStock or Ondo mints):");
  const mints: PublicKey[] = [];
  const liveMultipliers: number[] = [];
  for (const fact of facts) {
    const made = await ensureMockMint(connection, wallet, fact, now);
    mints.push(made.mint);
    liveMultipliers.push(made.liveMultiplier);
  }

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(spec.symbol)],
    program.programId
  );
  const [receiptMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), vaultPda.toBuffer()],
    program.programId
  );

  if (!(await accountExists(connection, vaultPda))) {
    await program.methods
      .initVault(
        spec.symbol,
        owner,
        KEEPER_FEE_BPS,
        new BN(KEEPER_FEE_MIN.toString())
      )
      .accounts({
        payer: owner,
        vault: vaultPda,
        receiptMint: receiptMintPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    log("vault", `created ${vaultPda.toBase58()}`);
  } else {
    log("vault", `reusing ${vaultPda.toBase58()}`);
  }

  const vaultAccount = (await withRetry("fetch vault", () =>
    (program.account as any).vault.fetch(vaultPda)
  )) as {
    tokenProgram: PublicKey;
    authority: PublicKey;
    keeperFeeBps: number;
    keeperFeeMin: BN;
  };
  if (!vaultAccount.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(
      `vault ${spec.symbol} was created under ${vaultAccount.tokenProgram.toBase58()}, ` +
        "not Token-2022, so it cannot accept these wrappers. Choose a new symbol."
    );
  }
  log("receipt mint", receiptMintPda.toBase58());
  log(
    "keeper fee",
    `${vaultAccount.keeperFeeBps} bps, minimum ${formatAmount(
      BigInt(vaultAccount.keeperFeeMin.toString()),
      usdcDecimals
    )} USDC`
  );

  const wrappers: WrapperEntry[] = [];
  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    const fact = facts[i];

    const [wrapperPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wrapper"), vaultPda.toBuffer(), mint.toBuffer()],
      program.programId
    );

    if (!(await accountExists(connection, wrapperPda))) {
      await program.methods
        .addWrapper()
        .accounts({
          payer: owner,
          vault: vaultPda,
          authority: owner,
          mint,
          wrapper: wrapperPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      log("wrapper", `registered ${fact.label} ${wrapperPda.toBase58()}`);
    } else {
      log("wrapper", `reusing ${fact.label} ${wrapperPda.toBase58()}`);
    }

    // The vault's own holding account. settle_execution sweeps the execution
    // escrow into this, so it has to exist before any schedule runs; nothing
    // in the program creates it.
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vaultPda,
      true, // the vault is a PDA, so it is off the ed25519 curve
      TOKEN_2022_PROGRAM_ID
    );
    const ownerTokenAccount = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const setup = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        vaultTokenAccount,
        vaultPda,
        mint,
        TOKEN_2022_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ownerTokenAccount,
        owner,
        mint,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await send(connection, `token accounts for ${fact.label}`, setup, [wallet]);

    await topUp(
      connection,
      wallet,
      mint,
      ownerTokenAccount,
      fact,
      WRAPPER_TEST_BALANCE_WHOLE,
      "the wallet"
    );

    // The keeper delivers the vault's first wrapper (keeper/index.ts), so that
    // is the one it needs inventory of.
    if (i === 0) {
      if (keeper) {
        const keeperAccount = getAssociatedTokenAddressSync(
          mint,
          keeper,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        await send(
          connection,
          `keeper ${fact.label} account`,
          new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(
              owner,
              keeperAccount,
              keeper,
              mint,
              TOKEN_2022_PROGRAM_ID
            )
          ),
          [wallet],
          true
        );
        await topUp(
          connection,
          wallet,
          mint,
          keeperAccount,
          fact,
          KEEPER_INVENTORY_WHOLE,
          "the keeper"
        );
      } else {
        log(
          "keeper",
          "no KEEPER_PUBKEY and no .devnet-keys/keeper.json, inventory not stocked"
        );
      }
    }

    wrappers.push({
      label: fact.label,
      mint: mint.toBase58(),
      decimals: fact.decimals,
      wrapper: wrapperPda.toBase58(),
      vaultTokenAccount: vaultTokenAccount.toBase58(),
      ownerTokenAccount: ownerTokenAccount.toBase58(),
      liveMultiplier: liveMultipliers[i],
      mainnet: {
        mint: fact.mainnetMint,
        multiplier: fact.multiplier,
        newMultiplier: fact.newMultiplier,
        newMultiplierEffectiveTimestamp: fact.newMultiplierEffectiveTimestamp,
        liveMultiplier: liveMultipliers[i],
      },
    });
  }
  console.log();

  return {
    symbol: spec.symbol,
    displayName: spec.displayName,
    description: spec.description,
    address: vaultPda.toBase58(),
    receiptMint: receiptMintPda.toBase58(),
    receiptDecimals: 9,
    tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    authority: vaultAccount.authority.toBase58(),
    keeperFeeBps: vaultAccount.keeperFeeBps,
    keeperFeeMin: vaultAccount.keeperFeeMin.toString(),
    wrappers,
    priceFeed: { symbol: spec.priceFeed, id: feedId },
    ownerReceiptAccount: getAssociatedTokenAddressSync(
      receiptMintPda,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID
    ).toBase58(),
  };
}

async function main(): Promise<void> {
  const context = loadContext();
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  const idl = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "target/idl/paritas.json"), "utf8")
  );
  const program = new Program(idl, provider) as Program<anchor.Idl>;

  const wallet = (provider.wallet as anchor.Wallet).payer;
  const owner = wallet.publicKey;

  console.log(`Investire devnet setup`);
  console.log(`  rpc            ${connection.rpcEndpoint}`);
  console.log(`  wallet         ${owner.toBase58()}`);
  console.log(`  program        ${program.programId.toBase58()}`);
  console.log(`  devnet USDC    ${context.devnetUsdcMint.toBase58()}`);
  console.log();

  const balance = await withRetry("getBalance", () =>
    connection.getBalance(owner)
  );
  if (balance < 1_000_000_000) {
    throw new Error(
      `wallet has ${
        balance / 1e9
      } SOL, which is not enough to create the demo accounts. ` +
        "Run: solana airdrop 2 --url devnet"
    );
  }

  // --- payment mint -------------------------------------------------------
  // Real devnet USDC from CONTEXT.md, not a mock. It is classic SPL Token
  // while the wrappers are Token-2022, which is exactly the two token program
  // split the execution instructions are built around, so mocking it would
  // quietly remove the thing worth testing.
  console.log("Payment mint:");
  const usdcInfo = await withRetry("read devnet USDC mint", () =>
    connection.getAccountInfo(context.devnetUsdcMint)
  );
  if (!usdcInfo) {
    throw new Error(
      `devnet USDC ${context.devnetUsdcMint.toBase58()} does not exist on this cluster`
    );
  }
  if (!usdcInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(
      `devnet USDC is owned by ${usdcInfo.owner.toBase58()}, expected the classic SPL Token program`
    );
  }
  const usdc = unpackMint(context.devnetUsdcMint, usdcInfo, TOKEN_PROGRAM_ID);
  log("usdc", `${context.devnetUsdcMint.toBase58()} decimals ${usdc.decimals}`);
  console.log();

  const now = Math.floor(Date.now() / 1000);
  const keeper = keeperPublicKey();
  const vaults: VaultEntry[] = [];
  for (const spec of VAULT_SPECS) {
    vaults.push(
      await ensureVault({
        connection,
        program,
        wallet,
        spec,
        facts: spec.mints(context),
        usdcDecimals: usdc.decimals,
        keeper,
        now,
        priceFeeds: context.priceFeeds,
      })
    );
  }

  // --- the owner's own accounts -------------------------------------------
  console.log("Owner accounts:");
  const ownerPaymentAccount = getAssociatedTokenAddressSync(
    context.devnetUsdcMint,
    owner,
    false,
    TOKEN_PROGRAM_ID
  );
  await send(
    connection,
    "owner token accounts",
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ownerPaymentAccount,
        owner,
        context.devnetUsdcMint,
        TOKEN_PROGRAM_ID
      ),
      ...vaults.map((vault) =>
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          new PublicKey(vault.ownerReceiptAccount),
          owner,
          new PublicKey(vault.receiptMint),
          TOKEN_2022_PROGRAM_ID
        )
      )
    ),
    [wallet],
    true // createAssociatedTokenAccountIdempotent only, safe to replay
  );
  log("usdc account", ownerPaymentAccount.toBase58());
  for (const vault of vaults) {
    log("receipt acct", `${vault.symbol} ${vault.ownerReceiptAccount}`);
  }

  const usdcHeld = await tokenBalance(connection, ownerPaymentAccount);
  log("usdc balance", `${formatAmount(usdcHeld, usdc.decimals)} USDC`);
  console.log();

  // --- address book -------------------------------------------------------
  const previous = loadAddressBookIfPresent();
  const book: AddressBook = {
    cluster: "devnet",
    generatedAt: new Date().toISOString(),
    rpcUrl: connection.rpcEndpoint,
    programId: program.programId.toBase58(),
    tokenProgram2022: TOKEN_2022_PROGRAM_ID.toBase58(),
    tokenProgramClassic: TOKEN_PROGRAM_ID.toBase58(),
    payment: {
      label: "USDC",
      mint: context.devnetUsdcMint.toBase58(),
      decimals: usdc.decimals,
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    },
    // The single vault layout, mirroring vaults[0], for anything not yet
    // reading `vaults`. See AddressBook.vaults.
    vault: {
      symbol: vaults[0].symbol,
      displayName: vaults[0].displayName,
      address: vaults[0].address,
      receiptMint: vaults[0].receiptMint,
      receiptDecimals: vaults[0].receiptDecimals,
      tokenProgram: vaults[0].tokenProgram,
      authority: vaults[0].authority,
      keeperFeeBps: vaults[0].keeperFeeBps,
      keeperFeeMin: vaults[0].keeperFeeMin,
    },
    wrappers: vaults[0].wrappers,
    vaults,
    owner: {
      address: owner.toBase58(),
      paymentAccount: ownerPaymentAccount.toBase58(),
      receiptAccount: vaults[0].ownerReceiptAccount,
    },
    // Seed strings, so a client deriving a PDA does not have to keep its own
    // copy of them in sync with state.rs.
    seeds: {
      vault: "vault",
      receiptMint: "receipt",
      wrapper: "wrapper",
      schedule: "schedule",
      executionReceipt: "execution",
      executionEscrow: "escrow",
    },
  };
  saveAddressBook(book);

  console.log(`Wrote ${ADDRESS_BOOK_PATH}`);
  if (previous && previous.vault.address !== book.vault.address) {
    console.log("  note: the first vault's address changed since the last run");
  }
  if (usdcHeld === 0n) {
    console.log();
    console.log(
      "The wallet holds no devnet USDC, so no schedule can execute yet."
    );
    console.log(
      "  Get some from faucet.circle.com, then run scripts/run-lifecycle.ts"
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
