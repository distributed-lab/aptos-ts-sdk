// Copyright © Aptos Foundation
// SPDX-License-Identifier: Apache-2.0

import { ed25519, RistrettoPoint } from "@noble/curves/ed25519";
import { mod } from "@noble/curves/abstract/modular";
import { bytesToNumberLE, ensureBytes } from "@noble/curves/abstract/utils";
import { randomBytes } from "@noble/hashes/utils";
import { HexInput } from "../../types";
import { H_RISTRETTO, RistPoint, TwistedEd25519PrivateKey, TwistedEd25519PublicKey } from "./twistedEd25519";

export interface DecryptionRange {
  start?: bigint;
  end?: bigint;
}

export type ModifyCiphertextOperation = "add" | "subtract";

/**
 * Twisted ElGamal encryption/decryption
 * @see {@link https://drive.google.com/file/d/1wGo-pIOPOcCQA0gjngE5kmWUQ-TxktAF/view | Veiled coins with twisted ElGamal}
 */
export class TwistedElGamal {
  /**
   * The private key of an Twisted ElGamal Ed25519 key pair.
   */
  private readonly privateKey: TwistedEd25519PrivateKey;

  /**
   * Create a new TwistedElGamal instance from private key.
   *
   * @param privateKey TwistedEd25519PrivateKey or HexInput (string or Uint8Array)
   */
  constructor(privateKey: TwistedEd25519PrivateKey | HexInput) {
    this.privateKey =
      privateKey instanceof TwistedEd25519PrivateKey ? privateKey : new TwistedEd25519PrivateKey(privateKey);
  }

  /**
   * Encrypts the amount with Twisted ElGamal
   *
   * @param amount amount for encryption
   * @param random random 32 bytes
   */
  public encrypt(amount: bigint, random?: Uint8Array): TwistedElGamalCiphertext {
    return TwistedElGamal.encryptWithPK(amount, this.privateKey.publicKey(), random);
  }

  /**
   * Decrypts the amount with Twisted ElGamal
   *
   * @param ciphertext сiphertext points encrypted by Twisted ElGamal
   * @param decryptionRange The range of amounts to be used in decryption
   */
  public decrypt(ciphertext: TwistedElGamalCiphertext, decryptionRange?: DecryptionRange): bigint {
    return TwistedElGamal.decryptWithPK(ciphertext, this.privateKey, decryptionRange);
  }

  /**
   * Encrypts the amount with Twisted ElGamal
   *
   * @param amount amount for encryption
   * @param publicKey Twisted ElGamal Ed25519 public key.
   * @param random random 32 bytes
   */
  static encryptWithPK(amount: bigint, publicKey: TwistedEd25519PublicKey, random?: Uint8Array) {
    if (amount < 0n && amount >= ed25519.CURVE.n)
      throw new Error(`The amount must be in the range 0 to ${ed25519.CURVE.n}`);

    const rBytes = ensureBytes("Random bytes", random ?? randomBytes(32), 32);

    const m = amount;
    const r = mod(bytesToNumberLE(rBytes), ed25519.CURVE.n);
    const rH = H_RISTRETTO.multiply(r);
    const mG = m === BigInt(0) ? RistrettoPoint.ZERO : RistrettoPoint.BASE.multiply(m);

    const D = RistrettoPoint.fromHex(publicKey.toUint8Array()).multiply(r);
    const C = mG.add(rH);

    return new TwistedElGamalCiphertext(C.toRawBytes(), D.toRawBytes());
  }

