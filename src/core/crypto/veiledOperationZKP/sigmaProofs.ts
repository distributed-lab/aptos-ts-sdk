// Copyright © Aptos Foundation
// SPDX-License-Identifier: Apache-2.0

import { RistrettoPoint } from "@noble/curves/ed25519";
import { bytesToNumberLE, concatBytes, ensureBytes, numberToBytesLE } from "@noble/curves/abstract/utils";
import { sha512 } from "@noble/hashes/sha512";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import { H_RISTRETTO, TwistedEd25519PrivateKey, TwistedEd25519PublicKey } from "../twistedEd25519";
import { TwistedElGamal, TwistedElGamalCiphertext } from "../twistedElGamal";
import {
  deserializeSigmaProofVeiledKeyRotation,
  deserializeSigmaProofVeiledTransfer,
  deserializeSigmaProofVeiledWithdraw,
  serializeSigmaProofVeiledKeyRotation,
  serializeSigmaProofVeiledTransfer,
  serializeVeiledWithdrawSigmaProof,
} from "./sigmaProofsSerializers";
import { HexInput } from "../../../types";
import { modN, genModRandom, publicKeyToU8, toTwistedEd25519PrivateKey, invertN } from "./helpers";

export interface SigmaProofVeiledWithdrawOptions {
  privateKey: TwistedEd25519PrivateKey | HexInput;
  encryptedBalance: TwistedElGamalCiphertext;
  amount: bigint;
  changedBalance: bigint;
}

export interface VerifySigmaProofVeiledWithdrawOptions {
  publicKey: TwistedEd25519PublicKey | HexInput;
  encryptedBalance: TwistedElGamalCiphertext;
  amount: bigint;
  proof: Uint8Array;
}

export interface SigmaProofVeiledTransferOptions {
  senderPrivateKey: TwistedEd25519PrivateKey | HexInput;
  receiverPublicKey: TwistedEd25519PublicKey | HexInput;
  encryptedSenderBalance: TwistedElGamalCiphertext;
  amount: bigint;
  changedSenderBalance: bigint;
  random?: Uint8Array;
  auditorPublicKeys?: (TwistedEd25519PublicKey | HexInput)[];
}

export interface VerifySigmaProofVeiledTransferOptions {
  senderPublicKey: TwistedEd25519PublicKey | HexInput;
  receiverPublicKey: TwistedEd25519PublicKey | HexInput;
  encryptedSenderBalance: TwistedElGamalCiphertext;
  encryptedAmountBySender: TwistedElGamalCiphertext;
  receiverDa: string | Uint8Array;
  proof: Uint8Array;
  auditors?: {
    publicKeys: (TwistedEd25519PublicKey | HexInput)[];
    decryptionKeys: HexInput[];
  };
}

export interface SigmaProofVeiledKeyRotationOptions {
  oldPrivateKey: TwistedEd25519PrivateKey | HexInput;
  newPrivateKey: TwistedEd25519PrivateKey | HexInput;
  balance: bigint;
  encryptedBalance: TwistedElGamalCiphertext;
  random?: Uint8Array;
}

export interface VerifySigmaProofVeiledKeyRotationOptions {
  oldPublicKey: TwistedEd25519PublicKey;
  newPublicKey: TwistedEd25519PublicKey;
  oldEncryptedBalance: TwistedElGamalCiphertext;
  newEncryptedBalance: TwistedElGamalCiphertext;
  proof: Uint8Array;
}

/*
 * The domain separation tag (DST) used in the Fiat-Shamir transform of our Sigma-protocol.
 */
const FIAT_SHAMIR_SIGMA_DST = "AptosVeiledCoin/WithdrawalSubproofFiatShamir";

/*
 * Generate Fiat-Shamir challenge
 */
function genFiatShamirChallenge(...arrays: Uint8Array[]): bigint {
  const hash = sha512(concatBytes(...arrays));
  return modN(bytesToNumberLE(hash));
}

