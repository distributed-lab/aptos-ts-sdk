import { bytesToNumberLE, concatBytes, numberToBytesLE } from "@noble/curves/abstract/utils";
import { RistrettoPoint } from "@noble/curves/ed25519";
import { utf8ToBytes } from "@noble/hashes/utils";
import { H_RISTRETTO, TwistedEd25519PrivateKey, TwistedEd25519PublicKey } from "../twistedEd25519";
import { TwistedElGamal, TwistedElGamalCiphertext } from "../twistedElGamal";
import { ed25519GenListOfRandom, ed25519GenRandom, ed25519InvertN, ed25519modN } from "../utils";
import { CHUNK_BITS_BI, PROOF_CHUNK_SIZE, SIGMA_PROOF_TRANSFER_SIZE, VEILED_BALANCE_CHUNK_SIZE } from "./consts";
import { amountToChunks, chunksToAmount, genFiatShamirChallenge, publicKeyToU8 } from "./helpers";
import { Hex } from "../../hex";
import { HexInput } from "../../../types";
import { generateRangeZKP, verifyRangeZKP } from "./rangeProof";

export type VeiledTransferSigmaProof = {
  alpha1: Uint8Array;
  alpha2: Uint8Array;
  alpha3List: Uint8Array[];
  alpha4List: Uint8Array[];
  alpha5: Uint8Array;
  alpha6List: Uint8Array[];
  X1: Uint8Array;
  X2List: Uint8Array[];
  X3List: Uint8Array[];
  X4List: Uint8Array[];
  X5: Uint8Array;
  X6List: Uint8Array[];
  X7List?: Uint8Array[];
};

export class VeiledTransfer {
  isInitialized = false;

  twistedEd25519PrivateKey: TwistedEd25519PrivateKey;

  recipientPublicKey: TwistedEd25519PublicKey;

  recipientPublicKeyU8: Uint8Array;

  auditorPublicKeys: TwistedEd25519PublicKey[];

  auditorsU8PublicKeys: Uint8Array[];

  auditorsDList: Uint8Array[][];

  encryptedActualBalance: TwistedElGamalCiphertext[];

  chunkedAmountToTransfer: bigint[];

  chunkedBalanceAfterTransfer: bigint[];

  amountToTransfer: bigint;

  balanceAfterTransfer?: bigint;

  encryptedActualBalanceAfterTransfer?: TwistedElGamalCiphertext[];

  encryptedAmountByRecipient: TwistedElGamalCiphertext[];

  randomness: bigint[];

  constructor(
    twistedEd25519PrivateKey: TwistedEd25519PrivateKey,
    encryptedActualBalance: TwistedElGamalCiphertext[],
    amountToTransfer: bigint,
    recipientPublicKey: TwistedEd25519PublicKey,
    auditorPublicKeys: TwistedEd25519PublicKey[],
    randomness?: bigint[],
  ) {
    this.twistedEd25519PrivateKey = twistedEd25519PrivateKey;
    this.encryptedActualBalance = encryptedActualBalance;
    this.amountToTransfer = amountToTransfer;
    this.recipientPublicKey = recipientPublicKey;
    this.recipientPublicKeyU8 = publicKeyToU8(this.recipientPublicKey);
    this.auditorPublicKeys = auditorPublicKeys;
    this.auditorsU8PublicKeys = auditorPublicKeys?.map((pk) => publicKeyToU8(pk)) ?? [];
    this.auditorsDList = this.auditorsU8PublicKeys.map((pk) => {
      const pkRist = RistrettoPoint.fromHex(pk);
      return this.randomness.map((r) => pkRist.multiply(r).toRawBytes());
    });
    this.chunkedAmountToTransfer = amountToChunks(this.amountToTransfer, VEILED_BALANCE_CHUNK_SIZE);
    this.chunkedBalanceAfterTransfer = amountToChunks(this.balanceAfterTransfer!, VEILED_BALANCE_CHUNK_SIZE);
    this.encryptedAmountByRecipient = this.chunkedAmountToTransfer.map((chunk, i) =>
      TwistedElGamal.encryptWithPK(chunk, new TwistedEd25519PublicKey(this.recipientPublicKeyU8), this.randomness[i]),
    );

    this.randomness = randomness ?? ed25519GenListOfRandom();
  }