  /**
   * Decrypts the amount with Twisted ElGamal
   * @param ciphertext сiphertext points encrypted by Twisted ElGamal
   * @param privateKey Twisted ElGamal Ed25519 private key.
   * @param decryptionRange The range of amounts to be used in decryption
   */
  static decryptWithPK(
    ciphertext: TwistedElGamalCiphertext,
    privateKey: TwistedEd25519PrivateKey,
    decryptionRange?: DecryptionRange,
  ): bigint {
    const { C, D } = ciphertext;
    const modS = mod(bytesToNumberLE(privateKey.toUint8Array()), ed25519.CURVE.n);
    const sD = RistrettoPoint.fromHex(D.toRawBytes()).multiply(modS);
    const mH = RistrettoPoint.fromHex(C.toRawBytes()).subtract(sD);

    // TODO: Replace brute-force search with another algorithm for optimization
    let amount = decryptionRange?.start ?? BigInt(0);
    if (amount === BigInt(0)) {
      if (mH.equals(RistrettoPoint.ZERO)) return BigInt(0);

      amount += BigInt(1);
    }

    let searchablePoint = RistrettoPoint.BASE.multiply(amount);
    const endAmount = decryptionRange?.end ?? ed25519.CURVE.n;

    while (!mH.equals(searchablePoint)) {
      if (amount >= endAmount) throw new Error("Error while decrypting amount in specified range");

      amount += BigInt(1);
      searchablePoint = searchablePoint.add(RistrettoPoint.BASE);
    }
    return amount;
  }

  /**
   * Modify ciphertext by amount
   * @param ciphertext Сiphertext points encrypted by Twisted ElGamal
   * @param operation Operation to change ciphertext points
   * @param amount Natural number or 0
   */
  static modifyCiphertextByAmount(
    ciphertext: TwistedElGamalCiphertext,
    operation: ModifyCiphertextOperation,
    amount: bigint,
  ): TwistedElGamalCiphertext {
    switch (operation) {
      case "add":
        return ciphertext.addAmount(amount);
      case "subtract":
        return ciphertext.subtractAmount(amount);
      default:
        throw new Error("Unsupported operation");
    }
  }

  /**
   * Modify ciphertext by ciphertext
   * @param operand1 Сiphertext points encrypted by Twisted ElGamal
   * @param operation Operation to change ciphertext points
   * @param operand1 Сiphertext points encrypted by Twisted ElGamal
   */
  static modifyCiphertextByCiphertext(
    operand1: TwistedElGamalCiphertext,
    operation: ModifyCiphertextOperation,
    operand2: TwistedElGamalCiphertext,
  ): TwistedElGamalCiphertext {
    switch (operation) {
      case "add":
        return operand1.addCiphertext(operand2);
      case "subtract":
        return operand1.subtractCiphertext(operand2);
      default:
        throw new Error("Unsupported operation");
    }
  }
}

/**
 * Points of ciphertext encrypted by Twisted ElGamal
 */
export class TwistedElGamalCiphertext {
  readonly C: RistPoint;

  readonly D: RistPoint;

  constructor(C: HexInput, D: HexInput) {
    this.C = RistrettoPoint.fromHex(C);
    this.D = RistrettoPoint.fromHex(D);
  }

  public addAmount(amount: bigint): TwistedElGamalCiphertext {
    const aG = RistrettoPoint.BASE.multiply(amount);
    const updatedC = this.C.add(aG);

    return new TwistedElGamalCiphertext(updatedC.toRawBytes(), this.D.toRawBytes());
  }

  public subtractAmount(amount: bigint): TwistedElGamalCiphertext {
    const aG = RistrettoPoint.BASE.multiply(amount);
    const updatedC = this.C.subtract(aG);

    return new TwistedElGamalCiphertext(updatedC.toRawBytes(), this.D.toRawBytes());
  }

  public addCiphertext(ciphertext: TwistedElGamalCiphertext): TwistedElGamalCiphertext {
    const updatedC = this.C.add(ciphertext.C);
    const updatedD = this.D.add(ciphertext.D);

    return new TwistedElGamalCiphertext(updatedC.toRawBytes(), updatedD.toRawBytes());
  }

  public subtractCiphertext(ciphertext: TwistedElGamalCiphertext): TwistedElGamalCiphertext {
    const updatedC = this.C.subtract(ciphertext.C);
    const updatedD = this.D.subtract(ciphertext.D);

    return new TwistedElGamalCiphertext(updatedC.toRawBytes(), updatedD.toRawBytes());
  }
}