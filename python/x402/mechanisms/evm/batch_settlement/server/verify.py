"""Server-side verify lifecycle hooks for the batch-settlement EVM scheme.

Mirrors `typescript/packages/mechanisms/evm/src/batch-settlement/server/verify.ts`.

The local-verify optimization path (TS `verifyVoucherLocally`) requires
`validate_channel_config` from the not-yet-implemented facilitator subpackage
and is intentionally omitted for the first iteration. Verification always
goes through the facilitator; correctness is unaffected — only the optional
fast path is.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from ...utils import create_nonce
from ..constants import SCHEME_BATCH_SETTLEMENT
from ..errors import (
    ERR_CHANNEL_BUSY,
    ERR_CUMULATIVE_AMOUNT_MISMATCH,
)
from ..types import (
    is_deposit_payload,
    is_refund_payload,
    is_voucher_payload,
)
from .storage import Channel, PendingRequest
from .utils import read_extra_number, read_extra_string

if TYPE_CHECKING:
    from .....interfaces import SchemePaymentRequiredContext
    from .....schemas import PaymentRequirements
    from .....schemas.hooks import (
        SkipHandlerResult,
        VerifiedPaymentCanceledContext,
        VerifyContext,
        VerifyFailureContext,
        VerifyResultContext,
    )
    from .scheme import BatchSettlementEvmScheme

# Framework cleanup hooks clear pending reservations for normal failures.
# This bounded TTL releases channels when cleanup cannot run or complete.
_MIN_PENDING_TTL_MS = 5_000
_MAX_PENDING_TTL_MS = 10 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


def _pending_expires_at(max_timeout_seconds: int | None, now_ms: int) -> int:
    requested_ms = max(0, max_timeout_seconds or 0) * 1000
    ttl_ms = min(_MAX_PENDING_TTL_MS, max(_MIN_PENDING_TTL_MS, requested_ms))
    return now_ms + ttl_ms


def _is_pending_live(pending: PendingRequest | None, now_ms: int) -> bool:
    return pending is not None and pending.expires_at > now_ms


def _infer_missing_local_charged_amount(
    signed_max_claimable: str, price: str, is_paid_payload: bool
) -> str:
    if not is_paid_payload:
        return signed_max_claimable
    signed = int(signed_max_claimable)
    amount = int(price)
    if signed < amount:
        return "0"
    return str(signed - amount)


def _build_provisional_channel(
    raw: dict, charged_cumulative_amount: str
) -> Channel:
    from ..types import ChannelConfig

    voucher = raw["voucher"]
    return Channel(
        channel_id=voucher["channelId"],
        channel_config=ChannelConfig.from_dict(raw["channelConfig"]),
        charged_cumulative_amount=charged_cumulative_amount,
        signed_max_claimable=str(voucher["maxClaimableAmount"]),
        signature=voucher.get("signature", "0x"),
        balance="0",
        total_claimed="0",
        withdraw_requested_at=0,
        refund_nonce=0,
        last_request_timestamp=_now_ms(),
    )


def handle_before_verify(
    scheme: BatchSettlementEvmScheme, ctx: VerifyContext
):
    """Reserve the channel for an in-flight verify, or abort on mismatch / busy."""
    from .....schemas.hooks import AbortResult

    payment_payload = ctx.payment_payload
    requirements = ctx.requirements
    raw = payment_payload.payload

    is_paid_payload = is_voucher_payload(raw) or is_deposit_payload(raw)
    is_zero_charge_payload = is_refund_payload(raw)
    if not is_paid_payload and not is_zero_charge_payload:
        return None

    voucher = raw["voucher"]
    channel_id = voucher["channelId"]
    now = _now_ms()
    pending_id = create_nonce()

    # `outcome` is set inside the update callback so we know what happened.
    outcome: dict = {}

    def update(current: Channel | None) -> Channel | None:
        if _is_pending_live(current.pending_request if current else None, now):
            outcome["status"] = "busy"
            return current

        charged_cumulative_amount = (
            current.charged_cumulative_amount
            if current
            else _infer_missing_local_charged_amount(
                str(voucher["maxClaimableAmount"]),
                requirements.amount,
                is_paid_payload,
            )
        )

        if is_zero_charge_payload:
            expected = int(charged_cumulative_amount)
        else:
            expected = int(charged_cumulative_amount) + int(requirements.amount)

        if int(voucher["maxClaimableAmount"]) != expected:
            if current:
                outcome["status"] = "mismatch"
                outcome["channel"] = current
            else:
                outcome["status"] = "mismatch"
                outcome["channel"] = _build_provisional_channel(
                    raw, charged_cumulative_amount
                )
            return current

        outcome["status"] = "reserved"
        outcome["channel_snapshot"] = current

        next_ch = (current.copy() if current else _build_provisional_channel(
            raw, charged_cumulative_amount
        ))
        next_ch.pending_request = PendingRequest(
            pending_id=pending_id,
            signed_max_claimable=str(voucher["maxClaimableAmount"]),
            expires_at=_pending_expires_at(requirements.max_timeout_seconds, now),
        )
        next_ch.last_request_timestamp = now
        return next_ch

    scheme.get_storage().update_channel(channel_id, update)

    status = outcome.get("status")
    if status == "busy":
        return AbortResult(reason=ERR_CHANNEL_BUSY)

    if status == "mismatch":
        scheme.remember_channel_snapshot(payment_payload, outcome["channel"])
        return AbortResult(reason=ERR_CUMULATIVE_AMOUNT_MISMATCH)

    if status == "reserved":
        from .scheme import BatchSettlementRequestContext

        scheme.merge_request_context(
            payment_payload,
            BatchSettlementRequestContext(
                channel_id=channel_id,
                pending_id=pending_id,
                channel_snapshot=outcome.get("channel_snapshot"),
            ),
        )

    return None


def handle_after_verify(
    scheme: BatchSettlementEvmScheme, ctx: VerifyResultContext
) -> SkipHandlerResult | None:
    """Persist channel state after facilitator verify; emit skipHandler for refunds."""
    from .....schemas.hooks import SkipHandlerDirective, SkipHandlerResult
    from ..types import ChannelConfig

    payment_payload = ctx.payment_payload
    result = ctx.result

    if not result.is_valid or not result.payer:
        scheme.clear_pending_request(payment_payload)
        return None

    raw = payment_payload.payload
    is_refund_voucher = False

    if is_deposit_payload(raw) or is_voucher_payload(raw):
        channel_config_dict = raw["channelConfig"]
    elif is_refund_payload(raw):
        channel_config_dict = raw["channelConfig"]
        is_refund_voucher = True
    else:
        return None

    voucher = raw["voucher"]
    channel_id = voucher["channelId"]
    signed_max_claimable = str(voucher["maxClaimableAmount"])
    signature = voucher.get("signature", "0x")
    channel_config = ChannelConfig.from_dict(channel_config_dict)

    extra = result.extra or {}
    balance = read_extra_string(extra, "balance", "0")
    total_claimed = read_extra_string(extra, "totalClaimed", "0")
    withdraw_requested_at = read_extra_number(extra, "withdrawRequestedAt", 0)
    refund_nonce = read_extra_number(extra, "refundNonce", 0)
    now = _now_ms()

    request_context = scheme.read_request_context(payment_payload)
    if request_context is None or not request_context.pending_id:
        return None
    if request_context.local_verify and is_voucher_payload(raw):
        return None

    def update(current: Channel | None) -> Channel | None:
        if current is None:
            return current
        if (
            current.pending_request is None
            or current.pending_request.pending_id != request_context.pending_id
        ):
            return current
        next_ch = current.copy()
        next_ch.channel_config = channel_config
        next_ch.signed_max_claimable = signed_max_claimable
        next_ch.signature = signature
        next_ch.balance = balance
        next_ch.total_claimed = total_claimed
        next_ch.withdraw_requested_at = withdraw_requested_at
        next_ch.refund_nonce = refund_nonce
        if not request_context.local_verify:
            next_ch.onchain_synced_at = now
        next_ch.last_request_timestamp = now
        return next_ch

    update_result = scheme.get_storage().update_channel(channel_id, update)
    if update_result.status == "updated" and update_result.channel is not None:
        scheme.remember_channel_snapshot(payment_payload, update_result.channel)

    if is_refund_voucher and update_result.status == "updated":
        body = {"message": "Refund acknowledged", "channelId": channel_id}
        return SkipHandlerResult(
            response=SkipHandlerDirective(content_type="application/json", body=body)
        )

    return None


def handle_verify_failure(
    scheme: BatchSettlementEvmScheme, ctx: VerifyFailureContext
) -> None:
    """Clear this request's pending reservation after verify throws."""
    scheme.clear_pending_request(ctx.payment_payload)