  static FIAT_SHAMIR_SIGMA_DST = "AptosVeiledCoin/TransferSubproofFiatShamir";

  static serializeSigmaProof(sigmaProof: VeiledTransferSigmaProof): Uint8Array {
    return concatBytes(
      sigmaProof.alpha1,
      sigmaProof.alpha2,
      ...sigmaProof.alpha3List,
      ...sigmaProof.alpha4List,
      sigmaProof.alpha5,
      ...sigmaProof.alpha6List,
      sigmaProof.X1,
      ...sigmaProof.X2List,
      ...sigmaProof.X3List,
      ...sigmaProof.X4List,
      sigmaProof.X5,
      ...sigmaProof.X6List,
      ...(sigmaProof.X7List ?? []),
    );
  }

  static deserializeSigmaProof(sigmaProof: Uint8Array): VeiledTransferSigmaProof {
    if (sigmaProof.length % PROOF_CHUNK_SIZE !== 0) {
      throw new Error(`Invalid sigma proof length: the length must be a multiple of ${PROOF_CHUNK_SIZE}`);
    }

    if (sigmaProof.length < SIGMA_PROOF_TRANSFER_SIZE) {
      throw new Error(
        `Invalid sigma proof length of veiled transfer: got ${sigmaProof.length}, expected minimum ${SIGMA_PROOF_TRANSFER_SIZE}`,
      );
    }

    const baseProof = sigmaProof.slice(0, SIGMA_PROOF_TRANSFER_SIZE);

    const X7List: Uint8Array[] = [];
    const baseProofArray: Uint8Array[] = [];

    for (let i = 0; i < SIGMA_PROOF_TRANSFER_SIZE; i += PROOF_CHUNK_SIZE) {
      baseProofArray.push(baseProof.subarray(i, i + PROOF_CHUNK_SIZE));
    }

    if (sigmaProof.length > SIGMA_PROOF_TRANSFER_SIZE) {
      const auditorsPartLength = sigmaProof.length - SIGMA_PROOF_TRANSFER_SIZE;
      const auditorsPart = sigmaProof.slice(SIGMA_PROOF_TRANSFER_SIZE);

      for (let i = 0; i < auditorsPartLength; i += PROOF_CHUNK_SIZE) {
        X7List.push(auditorsPart.subarray(i, i + PROOF_CHUNK_SIZE));
      }
    }

    const alpha1 = baseProofArray[0];
    const alpha2 = baseProofArray[1];
    const alpha3List = baseProofArray.slice(2, 2 + VEILED_BALANCE_CHUNK_SIZE);
    const alpha4List = baseProofArray.slice(6, 6 + VEILED_BALANCE_CHUNK_SIZE);
    const alpha5 = baseProofArray[10];
    const alpha6List = baseProofArray.slice(11, 11 + VEILED_BALANCE_CHUNK_SIZE);
    const X1 = baseProofArray[15];
    const X2List = baseProofArray.slice(16, 16 + VEILED_BALANCE_CHUNK_SIZE);
    const X3List = baseProofArray.slice(20, 20 + VEILED_BALANCE_CHUNK_SIZE);
    const X4List = baseProofArray.slice(24, 24 + VEILED_BALANCE_CHUNK_SIZE);
    const X5 = baseProofArray[28];
    const X6List = baseProofArray.slice(29);

    return {
      alpha1,
      alpha2,
      alpha3List,
      alpha4List,
      alpha5,
      alpha6List,
      X1,
      X2List,
      X3List,
      X4List,
      X5,
      X6List,
      X7List,
    };
  }