/**
 * Generates Sigma Zero Knowledge Proof for withdraw from the veiled balance
 *
 * @param opts.privateKey Twisted ElGamal Ed25519 private key.
 * @param opts.encryptedBalance Ciphertext points encrypted by Twisted ElGamal
 * @param opts.amount Amount of withdraw
 * @param opts.changedBalance Balance after withdraw
 */
export function genSigmaProofVeiledWithdraw(opts: SigmaProofVeiledWithdrawOptions): Uint8Array {
  const privateKey = toTwistedEd25519PrivateKey(opts.privateKey);

  const x1 = genModRandom();
  const x2 = genModRandom();
  const x3 = genModRandom();

  const X1 = RistrettoPoint.BASE.multiply(x1).add(opts.encryptedBalance.D.multiply(x2));
  const X2 = H_RISTRETTO.multiply(x3);

  const p = genFiatShamirChallenge(
    utf8ToBytes(FIAT_SHAMIR_SIGMA_DST),
    numberToBytesLE(opts.amount, 32),
    privateKey.publicKey().toUint8Array(),
    opts.encryptedBalance.C.toRawBytes(),
    opts.encryptedBalance.D.toRawBytes(),
    RistrettoPoint.BASE.toRawBytes(),
    H_RISTRETTO.toRawBytes(),
    X1.toRawBytes(),
    X2.toRawBytes(),
  );

  const sLE = bytesToNumberLE(privateKey.toUint8Array());
  const invertSLE = invertN(sLE);

  const pt = modN(p * opts.changedBalance);
  const ps = modN(p * sLE);
  const psInvert = modN(p * invertSLE);

  const alpha1 = modN(x1 - pt);
  const alpha2 = modN(x2 - ps);
  const alpha3 = modN(x3 - psInvert);

  return serializeVeiledWithdrawSigmaProof({
    alpha1: numberToBytesLE(alpha1, 32),
    alpha2: numberToBytesLE(alpha2, 32),
    alpha3: numberToBytesLE(alpha3, 32),
    X1: X1.toRawBytes(),
    X2: X2.toRawBytes(),
  });
}

/**
 * Generate Sigma Zero Knowledge Proof for transfer between veiled balances
 *
 * @param opts.senderPrivateKey Sender private key (Twisted ElGamal Ed25519).
 * @param opts.receiverPublicKey Receiver public key (Twisted ElGamal Ed25519).
 * @param opts.encryptedSenderBalance Ciphertext points encrypted by Twisted ElGamal
 * @param opts.amount Amount of transfer
 * @param opts.changedSenderBalance Balance after transfer
 * @param opts.random Random 32 bytes (Uint8Array)
 */
