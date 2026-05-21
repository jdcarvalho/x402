"""x402 batch-settlement httpx client example.

Issues a sequence of paid requests against a batch-settlement-protected
resource. The first request opens an on-chain payment channel (deposit);
each subsequent request is settled off-chain as a voucher against the
same channel until the client cooperatively refunds the unused balance.

Run with:
    uv sync && uv run python main.py

Environment variables:
    RESOURCE_SERVER_URL              Required. e.g. http://localhost:4021
    ENDPOINT_PATH                    Required. e.g. /weather
    EVM_PRIVATE_KEY                  Required. Payer (client) private key.
    EVM_RPC_URL                      Optional. Defaults to https://sepolia.base.org.
    REQUEST_COUNT                    Optional. Number of paid requests (default 3).
    REFUND_AFTER                     Optional. If "true", issue a cooperative refund after the last request.
"""

from __future__ import annotations

import asyncio
import os
import sys

from dotenv import load_dotenv
from eth_account import Account
import httpx

from x402 import x402Client
from x402.http import decode_payment_response_header
from x402.http.clients import x402_httpx_transport
from x402.mechanisms.evm import EthAccountSignerWithRPC
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementEvmScheme,
    BatchSettlementEvmSchemeOptions,
    InMemoryClientChannelStorage,
)

load_dotenv()

RESOURCE_SERVER_URL = os.getenv("RESOURCE_SERVER_URL")
ENDPOINT_PATH = os.getenv("ENDPOINT_PATH", "/weather")
EVM_PRIVATE_KEY = os.getenv("EVM_PRIVATE_KEY")
EVM_RPC_URL = os.getenv("EVM_RPC_URL", "https://sepolia.base.org")
REQUEST_COUNT = int(os.getenv("REQUEST_COUNT", "3"))
REFUND_AFTER = os.getenv("REFUND_AFTER", "").lower() == "true"

if not (RESOURCE_SERVER_URL and EVM_PRIVATE_KEY):
    print("Missing required RESOURCE_SERVER_URL or EVM_PRIVATE_KEY")
    sys.exit(1)


async def main() -> None:
    account = Account.from_key(EVM_PRIVATE_KEY)
    signer = EthAccountSignerWithRPC(account, rpc_url=EVM_RPC_URL)
    print(f"Payer: {account.address}")

    batch_scheme = BatchSettlementEvmScheme(
        signer,
        BatchSettlementEvmSchemeOptions(
            storage=InMemoryClientChannelStorage(),
        ),
    )
    client = x402Client().register("eip155:*", batch_scheme)

    url = f"{RESOURCE_SERVER_URL}{ENDPOINT_PATH}"
    print(f"Issuing {REQUEST_COUNT} paid request(s) to {url}\n")

    timeout = httpx.Timeout(30.0, connect=10.0)
    async with httpx.AsyncClient(
        timeout=timeout, transport=x402_httpx_transport(client)
    ) as http:
        for i in range(REQUEST_COUNT):
            response = await http.get(url)
            payment_header = response.headers.get(
                "PAYMENT-RESPONSE"
            ) or response.headers.get("X-PAYMENT-RESPONSE")
            label = "deposit" if i == 0 else "voucher"
            print(f"[{i + 1}/{REQUEST_COUNT}] ({label}) status={response.status_code}")
            print(f"        body: {response.text}")
            if payment_header:
                settle = decode_payment_response_header(payment_header)
                print(f"        tx: {settle.transaction} success={settle.success}")
            print()

    if REFUND_AFTER:
        print("Issuing cooperative refund…")
        refund = await asyncio.to_thread(batch_scheme.refund, url)
        print(f"  refund success={refund.success} tx={refund.transaction}")


if __name__ == "__main__":
    asyncio.run(main())