  async init() {
    if (!this.isInitialized) throw new TypeError("VeiledWithdraw is not initialized");

    const decryptedBalanceChunks = await Promise.all(
      this.encryptedActualBalance.map((el) =>
        TwistedElGamal.decryptWithPK(el, this.twistedEd25519PrivateKey, {
          // FIXME: mocked, should be removed, once algo is ready
          start: 0n,
          end: 1000n,
        }),
      ),
    );

    const decryptedBalance = chunksToAmount(decryptedBalanceChunks);

    this.balanceAfterTransfer = decryptedBalance - this.amountToTransfer;

    const chunkedBalanceAfterWithdraw = amountToChunks(this.balanceAfterTransfer, VEILED_BALANCE_CHUNK_SIZE);
    this.encryptedActualBalanceAfterTransfer = chunkedBalanceAfterWithdraw.map((chunk, i) =>
      TwistedElGamal.encryptWithPK(chunk, this.twistedEd25519PrivateKey.publicKey(), this.randomness[i]),
    );

    this.isInitialized = true;
  }

  async genSigmaProof(): Promise<VeiledTransferSigmaProof> {
    if (!this.isInitialized) throw new TypeError("VeiledWithdraw is not initialized");

    if (this.randomness && this.randomness.length !== VEILED_BALANCE_CHUNK_SIZE)
      throw new TypeError("Invalid length list of randomness");

    if (this.amountToTransfer > 2n ** (2n * CHUNK_BITS_BI) - 1n)
      throw new TypeError(`Amount must be less than 2n**${CHUNK_BITS_BI * 2n}`);

    if (!this.balanceAfterTransfer) throw new TypeError("Balance after transfer is not defined");

    const x1 = ed25519GenRandom();
    const x2 = ed25519GenRandom();
    const x3List = ed25519GenListOfRandom();
    const x4List = ed25519GenListOfRandom();
    const x5 = ed25519GenRandom();
    const x6List = ed25519GenListOfRandom();

    const senderPKRistretto = RistrettoPoint.fromHex(this.twistedEd25519PrivateKey.toUint8Array());
    const recipientPKRistretto = RistrettoPoint.fromHex(this.recipientPublicKeyU8);

    const newEncryptedBalance = this.chunkedBalanceAfterTransfer.map((chunk, i) =>
      TwistedElGamal.encryptWithPK(chunk, this.twistedEd25519PrivateKey.publicKey(), this.randomness[i]),
    );

    const DBal = this.encryptedActualBalance.reduce(
      (acc, { D }, i) => acc.add(D.multiply(2n ** (BigInt(i) * CHUNK_BITS_BI))),
      RistrettoPoint.ZERO,
    );
    const DNewBal = newEncryptedBalance.reduce(
      (acc, { D }, i) => acc.add(D.multiply(2n ** (BigInt(i) * CHUNK_BITS_BI))),
      RistrettoPoint.ZERO,
    );

    const X1 = RistrettoPoint.BASE.multiply(x1).add(DBal.multiply(x2)).subtract(DNewBal.multiply(x2)).toRawBytes();
    const X2List = x3List.map((x3) => senderPKRistretto.multiply(x3).toRawBytes());
    const X3List = x3List.map((x3) => recipientPKRistretto.multiply(x3).toRawBytes());
    const X4List = x4List.map((x4, i) =>
      RistrettoPoint.BASE.multiply(x4).add(H_RISTRETTO.multiply(x3List[i])).toRawBytes(),
    );
    const X5 = H_RISTRETTO.multiply(x5).toRawBytes();
    const X6List = x6List.map((x6, i) =>
      RistrettoPoint.BASE.multiply(x6).add(H_RISTRETTO.multiply(x3List[i])).toRawBytes(),
    );
    const X7List = this.auditorsU8PublicKeys.map((pk) =>
      x3List.map((x3) => RistrettoPoint.fromHex(pk).multiply(x3).toRawBytes()),
    );

    const p = genFiatShamirChallenge(
      utf8ToBytes(VeiledTransfer.FIAT_SHAMIR_SIGMA_DST),
      RistrettoPoint.BASE.toRawBytes(),
      H_RISTRETTO.toRawBytes(),
      this.twistedEd25519PrivateKey.publicKey().toUint8Array(),
      this.recipientPublicKeyU8,
      ...this.encryptedActualBalance.map(({ C, D }) => [C.toRawBytes(), D.toRawBytes()]).flat(),
      ...newEncryptedBalance.map(({ C, D }) => [C.toRawBytes(), D.toRawBytes()]).flat(),
      ...this.encryptedAmountByRecipient.map(({ C, D }) => [C.toRawBytes(), D.toRawBytes()]).flat(),
      ...this.auditorsDList.flat(),
      X1,
      ...X2List,
      ...X3List,
      ...X4List,
      X5,
      ...X6List,
      ...X7List.flat(),
    );

    const sLE = bytesToNumberLE(this.twistedEd25519PrivateKey.toUint8Array());
    const invertSLE = ed25519InvertN(sLE);

    const alpha1 = ed25519modN(x1 - p * this.balanceAfterTransfer);
    const alpha2 = ed25519modN(x2 - p * sLE);
    const alpha3List = x3List.map((x3, i) => ed25519modN(x3 - p * this.randomness[i]));
    const alpha4List = x4List.map((x4, i) => ed25519modN(x4 - p * this.chunkedAmountToTransfer[i]));
    const alpha5 = ed25519modN(x5 - p * invertSLE);
    const alpha6List = x6List.map((x6, i) => ed25519modN(x6 - p * this.chunkedBalanceAfterTransfer[i]), 32);

    return {
      alpha1: numberToBytesLE(alpha1, 32),
      alpha2: numberToBytesLE(alpha2, 32),
      alpha3List: alpha3List.map((a) => numberToBytesLE(a, 32)),
      alpha4List: alpha4List.map((a) => numberToBytesLE(a, 32)),
      alpha5: numberToBytesLE(alpha5, 32),
      alpha6List: alpha6List.map((a) => numberToBytesLE(a, 32)),
      X1,
      X2List,
      X3List,
      X4List,
      X5,
      X6List,
      X7List: X7List.flat(),
    };
  }