export function genSigmaProofVeiledTransfer(opts: SigmaProofVeiledTransferOptions): Uint8Array {
  const x1 = genModRandom();
  const x2 = genModRandom();
  const x3 = genModRandom();
  const x4 = genModRandom();
  const x5 = genModRandom();

  const rBytes = ensureBytes("Random bytes", opts.random ?? randomBytes(32), 32);
  const rAmount = modN(bytesToNumberLE(rBytes));

  const senderPrivateKey = toTwistedEd25519PrivateKey(opts.senderPrivateKey);
  const receiverPublicKeyU8 = publicKeyToU8(opts.receiverPublicKey);
  const senderPublicKey = senderPrivateKey.publicKey();
  const senderPKRistretto = RistrettoPoint.fromHex(senderPublicKey.toUint8Array());
  const receiverPKRistretto = RistrettoPoint.fromHex(receiverPublicKeyU8);
  const receiverDRistretto = receiverPKRistretto.multiply(rAmount);

  const amountCiphertext = TwistedElGamal.encryptWithPK(opts.amount, senderPublicKey, rBytes);

  const auditorsX =
    opts.auditorPublicKeys?.map((pk) => {
      const publicKeyU8 = publicKeyToU8(pk);
      return RistrettoPoint.fromHex(publicKeyU8).multiply(x3).toRawBytes();
    }) ?? [];

  const X1 = RistrettoPoint.BASE.multiply(x1).add(
    opts.encryptedSenderBalance.D.subtract(amountCiphertext.D).multiply(x2),
  );
  const X2 = senderPKRistretto.multiply(x3);
  const X3 = receiverPKRistretto.multiply(x3);
  const X4 = RistrettoPoint.BASE.multiply(x4).add(H_RISTRETTO.multiply(x3));
  const X5 = H_RISTRETTO.multiply(x5);

  const p = genFiatShamirChallenge(
    utf8ToBytes(FIAT_SHAMIR_SIGMA_DST),
    senderPublicKey.toUint8Array(),
    receiverPublicKeyU8,
    opts.encryptedSenderBalance.C.toRawBytes(),
    opts.encryptedSenderBalance.D.toRawBytes(),
    amountCiphertext.C.toRawBytes(),
    amountCiphertext.D.toRawBytes(),
    receiverDRistretto.toRawBytes(),
    RistrettoPoint.BASE.toRawBytes(),
    H_RISTRETTO.toRawBytes(),
    X1.toRawBytes(),
    X2.toRawBytes(),
    X3.toRawBytes(),
    X4.toRawBytes(),
    X5.toRawBytes(),
    ...auditorsX,
  );

  const sLE = bytesToNumberLE(senderPrivateKey.toUint8Array());
  const invertSLE = invertN(sLE);

  const alpha1 = modN(x1 - p * opts.changedSenderBalance);
  const alpha2 = modN(x2 - p * sLE);
  const alpha3 = modN(x3 - p * rAmount);
  const alpha4 = modN(x4 - p * opts.amount);
  const alpha5 = modN(x5 - p * invertSLE);

  return serializeSigmaProofVeiledTransfer({
    alpha1: numberToBytesLE(alpha1, 32),
    alpha2: numberToBytesLE(alpha2, 32),
    alpha3: numberToBytesLE(alpha3, 32),
    alpha4: numberToBytesLE(alpha4, 32),
    alpha5: numberToBytesLE(alpha5, 32),
    X1: X1.toRawBytes(),
    X2: X2.toRawBytes(),
    X3: X3.toRawBytes(),
    X4: X4.toRawBytes(),
    X5: X5.toRawBytes(),
    auditorsX,
  });
}

/**
 * Generate Sigma Zero Knowledge Proof for key rotation
 *
 * @param opts.oldPrivateKey Old private key (Twisted ElGamal Ed25519).
 * @param opts.newPrivateKey New private key (Twisted ElGamal Ed25519).
 * @param opts.balance Decrypted balance
 * @param opts.encryptedBalance Encrypted balance (Ciphertext points encrypted by Twisted ElGamal)
 * @param opts.random Random 32 bytes (Uint8Array)
 */
