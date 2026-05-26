---
"x402-axios": minor
---

Fixed missing payment amount ceiling in the 402 response interceptor. Added a mandatory `maxValue` parameter (defaulting to 0.10 USDC) that is checked against the server-provided `maxAmountRequired` before any payment signature is produced. A server advertising an amount above `maxValue` now throws `"Payment amount exceeds maximum allowed"` instead of proceeding, matching the existing guard in `x402-fetch`.