  verifySigmaProof(
    sigmaProof: VeiledTransferSigmaProof,
    opts?: {
      auditors?: {
        publicKeys: (TwistedEd25519PublicKey | HexInput)[];
        decryptionKeys: HexInput[][];
      };
    },
  ): boolean {
    if (!this.encryptedActualBalanceAfterTransfer)
      throw new TypeError("this.encryptedActualBalanceAfterTransfer is not defined");

    const auditorPKs = opts?.auditors?.publicKeys.map((pk) => publicKeyToU8(pk)) ?? [];
    const auditorDecryptionKeys =
      opts?.auditors?.decryptionKeys.map((arr) => arr.map((key) => Hex.fromHexInput(key).toUint8Array())) ?? [];
    const proofX7List = sigmaProof.X7List ?? [];

    const alpha1LE = bytesToNumberLE(sigmaProof.alpha1);
    const alpha2LE = bytesToNumberLE(sigmaProof.alpha2);
    const alpha3LEList = sigmaProof.alpha3List.map((a) => bytesToNumberLE(a));
    const alpha4LEList = sigmaProof.alpha4List.map((a) => bytesToNumberLE(a));
    const alpha5LE = bytesToNumberLE(sigmaProof.alpha5);
    const alpha6LEList = sigmaProof.alpha6List.map((a) => bytesToNumberLE(a));

    const senderPublicKeyU8 = publicKeyToU8(this.twistedEd25519PrivateKey.publicKey());
    const recipientPublicKeyU8 = publicKeyToU8(this.recipientPublicKey);
    const senderPKRistretto = RistrettoPoint.fromHex(senderPublicKeyU8);
    const recipientPKRistretto = RistrettoPoint.fromHex(recipientPublicKeyU8);

    const p = genFiatShamirChallenge(
      utf8ToBytes(VeiledTransfer.FIAT_SHAMIR_SIGMA_DST),
      RistrettoPoint.BASE.toRawBytes(),
      H_RISTRETTO.toRawBytes(),
      senderPublicKeyU8,
      recipientPublicKeyU8,
      ...this.encryptedActualBalance.map(({ C, D }) => [C.toRawBytes(), D.toRawBytes()]).flat(),
      ...this.encryptedActualBalanceAfterTransfer.map(({ C, D }) => [C.toRawBytes(), D.toRawBytes()]).flat(),
      ...this.encryptedAmountByRecipient.map(({ C, D }) => [C.toRawBytes(), D.toRawBytes()]).flat(),
      ...auditorDecryptionKeys.flat(),
      sigmaProof.X1,
      ...sigmaProof.X2List,
      ...sigmaProof.X3List,
      ...sigmaProof.X4List,
      sigmaProof.X5,
      ...sigmaProof.X6List,
      ...proofX7List,
    );

    const alpha1G = RistrettoPoint.BASE.multiply(alpha1LE);

    const { oldDSum, oldCSum } = this.encryptedActualBalance.reduce(
      (acc, { C, D }, i) => {
        const coef = 2n ** (BigInt(i) * CHUNK_BITS_BI);
        return {
          oldDSum: acc.oldDSum.add(D.multiply(coef)),
          oldCSum: acc.oldCSum.add(C.multiply(coef)),
        };
      },
      { oldDSum: RistrettoPoint.ZERO, oldCSum: RistrettoPoint.ZERO },
    );

    const newDSum = this.encryptedActualBalanceAfterTransfer.reduce((acc, { D }, i) => {
      const coef = 2n ** (BigInt(i) * CHUNK_BITS_BI);
      return acc.add(D.multiply(coef));
    }, RistrettoPoint.ZERO);

    const amountCSum = this.encryptedAmountByRecipient.reduce((acc, { C }, i) => {
      const coef = 2n ** (BigInt(i) * CHUNK_BITS_BI);
      return acc.add(C.multiply(coef));
    }, RistrettoPoint.ZERO);

    const X1 = alpha1G
      .add(oldDSum.multiply(alpha2LE))
      .subtract(newDSum.multiply(alpha2LE))
      .add(oldCSum.multiply(p))
      .subtract(amountCSum.multiply(p));
    const X2List = alpha3LEList.map((a3, i) =>
      senderPKRistretto.multiply(a3).add(this.encryptedActualBalanceAfterTransfer![i].D.multiply(p)),
    );
    const X3List = alpha3LEList.map((a3, i) =>
      recipientPKRistretto.multiply(a3).add(this.encryptedAmountByRecipient[i].D.multiply(p)),
    );
    const X4List = alpha4LEList.map((a4, i) => {
      const a4G = RistrettoPoint.BASE.multiply(a4);
      const a3H = H_RISTRETTO.multiply(alpha3LEList[i]);
      const pC = this.encryptedAmountByRecipient[i].C.multiply(p);
      return a4G.add(a3H).add(pC);
    });
    const X5 = H_RISTRETTO.multiply(alpha5LE).add(senderPKRistretto.multiply(p));
    const X6List = alpha6LEList.map((a6, i) => {
      const aG = RistrettoPoint.BASE.multiply(a6);
      const aH = H_RISTRETTO.multiply(alpha3LEList[i]);
      const pC = this.encryptedActualBalanceAfterTransfer![i].C.multiply(p);
      return aG.add(aH).add(pC);
    });
    const X7List = auditorPKs.map((pk, pkI) =>
      alpha3LEList.map((a3, i) =>
        RistrettoPoint.fromHex(pk).multiply(a3).add(RistrettoPoint.fromHex(auditorDecryptionKeys[pkI][i]).multiply(p)),
      ),
    );

    return (
      X1.equals(RistrettoPoint.fromHex(sigmaProof.X1)) &&
      X2List.every((X2, i) => X2.equals(RistrettoPoint.fromHex(sigmaProof.X2List[i]))) &&
      X3List.every((X3, i) => X3.equals(RistrettoPoint.fromHex(sigmaProof.X3List[i]))) &&
      X4List.every((X4, i) => X4.equals(RistrettoPoint.fromHex(sigmaProof.X4List[i]))) &&
      X5.equals(RistrettoPoint.fromHex(sigmaProof.X5)) &&
      X6List.every((X6, i) => X6.equals(RistrettoPoint.fromHex(sigmaProof.X6List[i]))) &&
      X7List.flat().every((X7, i) => X7.equals(RistrettoPoint.fromHex(proofX7List[i])))
    );
  }

