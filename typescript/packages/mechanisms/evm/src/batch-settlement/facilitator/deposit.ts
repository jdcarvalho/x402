import {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import { getAddress, hashTypedData, parseErc6492Signature, isAddressEqual } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import { isContractRevert } from "../../shared/revert";
import type { TransactionRequest } from "../../exact/extensions";
import { BatchSettlementAssetTransferMethod, BatchSettlementDepositPayload } from "../types";
import { batchSettlementABI, erc20BalanceOfABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../constants";
import { getEvmChainId } from "../../utils";
import { multicall } from "../../multicall";
import * as Errors from "../errors";
import {
  readChannelState,
  toContractChannelConfig,
  validateChannelConfig,
  verifyBatchSettlementVoucherTypedData,
} from "./utils";
import {
  buildEip3009DepositCollectorData,
  getEip3009DepositCollectorAddress,
  verifyEip3009DepositAuthorization,
  type Erc3009CounterfactualDeployment,
} from "./deposit-eip3009";
import { buildErc3009DepositNonce } from "../encoding";
import { receiveAuthorizationTypes, ERC3009_DEPOSIT_COLLECTOR_ADDRESS } from "../constants";
import {
  buildDepositTransaction,
  getPermit2DepositCollectorAddress,
  resolvePermit2DepositBranch,
  verifyPermit2DepositAuthorization,
} from "./deposit-permit2";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Verifies a deposit payload (authorization + voucher) without executing any
 * onchain transaction.
 *
 * Performs the following validations:
 * - Token in channelConfig matches the payment requirements asset.
 * - Deposit authorization is valid for the selected transfer method.
 * - Accompanying voucher signature is valid (ECDSA or ERC-1271).
 * - Payer has sufficient token balance for the deposit.
 * - Resulting `maxClaimableAmount` does not exceed effective balance (existing + deposit).
 *
 * @param signer - Facilitator signer for onchain reads and signature verification.
 * @param payment - Full payment envelope containing optional extensions.
 * @param payload - The full deposit payload including channelConfig, amount, authorization, and voucher.
 * @param requirements - Server payment requirements (asset, EIP-712 domain info, timeout, etc.).
 * @param context - Optional facilitator extension context.
 * @param allowedFactories - Allowlisted ERC-6492 factory addresses for counterfactual deposits.
 * @returns A {@link VerifyResponse} with channel state in `extra` on success.
 */
export async function verifyDeposit(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
  allowedFactories: string[] = [],
): Promise<VerifyResponse> {
  const payer = payload.channelConfig.payer;
  const chainId = getEvmChainId(requirements.network);
  const configErr = validateChannelConfig(
    payload.channelConfig,
    payload.voucher.channelId,
    requirements,
  );
  if (configErr) {
    return { isValid: false, invalidReason: configErr, payer };
  }

  const transferMethod = resolveDepositTransferMethod(payload, requirements);
  if (transferMethod === "permit2" && !payload.deposit.authorization.permit2Authorization) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType, payer };
  }

  // erc3009Counterfactual is non-null when the ERC-3009 deposit is from an undeployed
  // ERC-6492 wallet with an allowlisted factory; its inner signature is validated by the
  // deploy+deposit simulation below rather than a direct (no-code) signature check.
  let erc3009Counterfactual: Erc3009CounterfactualDeployment | null = null;
  // True when the payer is an *already-deployed* ERC-6492 wallet (deployment info present
  // in the sig but code already exists). verifyEip3009DepositAuthorization validated the
  // inner sig via ERC-1271 (isValidSignature), so the direct deposit() simulation below
  // is redundant — and harmful: USDC's receiveWithAuthorization first tries ecrecover,
  // which fails on the multi-byte SignatureWrapper. Skip the simulation and trust that
  // on-chain USDC will route to ERC-1271 the same way the off-chain check already did.
  let erc3009DeployedErc6492 = false;
  if (transferMethod === "permit2") {
    const methodErr = await verifyPermit2DepositAuthorization(
      signer,
      payment,
      payload,
      requirements,
      chainId,
      context,
    );
    if (methodErr) {
      return methodErr;
    }
  } else {
    const result = await verifyEip3009DepositAuthorization(
      signer,
      payload,
      requirements,
      chainId,
      allowedFactories,
    );
    if (result.response) {
      return result.response;
    }
    erc3009Counterfactual = result.counterfactual;
    // Detect already-deployed ERC-6492: deployment info present in sig but wallet is live.
    if (!erc3009Counterfactual) {
      const auth = payload.deposit.authorization.erc3009Authorization;
      if (auth?.signature) {
        const { address: factoryAddr } = parseErc6492Signature(auth.signature as `0x${string}`);
        erc3009DeployedErc6492 = !!(factoryAddr && !isAddressEqual(factoryAddr, ZERO_ADDRESS));
      }
    }
  }

  const shared = await verifySharedDepositState(signer, payload, requirements);
  if (!shared.ok) {
    return shared.response;
  }

  const { depositAmount, chBalance, chTotalClaimed, wdInitiatedAt, refundNonceVal } = shared;

  const execution = await resolveDepositExecution(signer, payment, payload, requirements, context);
  if ("isValid" in execution) {
    return execution;
  }

  if (erc3009Counterfactual) {
    // Counterfactual ERC-6492 wallet: the factory is allowlisted and the payer has no code yet.
    // Skip the Multicall3 simulation — tryAggregate(requireSuccess=false) runs call 2
    // (isValidSignature) even when call 1 (factory deploy) reverts in eth_call context,
    // causing a spurious "ECRecover: invalid signature length" failure from USDC. The Go and
    // Python facilitators skip this simulation entirely and rely on the settle path to deploy
    // the wallet and run the real on-chain receiveWithAuthorization with ERC-1271 support.
    // The factory allowlist check in verifyEip3009DepositAuthorization is sufficient
    // pre-validation; the actual signature validity is proven at settle time.
  } else if (!execution.skipDirectSimulation && !erc3009DeployedErc6492) {
    try {
      await signer.readContract({
        address: getAddress(BATCH_SETTLEMENT_ADDRESS),
        abi: batchSettlementABI,
        functionName: "deposit",
        args: [
          toContractChannelConfig(payload.channelConfig),
          depositAmount,
          execution.collector,
          execution.collectorData,
        ],
      });
    } catch (e) {
      return {
        isValid: false,
        invalidReason: Errors.ErrDepositSimulationFailed,
        invalidMessage: e instanceof Error ? e.message : String(e),
        payer,
      };
    }
  }

  return {
    isValid: true,
    payer,
    extra: {
      channelId: payload.voucher.channelId,
      balance: chBalance.toString(),
      totalClaimed: chTotalClaimed.toString(),
      withdrawRequestedAt: Number(wdInitiatedAt),
      refundNonce: refundNonceVal.toString(),
    },
  };
}

