"""Facilitator-side primitives for the batch-settlement EVM scheme."""

from .claim import build_voucher_claim_args, execute_claim_with_signature
from .deposit import settle_deposit, verify_deposit
from .deposit_eip3009 import (
    build_eip3009_deposit_collector_data,
    get_eip3009_deposit_collector_address,
    verify_eip3009_deposit_authorization,
)
from .deposit_permit2 import (
    Permit2DepositBranch,
    build_permit2_deposit_collector_data,
    get_permit2_deposit_collector_address,
    resolve_permit2_deposit_branch,
    verify_permit2_deposit_authorization,
)
from .refund import execute_refund_with_signature
from .scheme import BatchSettlementEvmFacilitator
from .settle import execute_settle
from .utils import (
    ZERO_ADDRESS,
    channel_ids_equal,
    erc3009_authorization_time_invalid_reason,
    read_channel_state,
    to_contract_channel_config,
    validate_channel_config,
    verify_batch_settlement_voucher_typed_data,
)
from .voucher import verify_voucher

__all__ = [
    "BatchSettlementEvmFacilitator",
    "Permit2DepositBranch",
    "ZERO_ADDRESS",
    "build_eip3009_deposit_collector_data",
    "build_permit2_deposit_collector_data",
    "build_voucher_claim_args",
    "channel_ids_equal",
    "erc3009_authorization_time_invalid_reason",
    "execute_claim_with_signature",
    "execute_refund_with_signature",
    "execute_settle",
    "get_eip3009_deposit_collector_address",
    "get_permit2_deposit_collector_address",
    "read_channel_state",
    "resolve_permit2_deposit_branch",
    "settle_deposit",
    "to_contract_channel_config",
    "validate_channel_config",
    "verify_batch_settlement_voucher_typed_data",
    "verify_deposit",
    "verify_eip3009_deposit_authorization",
    "verify_permit2_deposit_authorization",
    "verify_voucher",
]
