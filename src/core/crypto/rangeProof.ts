// Copyright © Aptos Foundation
// SPDX-License-Identifier: Apache-2.0

export interface RangeProofInputs {
  v: bigint;
  r: Uint8Array;
  valBase: Uint8Array;
  randBase: Uint8Array;
  bits?: number;
}

export interface VerifyRangeProofInputs {
  proof: Uint8Array;
  commitment: Uint8Array;
  valBase: Uint8Array;
  randBase: Uint8Array;
  bits?: number;
}

export class RangeProofExecutor {
  /**
   * Generate range Zero Knowledge Proof
   *
   * @param opts.v The value to create the range proof for
   * @param opts.r A vector of bytes representing the blinding scalar used to hide the value.
   * @param opts.valBase A vector of bytes representing the generator point for the value.
   * @param opts.randBase A vector of bytes representing the generator point for the randomness.
   * @param opts.bits Bits size of value to create the range proof
   */
  static generateRangeZKP: (opts: RangeProofInputs) => Promise<{ proof: Uint8Array; commitment: Uint8Array }>;

  /**
   * Verify range Zero Knowledge Proof
   *
   * @param opts.proof A vector of bytes representing the serialized range proof to be verified.
   * @param opts.commitment A vector of bytes representing the Pedersen commitment the range proof is generated for.
   * @param opts.valBase A vector of bytes representing the generator point for the value.
   * @param opts.randBase A vector of bytes representing the generator point for the randomness.
   * @param opts.bits Bits size of the value for range proof
   */
  static verifyRangeZKP: (opts: VerifyRangeProofInputs) => Promise<boolean>;

  static setGenerateRangeZKP(func: (opts: RangeProofInputs) => Promise<{ proof: Uint8Array; commitment: Uint8Array }>) {
    this.generateRangeZKP = func;
  }

  static setVerifyRangeZKP(func: (opts: VerifyRangeProofInputs) => Promise<boolean>) {
    this.verifyRangeZKP = func;
  }
}