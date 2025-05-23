import { Deserializer, Serializer } from "../../bcs";
import { HexInput } from "../../types";
import { AccountAddress } from "../accountAddress";
import { AuthenticationKey } from "../authenticationKey";
import { Hex } from "../hex";
import { AccountPublicKey, VerifySignatureArgs, VerifySignatureAsyncArgs } from "./publicKey";
import { Signature } from "./signature";

export class AbstractSignature extends Signature {
  readonly value: Uint8Array;

  constructor(value: HexInput) {
    super();
    this.value = Hex.fromHexInput(value).toUint8Array();
  }

  serialize(serializer: Serializer): void {
    serializer.serializeBytes(this.value);
  }

  static deserialize(deserializer: Deserializer): AbstractSignature {
    return new AbstractSignature(deserializer.deserializeBytes());
  }
}

export class AbstractPublicKey extends AccountPublicKey {
  readonly accountAddress: AccountAddress;

  constructor(accountAddress: AccountAddress) {
    super();
    this.accountAddress = accountAddress;
  }

  authKey(): AuthenticationKey {
    return new AuthenticationKey({ data: this.accountAddress.toUint8Array() });
  }

  // eslint-disable-next-line class-methods-use-this, @typescript-eslint/no-unused-vars
  verifySignature(args: VerifySignatureArgs): boolean {
    throw new Error("This function is not implemented for AbstractPublicKey.");
  }

  // eslint-disable-next-line class-methods-use-this, @typescript-eslint/no-unused-vars
  async verifySignatureAsync(args: VerifySignatureAsyncArgs): Promise<boolean> {
    throw new Error("This function is not implemented for AbstractPublicKey.");
  }

  // eslint-disable-next-line class-methods-use-this, @typescript-eslint/no-unused-vars
  serialize(serializer: Serializer): void {
    throw new Error("This function is not implemented for AbstractPublicKey.");
  }
}