/**
 * Verifies channel, voucher, balance, and cumulative amount invariants.
 *
 * @param signer - Facilitator signer for reads and voucher verification.
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @returns Shared channel state on success, or a verification failure.
 */
async function verifySharedDepositState(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
): Promise<
  | {
      ok: true;
      chainId: number;
      depositAmount: bigint;
      payer: `0x${string}`;
      chBalance: bigint;
      chTotalClaimed: bigint;
      wdInitiatedAt: bigint;
      refundNonceVal: bigint;
    }
  | { ok: false; response: VerifyResponse }
> {
  const { deposit, voucher } = payload;
  const config = payload.channelConfig;
  const payer = config.payer;
  const chainId = getEvmChainId(requirements.network);

  const configErr = validateChannelConfig(config, voucher.channelId, requirements);
  if (configErr) {
    return { ok: false, response: { isValid: false, invalidReason: configErr, payer } };
  }

  const voucherOk = await verifyBatchSettlementVoucherTypedData(
    signer,
    {
      channelId: voucher.channelId,
      maxClaimableAmount: voucher.maxClaimableAmount,
      payerAuthorizer: config.payerAuthorizer,
      payer: config.payer,
      signature: voucher.signature,
    },
    chainId,
  );
  if (!voucherOk) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrInvalidVoucherSignature, payer },
    };
  }

  const mcResults = await multicall(signer.readContract.bind(signer), [
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "channels",
      args: [voucher.channelId],
    },
    {
      address: getAddress(requirements.asset),
      abi: erc20BalanceOfABI,
      functionName: "balanceOf",
      args: [getAddress(payer)],
    },
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "pendingWithdrawals",
      args: [voucher.channelId],
    },
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "refundNonce",
      args: [voucher.channelId],
    },
  ]);

  const [chRes, balRes, wdRes, rnRes] = mcResults;
  if (
    chRes.status === "failure" ||
    balRes.status === "failure" ||
    wdRes.status === "failure" ||
    rnRes.status === "failure"
  ) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrRpcReadFailed, payer },
    };
  }

  const [chBalance, chTotalClaimed] = chRes.result as [bigint, bigint];
  const payerBalance = balRes.result as bigint;
  const [, wdInitiatedAt] = wdRes.result as [bigint, bigint];
  const refundNonceVal = rnRes.result as bigint;
  const depositAmount = BigInt(deposit.amount);

  if (payerBalance < depositAmount) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrInsufficientBalance, payer },
    };
  }

  const effectiveBalance = chBalance + depositAmount;
  const maxClaimableAmount = BigInt(voucher.maxClaimableAmount);

  if (maxClaimableAmount > effectiveBalance) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrCumulativeExceedsBalance, payer },
    };
  }

  if (maxClaimableAmount <= chTotalClaimed) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrCumulativeAmountBelowClaimed, payer },
    };
  }

  return {
    ok: true,
    chainId,
    depositAmount,
    payer,
    chBalance,
    chTotalClaimed,
    wdInitiatedAt,
    refundNonceVal,
  };
}

