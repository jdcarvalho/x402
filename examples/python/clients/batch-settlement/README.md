# x402 Batch-Settlement httpx Client Example

An async httpx client that pays for a batch-settlement-protected resource
multiple times in a row. The first request opens an on-chain channel via a
USDC deposit; subsequent requests are served by off-chain vouchers signed
against that same channel. Optionally, the client issues a cooperative refund
at the end to claw back any unused channel balance.

## Setup

```bash
uv sync
```

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `RESOURCE_SERVER_URL` | yes | Base URL of the resource server (e.g. `http://localhost:4021`). |
| `ENDPOINT_PATH` | no | Path of the protected resource (default `/weather`). |
| `EVM_PRIVATE_KEY` | yes | Client (payer) private key. |
| `EVM_RPC_URL` | no | Defaults to `https://sepolia.base.org`. |
| `REQUEST_COUNT` | no | Number of paid requests to issue (default `3`). |
| `REFUND_AFTER` | no | Set to `true` to issue a cooperative refund at the end. |

## Run

```bash
uv run python main.py
```