def handle_verified_payment_canceled(
    scheme: BatchSettlementEvmScheme,
    ctx: VerifiedPaymentCanceledContext,
) -> None:
    """Clear this request's reservation when handler work is canceled."""
    if ctx.reason not in ("handler_threw", "handler_failed"):
        return
    scheme.clear_pending_request(ctx.payment_payload)


def handle_enrich_payment_required_response(
    scheme: BatchSettlementEvmScheme,
    ctx: SchemePaymentRequiredContext,
) -> list[PaymentRequirements] | None:
    """Embed channel snapshot in corrective 402 responses for cumulative mismatches."""
    if ctx.error != ERR_CUMULATIVE_AMOUNT_MISMATCH:
        return None

    payment_payload = ctx.payment_payload
    if payment_payload is None:
        return None

    raw = payment_payload.payload
    if not (
        is_voucher_payload(raw) or is_deposit_payload(raw) or is_refund_payload(raw)
    ):
        return None

    channel_id = raw["voucher"]["channelId"]
    channel = scheme.take_channel_snapshot(payment_payload)
    if channel is None:
        channel = scheme.get_storage().get(channel_id)
    if channel is None:
        return None

    accept_network = payment_payload.accepted.network
    for req in ctx.requirements:
        if req.scheme != SCHEME_BATCH_SETTLEMENT or req.network != accept_network:
            continue
        extra = dict(req.extra or {})
        extra["channelState"] = {
            "channelId": channel.channel_id,
            "balance": channel.balance,
            "totalClaimed": channel.total_claimed,
            "withdrawRequestedAt": channel.withdraw_requested_at,
            "refundNonce": str(channel.refund_nonce),
            "chargedCumulativeAmount": channel.charged_cumulative_amount,
        }
        extra["voucherState"] = {
            "signedMaxClaimable": channel.signed_max_claimable,
            "signature": channel.signature,
        }
        req.extra = extra

    return ctx.requirements


__all__ = [
    "handle_before_verify",
    "handle_after_verify",
    "handle_verify_failure",
    "handle_verified_payment_canceled",
    "handle_enrich_payment_required_response",
]