export function genSigmaProofVeiledKeyRotation(opts: SigmaProofVeiledKeyRotationOptions): Uint8Array {
  const x1 = genModRandom();
  const x2 = genModRandom();
  const x3 = genModRandom();
  const x4 = genModRandom();
  const x5 = genModRandom();

  const oldPrivateKey = toTwistedEd25519PrivateKey(opts.oldPrivateKey);
  const newPrivateKey = toTwistedEd25519PrivateKey(opts.newPrivateKey);
  const oldPublicKey = oldPrivateKey.publicKey();
  const newPublicKey = newPrivateKey.publicKey();

  const rBytes = ensureBytes("Random bytes", opts.random ?? randomBytes(32), 32);
  const r = modN(bytesToNumberLE(rBytes));

  const newCiphertext = TwistedElGamal.encryptWithPK(opts.balance, newPublicKey, rBytes);

  const X1 = opts.encryptedBalance.D.multiply(x1).subtract(newCiphertext.D.multiply(x2));
  const X2 = RistrettoPoint.BASE.multiply(x3).add(H_RISTRETTO.multiply(x4));
  const X3 = RistrettoPoint.fromHex(newPublicKey.toUint8Array()).multiply(x4);
  const X4 = H_RISTRETTO.multiply(x5);

  const p = genFiatShamirChallenge(
    utf8ToBytes(FIAT_SHAMIR_SIGMA_DST),
    oldPublicKey.toUint8Array(),
    newPublicKey.toUint8Array(),
    opts.encryptedBalance.C.toRawBytes(),
    opts.encryptedBalance.D.toRawBytes(),
    newCiphertext.C.toRawBytes(),
    newCiphertext.D.toRawBytes(),
    RistrettoPoint.BASE.toRawBytes(),
    H_RISTRETTO.toRawBytes(),
    X1.toRawBytes(),
    X2.toRawBytes(),
    X3.toRawBytes(),
    X4.toRawBytes(),
  );

  const oldSLE = bytesToNumberLE(oldPrivateKey.toUint8Array());
  const invertOldSLE = invertN(oldSLE);

  const alpha1 = modN(x1 - p * oldSLE);
  const alpha2 = modN(x2 - p * bytesToNumberLE(newPrivateKey.toUint8Array()));
  const alpha3 = modN(x3 - p * opts.balance);
  const alpha4 = modN(x4 - p * r);
  const alpha5 = modN(x5 - p * invertOldSLE);

  return serializeSigmaProofVeiledKeyRotation({
    alpha1: numberToBytesLE(alpha1, 32),
    alpha2: numberToBytesLE(alpha2, 32),
    alpha3: numberToBytesLE(alpha3, 32),
    alpha4: numberToBytesLE(alpha4, 32),
    alpha5: numberToBytesLE(alpha5, 32),
    X1: X1.toRawBytes(),
    X2: X2.toRawBytes(),
    X3: X3.toRawBytes(),
    X4: X4.toRawBytes(),
  });
}

/**
 * Verify Sigma Zero Knowledge Proof of withdraw from the veiled balance
 *
 * @param opts.publicKey Twisted ElGamal Ed25519 public key.
 * @param opts.encryptedBalance Encrypted balance (Ciphertext points encrypted by Twisted ElGamal)
 * @param opts.amount Amount of withdraw
 * @param opts.proof Sigma Zero Knowledge Proof for veiled withdraw
 */
export function verifySigmaProofVeiledWithdraw(opts: VerifySigmaProofVeiledWithdrawOptions): boolean {
  const proof = deserializeSigmaProofVeiledWithdraw(opts.proof);
  const publicKeyU8 = publicKeyToU8(opts.publicKey);

  const alpha1LE = bytesToNumberLE(proof.alpha1);
  const alpha2LE = bytesToNumberLE(proof.alpha2);
  const alpha3LE = bytesToNumberLE(proof.alpha3);

  const alpha1G = RistrettoPoint.BASE.multiply(alpha1LE);
  const alpha2D = opts.encryptedBalance.D.multiply(alpha2LE);
  const alpha3H = H_RISTRETTO.multiply(alpha3LE);

  const p = genFiatShamirChallenge(
    utf8ToBytes(FIAT_SHAMIR_SIGMA_DST),
    numberToBytesLE(opts.amount, 32),
    publicKeyU8,
    opts.encryptedBalance.C.toRawBytes(),
    opts.encryptedBalance.D.toRawBytes(),
    RistrettoPoint.BASE.toRawBytes(),
    H_RISTRETTO.toRawBytes(),
    proof.X1,
    proof.X2,
  );

  const pP = RistrettoPoint.fromHex(publicKeyU8).multiply(p);
  const X1 = alpha1G
    .add(alpha2D)
    .add(opts.encryptedBalance.C.subtract(RistrettoPoint.BASE.multiply(opts.amount)).multiply(p));
  const X2 = alpha3H.add(pP);

  return X1.equals(RistrettoPoint.fromHex(proof.X1)) && X2.equals(RistrettoPoint.fromHex(proof.X2));
}