/**
 * Executes a deposit onchain through the collector for the selected transfer method.
 *
 * The deposit is first verified via {@link verifyDeposit}; if invalid the returned
 * {@link SettleResponse} will have `success: false` with the verification reason.
 *
 * @param signer - Facilitator signer used to submit the onchain transaction.
 * @param payment - Full payment envelope containing optional extensions.
 * @param payload - The deposit payload (channelConfig, amount, authorization, voucher).
 * @param requirements - Server payment requirements.
 * @param context - Optional facilitator extension context.
 * @param dataSuffix - Optional hex suffix appended to the deposit transaction.
 * @param allowedFactories - Allowlisted ERC-6492 factory addresses for counterfactual deposits.
 * @returns A {@link SettleResponse} with the transaction hash and updated channel state in `extra`.
 */
export async function settleDeposit(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
  dataSuffix?: `0x${string}`,
  allowedFactories: string[] = [],
): Promise<SettleResponse> {
  const { deposit, voucher } = payload;
  const config = payload.channelConfig;
  const payer = config.payer;

  const verified = await verifyDeposit(
    signer,
    payment,
    payload,
    requirements,
    context,
    allowedFactories,
  );
  if (!verified.isValid) {
    const reason = verified.invalidReason ?? Errors.ErrInvalidPayloadType;
    return {
      success: false,
      errorReason: reason,
      errorMessage: verified.invalidMessage ?? reason,
      transaction: "",
      network: requirements.network,
      payer: verified.payer,
    };
  }

  try {
    const execution = await resolveDepositExecution(
      signer,
      payment,
      payload,
      requirements,
      context,
    );
    if ("isValid" in execution) {
      const reason = execution.invalidReason ?? Errors.ErrInvalidPayloadType;
      return {
        success: false,
        errorReason: reason,
        errorMessage: execution.invalidMessage ?? reason,
        transaction: "",
        network: requirements.network,
        payer: execution.payer,
      };
    }

    // ERC-6492 counterfactual deposit: deploy the undeployed wallet (gated by the factory
    // allowlist) before the deposit, then simulate with the inner signature to catch wallets
    // whose validator is installed lazily.
    if (resolveDepositTransferMethod(payload, requirements) === "eip3009") {
      const deployErr = await deployErc3009CounterfactualIfNeeded(
        signer,
        payload,
        requirements,
        allowedFactories,
        execution.collector,
        execution.collectorData,
      );
      if (deployErr) {
        return deployErr;
      }
    }

    const depositTx = buildDepositTransaction(payload, execution.collectorData, dataSuffix);

    const tx =
      execution.kind === "erc20Approval"
        ? (
            await execution.extensionSigner.sendTransactions([
              execution.signedTransaction,
              depositTx,
            ])
          )[1]
        : await signer.writeContract({
            address: getAddress(BATCH_SETTLEMENT_ADDRESS),
            abi: batchSettlementABI,
            functionName: "deposit",
            args: [
              toContractChannelConfig(config),
              BigInt(deposit.amount),
              execution.collector,
              execution.collectorData,
            ],
            dataSuffix,
          });

    const receipt = await signer.waitForTransactionReceipt({ hash: tx });

    if (receipt.status !== "success") {
      return {
        success: false,
        errorReason: Errors.ErrDepositTransactionFailed,
        errorMessage: `transaction reverted (receipt status ${receipt.status})`,
        transaction: tx,
        network: requirements.network,
        payer,
      };
    }

    const optimisticExtra = {
      channelState: {
        channelId: voucher.channelId,
        balance: (
          BigInt(String(verified.extra?.balance ?? "0")) + BigInt(deposit.amount)
        ).toString(),
        totalClaimed: String(verified.extra?.totalClaimed ?? "0"),
        withdrawRequestedAt: Number(verified.extra?.withdrawRequestedAt ?? 0),
        refundNonce: String(verified.extra?.refundNonce ?? "0"),
      },
    };

    // Poll the RPC until it reflects the just-confirmed deposit, so subsequent verify reads are guaranteed to see this balance
    const expectedMinBalance = BigInt(optimisticExtra.channelState.balance);
    const rpcDeadline = Date.now() + 2_000;
    let postState = await readChannelState(signer, voucher.channelId);
    while (postState.balance < expectedMinBalance && Date.now() < rpcDeadline) {
      await new Promise(resolve => setTimeout(resolve, 150));
      postState = await readChannelState(signer, voucher.channelId);
    }

    const rpcCaughtUp = postState.balance >= expectedMinBalance;

    return {
      success: true,
      transaction: tx,
      network: requirements.network,
      payer,
      amount: deposit.amount,
      extra: rpcCaughtUp
        ? {
            ...optimisticExtra,
            channelState: {
              channelId: voucher.channelId,
              balance: postState.balance.toString(),
              totalClaimed: postState.totalClaimed.toString(),
              withdrawRequestedAt: postState.withdrawRequestedAt,
              refundNonce: postState.refundNonce.toString(),
            },
          }
        : optimisticExtra,
    };
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrDepositTransactionFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network: requirements.network,
      payer,
    };
  }
}

