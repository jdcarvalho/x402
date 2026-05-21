"""Server-side `BatchSettlementChannelManager` for periodic claim/settle/refund.

Uses the sync facilitator-client protocol and a background `threading.Thread`
per scheduled job to coalesce queued work in priority order.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from .....schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
)
from .....server_base import FacilitatorClientSync
from ..authorizer_signer import sign_claim_batch, sign_refund
from ..constants import SCHEME_BATCH_SETTLEMENT
from ..types import VoucherClaim
from ..utils import compute_channel_id
from .storage import Channel

if TYPE_CHECKING:
    from .scheme import BatchSettlementEvmScheme


AutoJob = Literal["claim", "settle", "refund"]
_AUTO_JOB_PRIORITY: tuple[AutoJob, ...] = ("claim", "settle", "refund")


@dataclass
class ChannelManagerConfig:
    scheme: BatchSettlementEvmScheme
    facilitator: FacilitatorClientSync
    receiver: str
    token: str
    network: str


@dataclass
class AutoSettlementContext:
    now: int
    last_claim_time: int
    last_settle_time: int
    pending_settle: bool


ClaimChannelSelector = Callable[
    [list[Channel], AutoSettlementContext], list[Channel]
]
RefundChannelSelector = Callable[
    [list[Channel], AutoSettlementContext], list[Channel]
]


@dataclass
class ClaimOptions:
    max_claims_per_batch: int | None = None
    idle_secs: int | None = None
    select_claim_channels: ClaimChannelSelector | None = None


@dataclass
class ClaimResult:
    vouchers: int
    transaction: str


@dataclass
class SettleResult:
    transaction: str


@dataclass
class RefundResult:
    channel: str
    transaction: str


@dataclass
class AutoSettlementConfig:
    claim_interval_secs: int | None = None
    settle_interval_secs: int | None = None
    refund_interval_secs: int | None = None
    max_claims_per_batch: int | None = None
    select_claim_channels: ClaimChannelSelector | None = None
    should_settle: Callable[[AutoSettlementContext], bool] | None = None
    select_refund_channels: RefundChannelSelector | None = None
    on_claim: Callable[[ClaimResult], None] | None = None
    on_settle: Callable[[SettleResult], None] | None = None
    on_refund: Callable[[RefundResult], None] | None = None
    on_error: Callable[[BaseException], None] | None = None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _format_facilitator_failure(operation: str, response: SettleResponse) -> str:
    reason = response.error_reason or "unknown"
    message = response.error_message or ""
    return f"{operation} failed: {reason} — {message}"


def _has_live_pending_request(channel: Channel, now_ms: int) -> bool:
    return (
        channel.pending_request is not None
        and channel.pending_request.expires_at > now_ms
    )


class BatchSettlementChannelManager:
    """Sync channel manager for claim / settle / refund lifecycle.

    Methods are synchronous and may block on facilitator I/O. The auto-job
    loop runs in background threads and coalesces pending jobs by priority.
    """

    def __init__(self, config: ChannelManagerConfig) -> None:
        self._scheme = config.scheme
        self._facilitator = config.facilitator
        self._receiver = config.receiver
        self._token = config.token
        self._network = config.network

        self._timers: dict[AutoJob, threading.Event] = {}
        self._timer_threads: dict[AutoJob, threading.Thread] = {}
        self._last_claim_time = 0
        self._last_settle_time = 0
        self._pending_settle = False
        self._running = False
        self._pending_jobs: set[AutoJob] = set()
        self._draining_jobs = False
        self._drain_lock = threading.Lock()
        self._auto_settle_config = AutoSettlementConfig()

    # ----------------------------------------------------------------- public API

    def claim(self, opts: ClaimOptions | None = None) -> list[ClaimResult]:
        targets = self._select_claim_targets(opts)
        max_per_batch = (opts.max_claims_per_batch if opts else None) or 100
        idle_secs = opts.idle_secs if opts else None
        return self._claim_from_channels(
            targets, max_claims_per_batch=max_per_batch, idle_secs=idle_secs
        )

    def settle(self) -> SettleResult:
        payload = self._build_settle_payment_payload()
        response = self._facilitator.settle(payload, self._build_payment_requirements())
        if not response.success:
            raise RuntimeError(_format_facilitator_failure("Settle", response))
        self._pending_settle = False
        return SettleResult(transaction=response.transaction)

    def claim_and_settle(
        self, opts: ClaimOptions | None = None
    ) -> dict[str, Any]:
        claims = self.claim(opts)
        settle: SettleResult | None = None
        if claims:
            settle = self.settle()
        return {"claims": claims, "settle": settle}

    def refund(self, channel_ids: list[str] | None = None) -> list[RefundResult]:
        storage = self._scheme.get_storage()
        channels = storage.list()

        now = _now_ms()
        if channel_ids is not None:
            requested = {c.lower() for c in channel_ids}
            channels = [c for c in channels if c.channel_id.lower() in requested]
        targets = [c for c in channels if not _has_live_pending_request(c, now)]

        if not targets:
            return []
        return self._refund_channels(targets)

    def refund_idle_channels(self, idle_secs: int) -> list[RefundResult]:
        targets = self._get_idle_channels_for_refund(idle_secs)
        return self._refund_channels(targets)

    def get_claimable_vouchers(
        self, idle_secs: int | None = None
    ) -> list[VoucherClaim]:
        channels = self._scheme.get_storage().list()
        return self._get_claimable_vouchers_from_channels(channels, idle_secs)

    def get_withdrawal_pending_sessions(self) -> list[Channel]:
        return [
            c for c in self._scheme.get_storage().list() if c.withdraw_requested_at > 0
        ]

    # ----------------------------------------------------------------- auto loop

    def start(self, config: AutoSettlementConfig | None = None) -> None:
        if self._running:
            return
        now = _now_ms()
        self._last_claim_time = now
        self._last_settle_time = now
        self._running = True
        self._auto_settle_config = config or AutoSettlementConfig()

        self._start_auto_timer("claim", self._auto_settle_config.claim_interval_secs)
        self._start_auto_timer("settle", self._auto_settle_config.settle_interval_secs)
        self._start_auto_timer("refund", self._auto_settle_config.refund_interval_secs)

    def stop(self, flush: bool = False) -> None:
        self._running = False
        for stop_event in self._timers.values():
            stop_event.set()
        for t in self._timer_threads.values():
            if t.is_alive():
                t.join(timeout=1.0)
        self._timers.clear()
        self._timer_threads.clear()
        self._pending_jobs.clear()

        if flush:
            opts = ClaimOptions(
                max_claims_per_batch=self._auto_settle_config.max_claims_per_batch,
                select_claim_channels=self._auto_settle_config.select_claim_channels,
            )
            self.claim_and_settle(opts)

    # ----------------------------------------------------------------- internals

    def _start_auto_timer(self, job: AutoJob, interval_secs: int | None) -> None:
        if interval_secs is None:
            return
        stop_event = threading.Event()
        self._timers[job] = stop_event

        def loop() -> None:
            while not stop_event.is_set():
                if stop_event.wait(interval_secs):
                    return
                self._enqueue_job(job)

        thread = threading.Thread(target=loop, daemon=True, name=f"bs-{job}")
        self._timer_threads[job] = thread
        thread.start()

    def _enqueue_job(self, job: AutoJob) -> None:
        if not self._running:
            return
        with self._drain_lock:
            self._pending_jobs.add(job)
            already_draining = self._draining_jobs
        if not already_draining:
            self._drain_jobs()

    def _drain_jobs(self) -> None:
        with self._drain_lock:
            if self._draining_jobs:
                return
            self._draining_jobs = True
        try:
            while True:
                with self._drain_lock:
                    if not self._running or not self._pending_jobs:
                        return
                    next_job: AutoJob | None = next(
                        (j for j in _AUTO_JOB_PRIORITY if j in self._pending_jobs),
                        None,
                    )
                    if next_job is None:
                        return
                    self._pending_jobs.discard(next_job)
                self._run_auto_job(next_job)
        finally:
            with self._drain_lock:
                self._draining_jobs = False

    def _run_auto_job(self, job: AutoJob) -> None:
        try:
            if job == "claim":
                self._run_claim_job()
            elif job == "settle":
                self._run_settle_job()
            elif job == "refund":
                self._run_refund_job()
        except BaseException as err:  # noqa: BLE001 - escalate to user hook
            on_error = self._auto_settle_config.on_error
            if on_error is not None:
                on_error(err)

    def _run_claim_job(self) -> None:
        cfg = self._auto_settle_config
        targets = self._select_claim_targets(
            ClaimOptions(select_claim_channels=cfg.select_claim_channels)
        )
        results = self._claim_from_channels(
            targets,
            max_claims_per_batch=cfg.max_claims_per_batch or 100,
            idle_secs=None,
        )
        self._last_claim_time = _now_ms()
        if cfg.on_claim is not None:
            for r in results:
                cfg.on_claim(r)

    def _run_settle_job(self) -> None:
        cfg = self._auto_settle_config
        ctx = self._build_auto_settlement_context(_now_ms())
        if not ctx.pending_settle:
            return
        if cfg.should_settle is not None and not cfg.should_settle(ctx):
            return
        result = self.settle()
        self._last_settle_time = _now_ms()
        if cfg.on_settle is not None:
            cfg.on_settle(result)

    def _run_refund_job(self) -> None:
        cfg = self._auto_settle_config
        if cfg.select_refund_channels is None:
            return
        ctx = self._build_auto_settlement_context(_now_ms())
        channels = self._scheme.get_storage().list()
        targets = cfg.select_refund_channels(channels, ctx)
        for r in self._refund_channels(targets):
            if cfg.on_refund is not None:
                cfg.on_refund(r)

    def _select_claim_targets(self, opts: ClaimOptions | None) -> list[Channel]:
        channels = self._scheme.get_storage().list()
        if opts is None or opts.select_claim_channels is None:
            return channels
        ctx = self._build_auto_settlement_context(_now_ms())
        return opts.select_claim_channels(channels, ctx)

    def _claim_from_channels(
        self,
        channels: list[Channel],
        *,
        max_claims_per_batch: int,
        idle_secs: int | None,
    ) -> list[ClaimResult]:
        all_claims = self._get_claimable_vouchers_from_channels(channels, idle_secs)
        if not all_claims:
            return []
        results: list[ClaimResult] = []
        for i in range(0, len(all_claims), max_claims_per_batch):
            batch = all_claims[i : i + max_claims_per_batch]
            result = self._submit_claim(batch)
            results.append(result)
            self._update_claimed_sessions(batch)
        if results:
            self._pending_settle = True
        return results

    def _get_claimable_vouchers_from_channels(
        self, channels: list[Channel], idle_secs: int | None
    ) -> list[VoucherClaim]:
        now = _now_ms()
        out: list[VoucherClaim] = []
        for c in channels:
            if int(c.charged_cumulative_amount) <= int(c.total_claimed):
                continue
            if idle_secs is not None:
                idle_ms = now - c.last_request_timestamp
                if idle_ms < idle_secs * 1000:
                    continue
            out.append(
                VoucherClaim(
                    channel=c.channel_config,
                    max_claimable_amount=c.signed_max_claimable,
                    signature=c.signature,
                    total_claimed=c.charged_cumulative_amount,
                )
            )
        return out

    def _get_idle_channels_for_refund(self, idle_secs: int) -> list[Channel]:
        channels = self._scheme.get_storage().list()
        now = _now_ms()
        idle_ms = idle_secs * 1000
        out: list[Channel] = []
        for c in channels:
            if int(c.balance) == 0:
                continue
            if _has_live_pending_request(c, now):
                continue
            if now - c.last_request_timestamp < idle_ms:
                continue
            out.append(c)
        return out

    def _refund_channels(self, channels: list[Channel]) -> list[RefundResult]:
        now = _now_ms()
        results: list[RefundResult] = []
        for c in channels:
            if _has_live_pending_request(c, now):
                continue
            results.append(self._refund_channel(c))
        return results

    def _refund_channel(self, target: Channel) -> RefundResult:
        signer = self._scheme.get_receiver_authorizer_signer()
        claims = self._build_refund_claims(target)
        refund_amount = str(int(target.balance) - int(target.charged_cumulative_amount))
        nonce = str(target.refund_nonce or 0)

        refund_authorizer_signature = (
            sign_refund(signer, target.channel_id, refund_amount, nonce, self._network)
            if signer is not None
            else None
        )
        claim_authorizer_signature = (
            sign_claim_batch(signer, claims, self._network)
            if signer is not None and claims
            else None
        )

        inner_payload: dict[str, Any] = {
            "type": "refund",
            "channelConfig": target.channel_config.to_dict(),
            "voucher": {
                "channelId": target.channel_id,
                "maxClaimableAmount": target.signed_max_claimable,
                "signature": target.signature,
            },
            "amount": refund_amount,
            "refundNonce": nonce,
            "claims": [c.to_dict() for c in claims],
        }
        if refund_authorizer_signature is not None:
            inner_payload["refundAuthorizerSignature"] = refund_authorizer_signature
        if claim_authorizer_signature is not None:
            inner_payload["claimAuthorizerSignature"] = claim_authorizer_signature

        requirements = self._build_payment_requirements()
        payment_payload = PaymentPayload(
            x402_version=2,
            payload=inner_payload,
            accepted=requirements,
        )

        response = self._facilitator.settle(payment_payload, requirements)
        if not response.success:
            raise RuntimeError(_format_facilitator_failure("Refund", response))

        def update(current: Channel | None) -> Channel | None:
            if current is None:
                return current
            if _has_live_pending_request(current, _now_ms()):
                return current
            return None  # delete

        self._scheme.get_storage().update_channel(target.channel_id, update)

        return RefundResult(channel=target.channel_id, transaction=response.transaction)

    def _build_refund_claims(self, channel: Channel) -> list[VoucherClaim]:
        if int(channel.charged_cumulative_amount) <= int(channel.total_claimed):
            return []
        return [
            VoucherClaim(
                channel=channel.channel_config,
                max_claimable_amount=channel.signed_max_claimable,
                signature=channel.signature,
                total_claimed=channel.charged_cumulative_amount,
            )
        ]

    def _submit_claim(self, claims: list[VoucherClaim]) -> ClaimResult:
        signer = self._scheme.get_receiver_authorizer_signer()
        claim_authorizer_signature = (
            sign_claim_batch(signer, claims, self._network) if signer is not None else None
        )
        inner_payload: dict[str, Any] = {
            "type": "claim",
            "claims": [c.to_dict() for c in claims],
        }
        if claim_authorizer_signature is not None:
            inner_payload["claimAuthorizerSignature"] = claim_authorizer_signature

        requirements = self._build_payment_requirements()
        payment_payload = PaymentPayload(
            x402_version=2,
            payload=inner_payload,
            accepted=requirements,
        )
        response = self._facilitator.settle(payment_payload, requirements)
        if not response.success:
            raise RuntimeError(_format_facilitator_failure("Claim", response))
        return ClaimResult(vouchers=len(claims), transaction=response.transaction)

    def _update_claimed_sessions(self, claims: list[VoucherClaim]) -> None:
        storage = self._scheme.get_storage()
        for claim in claims:
            channel_id = compute_channel_id(claim.channel, self._network)
            channel = storage.get(channel_id)
            if channel is None:
                continue
            claimed_amount = int(claim.total_claimed)
            if claimed_amount <= int(channel.total_claimed):
                continue

            def update(current: Channel | None, _claimed: int = claimed_amount) -> Channel | None:
                if current is None or _claimed <= int(current.total_claimed):
                    return current
                next_ch = current.copy()
                next_ch.total_claimed = str(_claimed)
                return next_ch

            storage.update_channel(channel_id, update)

    def _build_settle_payment_payload(self) -> PaymentPayload:
        requirements = self._build_payment_requirements()
        return PaymentPayload(
            x402_version=2,
            payload={"type": "settle", "receiver": self._receiver, "token": self._token},
            accepted=requirements,
        )

    def _build_payment_requirements(self) -> PaymentRequirements:
        return PaymentRequirements(
            scheme=SCHEME_BATCH_SETTLEMENT,
            network=self._network,
            asset=self._token,
            amount="0",
            pay_to=self._receiver,
            max_timeout_seconds=0,
            extra={},
        )

    def _build_auto_settlement_context(self, now_ms: int) -> AutoSettlementContext:
        return AutoSettlementContext(
            now=now_ms,
            last_claim_time=self._last_claim_time,
            last_settle_time=self._last_settle_time,
            pending_settle=self._pending_settle,
        )


__all__ = [
    "AutoSettlementConfig",
    "AutoSettlementContext",
    "BatchSettlementChannelManager",
    "ChannelManagerConfig",
    "ClaimChannelSelector",
    "ClaimOptions",
    "ClaimResult",
    "RefundResult",
    "SettleResult",
]