/**
 * Verify Sigma Zero Knowledge Proof of veiled transfer
 *
 * @param opts.senderPublicKey Sender public key (Twisted ElGamal Ed25519).
 * @param opts.receiverPublicKey Receiver public key (Twisted ElGamal Ed25519).
 * @param opts.encryptedSenderBalance Encrypted sender balance (Ciphertext points encrypted by Twisted ElGamal)
 * @param opts.encryptedAmountBySender Amount of transfer encrypted by sender using Twisted ElGamal
 * @param opts.receiverDa The recipient's public key multiplied by the randomness used to encrypt the amount being sent
 * @param opts.proof Sigma Zero Knowledge Proof for veiled transfer
 * @param opts.auditors.auditorPKs The list of auditors's public keys (Twisted ElGamal Ed25519).
 * @param opts.auditors.auditorDecryptionKeys The list of corresponding auditors' decryption keys
 */
export function verifySigmaProofVeiledTransfer(opts: VerifySigmaProofVeiledTransferOptions): boolean {
  const proof = deserializeSigmaProofVeiledTransfer(opts.proof);
  const auditorsX = proof.auditorsX ?? [];
  const auditorPKs = opts.auditors?.publicKeys ?? [];
  const auditorDecryptionKeys = opts.auditors?.decryptionKeys ?? [];

  if (auditorsX.length !== auditorDecryptionKeys.length || auditorsX.length !== auditorPKs.length) {
    throw new Error("The number of auditors does not match the proof handed over.");
  }

  const receiverDRistretto = RistrettoPoint.fromHex(opts.receiverDa);

  const alpha1LE = bytesToNumberLE(proof.alpha1);
  const alpha2LE = bytesToNumberLE(proof.alpha2);
  const alpha3LE = bytesToNumberLE(proof.alpha3);
  const alpha4LE = bytesToNumberLE(proof.alpha4);
  const alpha5LE = bytesToNumberLE(proof.alpha5);

  const senderPublicKeyU8 = publicKeyToU8(opts.senderPublicKey);
  const receiverPublicKeyU8 = publicKeyToU8(opts.receiverPublicKey);
  const senderPKRistretto = RistrettoPoint.fromHex(senderPublicKeyU8);
  const receiverPKRistretto = RistrettoPoint.fromHex(receiverPublicKeyU8);

  const p = genFiatShamirChallenge(
    utf8ToBytes(FIAT_SHAMIR_SIGMA_DST),
    senderPublicKeyU8,
    receiverPublicKeyU8,
    opts.encryptedSenderBalance.C.toRawBytes(),
    opts.encryptedSenderBalance.D.toRawBytes(),
    opts.encryptedAmountBySender.C.toRawBytes(),
    opts.encryptedAmountBySender.D.toRawBytes(),
    receiverDRistretto.toRawBytes(),
    RistrettoPoint.BASE.toRawBytes(),
    H_RISTRETTO.toRawBytes(),
    proof.X1,
    proof.X2,
    proof.X3,
    proof.X4,
    proof.X5,
    ...auditorsX,
  );

  const alpha1G = RistrettoPoint.BASE.multiply(alpha1LE);
  const alpha2Db = opts.encryptedSenderBalance.D.subtract(opts.encryptedAmountBySender.D).multiply(alpha2LE);
  const pCb = opts.encryptedSenderBalance.C.subtract(opts.encryptedAmountBySender.C).multiply(p);

  const X1 = alpha1G.add(alpha2Db).add(pCb);
  const X2 = senderPKRistretto.multiply(alpha3LE).add(opts.encryptedAmountBySender.D.multiply(p));
  const X3 = receiverPKRistretto.multiply(alpha3LE).add(receiverDRistretto.multiply(p));
  const X4 = RistrettoPoint.BASE.multiply(alpha4LE)
    .add(H_RISTRETTO.multiply(alpha3LE))
    .add(opts.encryptedAmountBySender.C.multiply(p));
  const X5 = H_RISTRETTO.multiply(alpha5LE).add(senderPKRistretto.multiply(p));

  const isAuditorsXValid = auditorsX.every((auditorX, index) => {
    const publicKeyU8 = publicKeyToU8(auditorPKs[index]);
    const pDr = RistrettoPoint.fromHex(auditorDecryptionKeys[index]).multiply(p);
    const alpha3R = RistrettoPoint.fromHex(publicKeyU8).multiply(alpha3LE);
    const X = alpha3R.add(pDr);

    return X.equals(RistrettoPoint.fromHex(auditorX));
  });

  return (
    isAuditorsXValid &&
    X1.equals(RistrettoPoint.fromHex(proof.X1)) &&
    X2.equals(RistrettoPoint.fromHex(proof.X2)) &&
    X3.equals(RistrettoPoint.fromHex(proof.X3)) &&
    X4.equals(RistrettoPoint.fromHex(proof.X4)) &&
    X5.equals(RistrettoPoint.fromHex(proof.X5))
  );
}