  async genRangeProof() {
    if (!this.isInitialized) throw new TypeError("VeiledWithdraw is not initialized");

    if (!this.encryptedActualBalanceAfterTransfer)
      throw new TypeError("this.encryptedActualBalanceAfterTransfer is not defined");

    if (!this.balanceAfterTransfer) throw new TypeError("Balance after transfer is not defined");

    const rangeProofAmountPromise = Promise.all(
      amountToChunks(this.amountToTransfer, VEILED_BALANCE_CHUNK_SIZE).map((chunk, i) =>
        generateRangeZKP({
          v: chunk,
          r: numberToBytesLE(this.randomness[i], 32),
          valBase: RistrettoPoint.BASE.toRawBytes(),
          randBase: H_RISTRETTO.toRawBytes(),
        }),
      ),
    );

    const rangeProofNewBalancePromise = Promise.all(
      amountToChunks(this.balanceAfterTransfer, VEILED_BALANCE_CHUNK_SIZE).map((chunk, i) =>
        generateRangeZKP({
          v: chunk,
          r: this.twistedEd25519PrivateKey.toUint8Array(),
          valBase: RistrettoPoint.BASE.toRawBytes(),
          randBase: this.encryptedActualBalanceAfterTransfer![i].D.toRawBytes(),
        }),
      ),
    );

    const [rangeProofAmount, rangeProofNewBalance] = await Promise.all([
      rangeProofAmountPromise,
      rangeProofNewBalancePromise,
    ]);

    return {
      rangeProofAmount: rangeProofAmount.map((proof) => proof.proof),
      rangeProofNewBalance: rangeProofNewBalance.map((proof) => proof.proof),
    };
  }

  async verifyRangeProof(opts: { rangeProofAmount: Uint8Array[]; rangeProofNewBalance: Uint8Array[] }) {
    if (!this.isInitialized) throw new TypeError("VeiledWithdraw is not initialized");

    if (!this.encryptedActualBalanceAfterTransfer)
      throw new TypeError("this.encryptedActualBalanceAfterTransfer is not defined");

    const rangeProofsValidations = await Promise.all([
      ...opts.rangeProofAmount.map((proof, i) =>
        verifyRangeZKP({
          proof,
          commitment: this.encryptedAmountByRecipient[i].C.toRawBytes(),
          valBase: RistrettoPoint.BASE.toRawBytes(),
          randBase: H_RISTRETTO.toRawBytes(),
        }),
      ),
      ...opts.rangeProofNewBalance.map((proof, i) =>
        verifyRangeZKP({
          proof,
          commitment: this.encryptedActualBalanceAfterTransfer![i].C.toRawBytes(),
          valBase: RistrettoPoint.BASE.toRawBytes(),
          randBase: this.encryptedActualBalanceAfterTransfer![i].D.toRawBytes(),
        }),
      ),
    ]);

    return rangeProofsValidations.every((isValid) => isValid);
  }
}