type DepositExecution =
  | {
      kind: "direct";
      collector: `0x${string}`;
      collectorData: `0x${string}`;
      skipDirectSimulation?: boolean;
    }
  | {
      kind: "erc20Approval";
      collector: `0x${string}`;
      collectorData: `0x${string}`;
      signedTransaction: `0x${string}`;
      extensionSigner: {
        sendTransactions(transactions: TransactionRequest[]): Promise<`0x${string}`[]>;
      };
      skipDirectSimulation: true;
    };

/**
 * Resolves the collector address and collector data for a deposit payload.
 *
 * @param signer - Facilitator signer for Permit2 allowance reads.
 * @param payment - Full payment envelope containing optional extensions.
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @param context - Optional facilitator extension context.
 * @returns Execution details, or a verification failure response.
 */
async function resolveDepositExecution(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
): Promise<DepositExecution | VerifyResponse> {
  const transferMethod = resolveDepositTransferMethod(payload, requirements);
  if (transferMethod === "eip3009") {
    return {
      kind: "direct",
      collector: getEip3009DepositCollectorAddress(),
      collectorData: buildEip3009DepositCollectorData(payload),
      // eip3009 deposits from ERC-6492 smart wallets cannot be simulated: USDC's
      // receiveWithAuthorization uses ecrecover first and fails on the multi-byte
      // SignatureWrapper format. The on-chain settle path supports ERC-1271 correctly.
      // Go and Python facilitators skip simulation entirely for the same reason.
      skipDirectSimulation: true,
    };
  }

  const branch = await resolvePermit2DepositBranch(signer, payment, payload, requirements, context);
  if ("isValid" in branch) {
    return branch;
  }

  if (branch.kind === "erc20Approval") {
    return {
      kind: "erc20Approval",
      collector: getPermit2DepositCollectorAddress(),
      collectorData: branch.collectorData,
      signedTransaction: branch.signedTransaction,
      extensionSigner: branch.extensionSigner,
      skipDirectSimulation: true,
    };
  }

  return {
    kind: "direct",
    collector: getPermit2DepositCollectorAddress(),
    collectorData: branch.collectorData,
  };
}