/**
 * Verify Sigma Zero Knowledge Proof of key rotation
 *
 * @param opts.oldPrivateKey Old public key (Twisted ElGamal Ed25519).
 * @param opts.newPrivateKey New public key (Twisted ElGamal Ed25519).
 * @param opts.oldEncryptedBalance Balance encrypted with previous public key (Ciphertext points encrypted by Twisted ElGamal)
 * @param opts.newEncryptedBalance Balance encrypted with new public key (Ciphertext points encrypted by Twisted ElGamal)
 * @param opts.proof Sigma Zero Knowledge Proof for veiled balance key rotation
 */
export function verifySigmaProofVeiledKeyRotation(opts: VerifySigmaProofVeiledKeyRotationOptions): boolean {
  const proof = deserializeSigmaProofVeiledKeyRotation(opts.proof);

  const alpha1LE = bytesToNumberLE(proof.alpha1);
  const alpha2LE = bytesToNumberLE(proof.alpha2);
  const alpha3LE = bytesToNumberLE(proof.alpha3);
  const alpha4LE = bytesToNumberLE(proof.alpha4);
  const alpha5LE = bytesToNumberLE(proof.alpha5);

  const p = genFiatShamirChallenge(
    utf8ToBytes(FIAT_SHAMIR_SIGMA_DST),
    opts.oldPublicKey.toUint8Array(),
    opts.newPublicKey.toUint8Array(),
    opts.oldEncryptedBalance.C.toRawBytes(),
    opts.oldEncryptedBalance.D.toRawBytes(),
    opts.newEncryptedBalance.C.toRawBytes(),
    opts.newEncryptedBalance.D.toRawBytes(),
    RistrettoPoint.BASE.toRawBytes(),
    H_RISTRETTO.toRawBytes(),
    proof.X1,
    proof.X2,
    proof.X3,
    proof.X4,
  );

  const alpha1DOld = opts.oldEncryptedBalance.D.multiply(alpha1LE);
  const alpha2DNew = opts.newEncryptedBalance.D.multiply(alpha2LE);
  const alpha3G = RistrettoPoint.BASE.multiply(alpha3LE);
  const alpha4H = H_RISTRETTO.multiply(alpha4LE);
  const pCNew = opts.newEncryptedBalance.C.multiply(p);
  const pkOldRist = RistrettoPoint.fromHex(opts.oldPublicKey.toUint8Array());
  const pkNewRist = RistrettoPoint.fromHex(opts.newPublicKey.toUint8Array());

  const X1 = alpha1DOld
    .subtract(alpha2DNew)
    .add(opts.oldEncryptedBalance.C.subtract(opts.newEncryptedBalance.C).multiply(p));
  const X2 = alpha3G.add(alpha4H).add(pCNew);
  const X3 = pkNewRist.multiply(alpha4LE).add(opts.newEncryptedBalance.D.multiply(p));
  const X4 = H_RISTRETTO.multiply(alpha5LE).add(pkOldRist.multiply(p));

  return (
    X1.equals(RistrettoPoint.fromHex(proof.X1)) &&
    X2.equals(RistrettoPoint.fromHex(proof.X2)) &&
    X3.equals(RistrettoPoint.fromHex(proof.X3)) &&
    X4.equals(RistrettoPoint.fromHex(proof.X4))
  );
}