/**
 * ERC-1271 ABI for `isValidSignature(bytes32,bytes) returns (bytes4)`.
 */
const ERC1271_IS_VALID_SIGNATURE_ABI = [
  {
    name: "isValidSignature",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

const ERC1271_MAGIC_VALUE = "0x1626ba7e" as const;

/**
 * Simulates factory-deploy + ERC-1271 signature check atomically via Multicall3.
 *
 * Mirrors how the exact scheme validates counterfactual wallets: call 1 deploys the
 * wallet, call 2 verifies the authorization signature using `isValidSignature` on the
 * just-deployed wallet. This bypasses the BatchSettlement.deposit() → ERC3009DepositCollector
 * → USDC indirection, which masks signature errors with "ECRecover: invalid signature length"
 * when the factory deploy silently fails (Multicall3 allowFailure=true means call 2 still
 * runs even when call 1 reverts, and USDC then falls back to ecrecover against the
 * multi-byte SignatureWrapper).
 *
 * The ERC-1271 call uses the exact ReceiveWithAuthorization typed-data hash that USDC
 * computes on-chain, so a successful simulation guarantees USDC will accept the signature
 * when the real deposit transaction runs.
 *
 * @param signer - Facilitator signer for the Multicall3 eth_call.
 * @param deployment - Factory address + calldata that deploys the counterfactual wallet.
 * @param payload - Batch deposit payload.
 * @param depositAmount - Deposit amount in the token's smallest unit.
 * @param requirements - Payment requirements (provides the USDC EIP-712 domain).
 * @returns True when the wallet is deployed and isValidSignature returns the ERC-1271 magic value.
 */
async function simulateCounterfactualDeposit(
  signer: FacilitatorEvmSigner,
  deployment: Erc3009CounterfactualDeployment,
  payload: BatchSettlementDepositPayload,
  depositAmount: bigint,
  requirements: PaymentRequirements,
): Promise<boolean> {
  const auth = payload.deposit.authorization.erc3009Authorization;
  if (!auth) return false;

  const extra = requirements.extra as { name?: string; version?: string } | undefined;
  if (!extra?.name || !extra?.version) return false;

  const chainId = getEvmChainId(requirements.network);
  const payer = payload.channelConfig.payer;

  // Compute the ERC-3009 nonce that USDC will verify against (channelId-bound).
  const erc3009Nonce = buildErc3009DepositNonce(payload.voucher.channelId, auth.salt as `0x${string}`);

  // Compute the exact ReceiveWithAuthorization EIP-712 hash that USDC will use.
  // This is the hash the wallet's isValidSignature must accept.
  const receiveAuthHash = hashTypedData({
    domain: {
      name: extra.name,
      version: extra.version,
      chainId,
      verifyingContract: getAddress(requirements.asset),
    },
    types: receiveAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: getAddress(payer),
      to: getAddress(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
      value: depositAmount,
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: erc3009Nonce,
    },
  });

  // Extract the inner signature from the ERC-6492 wrapper — this is what the
  // deployed wallet's isValidSignature will receive.
  const { signature: innerSig } = parseErc6492Signature(auth.signature);

  try {
    const results = await multicall(signer.readContract.bind(signer), [
      // Call 1: deploy the counterfactual wallet.
      { address: deployment.factory, callData: deployment.factoryCalldata },
      // Call 2: verify the inner signature against the just-deployed wallet.
      // No msg.sender restriction (unlike receiveWithAuthorization), so this
      // works correctly from within Multicall3's eth_call context.
      {
        address: getAddress(payer),
        abi: ERC1271_IS_VALID_SIGNATURE_ABI,
        functionName: "isValidSignature",
        args: [receiveAuthHash, innerSig],
      },
    ]);

    if (results.length < 2 || results[1].status === "failure") return false;
    const magicValue = results[1].result as string | undefined;
    return typeof magicValue === "string" && magicValue.toLowerCase().startsWith(ERC1271_MAGIC_VALUE);
  } catch {
    return false;
  }
}

/**
 * Deploys an undeployed ERC-6492 wallet before an ERC-3009 deposit.
 *
 * Returns null when no deployment is needed (caller proceeds to deposit), or a terminal
 * {@link SettleResponse} when the factory is disallowed, the deploy reverts, or the deployed
 * wallet rejects the inner signature.
 *
 * @param signer - Facilitator signer used to deploy the wallet and simulate the deposit.
 * @param payload - Batch deposit payload carrying the ERC-6492-wrapped authorization.
 * @param requirements - Server payment requirements (used for the network in error responses).
 * @param allowedFactories - Allowlisted ERC-6492 factory addresses.
 * @param collector - Deposit collector address.
 * @param collectorData - ABI-encoded collector data (inner signature already unwrapped).
 * @returns A terminal {@link SettleResponse} on failure, or null to proceed with the deposit.
 */
async function deployErc3009CounterfactualIfNeeded(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  allowedFactories: string[],
  collector: `0x${string}`,
  collectorData: `0x${string}`,
): Promise<SettleResponse | null> {
  const config = payload.channelConfig;
  const payer = config.payer;
  const auth = payload.deposit.authorization.erc3009Authorization;
  if (!auth) {
    return null;
  }

  const { address: factory, data: factoryCalldata } = parseErc6492Signature(auth.signature);
  const hasDeploymentInfo = !!(
    factory &&
    factoryCalldata &&
    !isAddressEqual(factory, ZERO_ADDRESS)
  );
  if (!hasDeploymentInfo) {
    return null;
  }

  let code: `0x${string}` | undefined;
  try {
    code = await signer.getCode({ address: payer });
  } catch {
    code = undefined;
  }
  if (code && code !== "0x") {
    // Already deployed — nothing to do; proceed with the standard deposit.
    return null;
  }

  const normalizedFactory = factory.toLowerCase();
  if (!allowedFactories.some(a => a.trim().toLowerCase() === normalizedFactory)) {
    return {
      success: false,
      errorReason: Errors.ErrFactoryNotAllowed,
      errorMessage: "factory not in eip6492AllowedFactories allowlist",
      transaction: "",
      network: requirements.network,
      payer,
    };
  }

  const deployTx = await signer.sendTransaction({
    to: factory,
    data: factoryCalldata as `0x${string}`,
  });
  const deployReceipt = await signer.waitForTransactionReceipt({ hash: deployTx });
  if (deployReceipt.status !== "success") {
    return {
      success: false,
      errorReason: Errors.ErrSmartWalletDeploymentFailed,
      transaction: "",
      network: requirements.network,
      payer,
    };
  }

  return null;
}

/**
 * Selects the transfer method from requirements, falling back to payload shape.
 *
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @returns Selected batch-settlement transfer method.
 */
function resolveDepositTransferMethod(
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
): BatchSettlementAssetTransferMethod {
  const hinted = (
    requirements.extra as { assetTransferMethod?: BatchSettlementAssetTransferMethod }
  )?.assetTransferMethod;
  if (hinted) {
    return hinted;
  }
  return payload.deposit.authorization.permit2Authorization ? "permit2" : "eip3009";
}
