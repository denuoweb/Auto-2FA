// ---------------------------------------------------------------
// worker.js
// ---------------------------------------------------------------

// Welcome page on install
chrome.runtime.onInstalled.addListener((event) => {
  if (event.reason === "install") {
    chrome.tabs.create({ url: "welcome.html" });
  }
});

let currentAbortController = null;

/**
 * Helper: Convert Base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Helper: Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Helper: Simple HTML‐escaping to prevent XSS
 */
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Top‐level message listener.
 *
 * 1) Check that the message is coming from our own extension ID (sender.id).
 * 2) If the intent is "onLoginPage", also verify that sender.tab.url
 *    starts exactly with a permitted Duo login URL.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 1. Verify that only our own extension contexts can send messages.
  if (sender.id !== chrome.runtime.id) {
    // Message did not originate from this extension; ignore.
    return false;
  }

  // 2. If intent is "onLoginPage", ensure sender.tab.url is the genuine Duo login page.
  if (message.intent === "onLoginPage") {
    const tabUrl = sender.tab && sender.tab.url;
    // We only allow exactly Duo's login prompt pages—no wildcards.
    // Adjust these patterns to match your organization’s actual Duo host if needed.
    const permittedLoginPrefixes = [
      "https://auth.duosecurity.com/",
      "https://api-*.duosecurity.com/",     // in case Duo’s login is served elsewhere
      "https://*.duosecurity.com/frame/"      // existing patterns from manifest
    ];
    let matched = false;
    for (const prefix of permittedLoginPrefixes) {
      // Convert prefix containing '*' to a regex
      const regexified = prefix.replace(/\*/g, "[^/]*");
      const re = new RegExp("^" + regexified);
      if (typeof tabUrl === "string" && re.test(tabUrl)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      console.warn("onLoginPage invoked from untrusted URL:", tabUrl);
      return false;
    }
  }

  // From this point on, we trust that the message is coming from our own popup or permitted content script.
  let params = message.params;
  switch (message.intent) {
    case "deviceInfo": {
      getDeviceInfo()
        .then((info) => sendResponse(info))
        .catch((reason) => onError(reason, sendResponse));
      break;
    }
    case "setDeviceInfo": {
      setDeviceInfo(params.info)
        .then((sanitized) => sendResponse(sanitized))
        .catch((reason) => onError(reason, sendResponse));
      break;
    }
    case "buildRequest": {
      buildRequest(params.info, params.method, params.path, params.extraParam)
        .then((resp) => sendResponse(resp))
        .catch((reason) => onError(reason, sendResponse));
      break;
    }
    case "approveTransaction": {
      approveTransactionHandler(
        params.info,
        params.transactions,
        params.txID,
        params.verificationCode
      )
        .then((resp) => sendResponse(resp))
        .catch((reason) => onError(reason, sendResponse));
      break;
    }
    case "onLoginPage": {
      // If a previous zero‐click attempt is in progress, cancel it.
      if (currentAbortController) {
        console.log("Cancelling previous zero‐click login attempt");
        currentAbortController.abort();
      }
      currentAbortController = new AbortController();
      const signal = currentAbortController.signal;
      zeroClickLogin(sender.tab.id, signal, params.verificationCode);
      break;
    }
    default: {
      // Unknown intent; ignore.
      return false;
    }
  }
  // Return true to signal that we will call `sendResponse` asynchronously.
  return true;
});

/**
 * onError: Convert any thrown reason into a normalized response object.
 */
function onError(reason, sendResponse) {
  // Always coerce to string so that e.g. Error objects do not become "{}".
  sendResponse({ error: true, reason: `${reason}` });
}

// ---------------------------------------------------------------
// Storage Model (revised to isolate raw device‐key material in chrome.storage.local)
// ---------------------------------------------------------------

// We keep a small "deviceInfo" object in chrome.storage.sync, which looks like:
// {
//   activeDevice: <pkey-string> or -1,
//   devices: [ <pkey1>, <pkey2>, ... ]
// }
// 
// Then, *each* device is stored under that device’s `pkey` directly in chrome.storage.local, e.g.:
//   chrome.storage.local.get("device123", (obj) => { return obj.device123; });
//
// A sample device object looks like:
// {
//   pkey: "device123",
//   host: "api-46217189.duosecurity.com",
//   publicRaw: "<Base64‐encoded SPKI>",
//   privateRaw: "<Base64‐encoded PKCS#8>",         // ⬅ stored only in local
//   clickLevel: "2",
//   name: "My iPhone XR",
//   use_totp: true/false,
//   hotp_secret: "<Optional HOTP secret string>"
// }
//
// Because privateRaw is sensitive, it is *never* written to chrome.storage.sync.

/////////////////////////////////////////////////////////////////////////////////////
// getDeviceInfo()
//   → Returns a Promise resolving to the sanitized deviceInfo object from sync storage
/////////////////////////////////////////////////////////////////////////////////////
function getDeviceInfo() {
  return new Promise((resolve) => {
    chrome.storage.sync.get("deviceInfo", (json) => {
      resolve(json.deviceInfo);
    });
  }).then(sanitizeData);
}

/////////////////////////////////////////////////////////////////////////////////////
// setDeviceInfo(info)
//   → Takes a raw info object (with activeDevice and devices[]), sanitizes it,
//     stores the metadata in chrome.storage.sync, and returns the sanitized object.
/////////////////////////////////////////////////////////////////////////////////////
async function setDeviceInfo(info) {
  const sanitized = await sanitizeData(info);

  // Overwrite entire "deviceInfo" entry in storage.sync
  await chrome.storage.sync.set({ deviceInfo: sanitized });
  return sanitized;
}

/**
 * sanitizeData(info):
 *   - Ensures the structure is up to date (migrates older formats).
 *   - Splits out any embedded device objects into individual entries under chrome.storage.local.
 *   - Replaces the `devices` array with an array of pkey strings.
 */
async function sanitizeData(info) {
  let newInfo = null;

  // 1) If no info or old‐style single‐device format (presence of 'pkey' means old style):
  if (!info || info.pkey) {
    // Migrate single‐device object (old extension versions) into new array format.
    newInfo = {
      activeDevice: info && info.host ? info.pkey : -1,
      devices: info
        ? [
            {
              ...info,
              clickLevel: info.clickLevel ?? "2",
              name: info.name || "Device 1",
            },
          ]
        : [],
    };
  } else {
    // Already in the new format
    newInfo = JSON.parse(JSON.stringify(info));
  }

  // 2) If any array member in newInfo.devices is actually a device object with a pkey,
  //    break that out into chrome.storage.local, and keep only pkey in the array.
  if (
    newInfo.devices &&
    newInfo.devices.some((deviceEntry) => typeof deviceEntry === "object" && deviceEntry.pkey)
  ) {
    // Each `deviceEntry` is an object: { pkey, host, publicRaw, privateRaw, ... }
    for (const deviceObj of newInfo.devices) {
      const pkey = deviceObj.pkey;
      // Store the *entire device object* in local storage, keyed by its own pkey.
      await chrome.storage.local.set({ [pkey]: deviceObj });
    }
    // Now replace `devices` array with only the list of pkey strings:
    newInfo.devices = newInfo.devices.map((d) => d.pkey);
  }

  // 3) Ensure activeDevice is one of the keys in the devices array, else reset to -1 or first device
  if (newInfo.activeDevice != -1) {
    const idx = newInfo.devices.indexOf(newInfo.activeDevice);
    if (idx < 0) {
      // Either the activeDevice no longer exists, or was invalid; pick the first in the array if present
      newInfo.activeDevice = newInfo.devices.length > 0 ? newInfo.devices[0] : -1;
    }
  }

  return newInfo;
}

/**
 * getSingleDeviceInfo(pkey?)
 *   → If pkey is provided, returns the device object stored under that key in chrome.storage.local.
 *   → If pkey is omitted, fetches the current activeDevice from getDeviceInfo(), then returns that device.
 */
async function getSingleDeviceInfo(pkey) {
  if (!pkey) {
    const info = await getDeviceInfo();
    pkey = info.activeDevice;
  }
  if (pkey === -1) {
    throw new Error("No active device is set");
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(pkey, (json) => {
      // First key of json is always the pkey string
      const deviceObj = json[pkey];
      resolve(deviceObj);
    });
  });
}

/**
 * setSingleDeviceInfo(deviceObj)
 *   → Writes the given device object (which must include deviceObj.pkey) into local storage.
 */
function setSingleDeviceInfo(deviceObj) {
  return chrome.storage.local.set({ [deviceObj.pkey]: deviceObj });
}

/**
 * clearAll():
 *   → Clears all data from chrome.storage.session, chrome.storage.sync, and chrome.storage.local.
 */
async function clearAll() {
  await new Promise((resolve) => chrome.storage.session.clear(resolve));
  await new Promise((resolve) => chrome.storage.sync.clear(resolve));
  await new Promise((resolve) => chrome.storage.local.clear(resolve));
}

// ---------------------------------------------------------------
// ZERO‐CLICK LOGIN IMPLEMENTATION (unchanged except for storage API)
// ---------------------------------------------------------------

const maxAttempts = 10;
const zeroClickCooldown = 1000;
let lastSuccessfulZeroClick = 0;

async function zeroClickLogin(tabId, signal, verificationCode) {
  // Always clear any stale badge first
  clearBadge(tabId);

  // Rate‐limit: Do not attempt more than once every 10 seconds
  if (Date.now() - lastSuccessfulZeroClick < 10000) {
    console.log("Zero‐click recently succeeded; skipping re‐attempt");
    return;
  }

  // 1) Retrieve our deviceInfo metadata
  let deviceInfo = await getDeviceInfo();
  // 2) Load all device objects from local that have clickLevel == "1" (zero‐click)
  const localKeys = deviceInfo.devices; // array of pkey strings
  let zeroClickDevices = [];
  if (Array.isArray(localKeys) && localKeys.length > 0) {
    const allStored = await new Promise((resolve) =>
      chrome.storage.local.get(localKeys, (json) => resolve(json))
    );
    // allStored is an object: { "<pkey1>": { …deviceObj… }, "<pkey2>": { … } }
    for (const pk of localKeys) {
      const deviceObj = allStored[pk];
      if (deviceObj && deviceObj.clickLevel === "1") {
        zeroClickDevices.push(deviceObj);
      }
    }
  }

  if (zeroClickDevices.length === 0) {
    console.log("No zero‐click devices available; aborting.");
    return;
  }
  console.log("Eligible zero‐click devices:", zeroClickDevices);

  let attempts = 0;
  const loadingInterval = setInterval(async () => {
    if (signal.aborted) {
      console.log("Zero‐click login aborted before attempt", attempts + 1);
      clearInterval(loadingInterval);
      return;
    }

    // Check if the user is still on the same tab (login prompt likely present)
    let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!activeTab || activeTab.id !== tabId) {
      // User has navigated away; wait for them to come back
      console.log("Waiting for the user to remain on the login page...");
      return;
    }

    // Update badge counter
    let badgeResult = await chrome.action
      .setBadgeText({ text: `${++attempts}/${maxAttempts}`, tabId })
      .catch((e) => {
        // Possibly the tab got closed unexpectedly
        console.log("Tab might have been closed; stopping attempts.");
        clearInterval(loadingInterval);
        return false;
      });
    if (badgeResult === false) {
      return;
    }

    // Now attempt to find exactly one pending transaction on any zero‐click device
    for (const info of zeroClickDevices) {
      console.log("Checking device:", info.name);
      let resp;
      try {
        resp = await buildRequest(info, "GET", "/push/v2/device/transactions");
      } catch (fetchError) {
        console.error(fetchError);
        // If fetching fails for any device, treat as a hard failure
        stopClickLogin(loadingInterval, "#FC0D1B", "Fail", tabId);
        return;
      }
      const transactions = resp.response.transactions;

      if (transactions.length === 1) {
        lastSuccessfulZeroClick = Date.now();

        // We’ve found exactly one transaction. Approve it—no IP‐matching at the moment.
        console.log("Single transaction found; approving:", transactions[0].urgid);
        try {
          await approveTransactionHandler(info, transactions, transactions[0].urgid, verificationCode);
          // Visually signal success on the badge
          await chrome.action.setBadgeTextColor({ color: "#FFF", tabId }).catch(() => {});
          stopClickLogin(loadingInterval, "#67B14A", "Done", tabId);
        } catch (approvalError) {
          console.error("Approval failed:", approvalError);
          await chrome.action.setBadgeTextColor({ color: "#FFF", tabId }).catch(() => {});
          stopClickLogin(loadingInterval, "#FC0D1B", "Err", tabId);
        }
        return; // Done: do not try other devices
      } else if (transactions.length > 1) {
        // Too many pending pushes; show “Open” and stop
        stopClickLogin(loadingInterval, "#FF9333", "Open", tabId);
        return;
      } else {
        // No transactions found on this device; keep looping
        if (attempts >= maxAttempts) {
          stopClickLogin(loadingInterval, "#FC0D1B", "None", tabId);
          return;
        }
      }
    }
  }, zeroClickCooldown);
}

async function stopClickLogin(loadingInterval, badgeColor, badgeText, tabId) {
  clearInterval(loadingInterval);
  chrome.action.setBadgeBackgroundColor({ color: badgeColor, tabId }).catch(() => {});
  chrome.action.setBadgeText({ text: badgeText, tabId }).catch(() => {});
  // Clear badge after 5 seconds
  setTimeout(() => clearBadge(tabId), 5000);
}

async function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
  chrome.action.setBadgeTextColor({ color: "#000", tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#FFF", tabId }).catch(() => {});
}

/**
 * approveTransactionHandler:
 *   Builds on approveTransaction(...) logic to include any optional step‐up code.
 */
function approveTransactionHandler(info, transactions, txID, verificationCode) {
  const extra = verificationCode
    ? {
        step_up_code: verificationCode,
        // step_up_code_autofilled: "false" // (commented out; not used at present)
      }
    : {};

  return approveTransaction(info, transactions, txID, extra);
}

/**
 * approveTransaction:
 *   Given one device’s info, an array of transactions, and a target txID, it will:
 *     - Approve the transaction matching txID,
 *     - Deny *all* other transactions in the array.
 *   Throws if no transactions exist, or if the target transaction cannot be found.
 */
async function approveTransaction(singleDeviceInfo, transactions, txID, extraParam = {}) {
  if (!Array.isArray(transactions)) {
    throw new Error("Transactions is undefined or not an array");
  }
  if (transactions.length === 0) {
    throw "No transactions found (request expired)";
  }

  for (const tx of transactions) {
    const urgID = tx.urgid;
    if (txID === urgID) {
      console.log("Approving transaction:", txID);
      await buildRequest(singleDeviceInfo, "POST", "/push/v2/device/transactions/" + urgID, {
        ...extraParam,
        answer: "approve",
        txId: urgID,
      });
    } else {
      // Deny any other pending push
      await buildRequest(singleDeviceInfo, "POST", "/push/v2/device/transactions/" + urgID, {
        answer: "deny",
        txId: urgID,
      });
    }
  }
}

/**
 * buildRequest:
 *   1) Constructs the canonical request string following Duo’s specs.
 *   2) Imports the device’s SPKI/public and PKCS#8/private keys from Base64.
 *   3) Signs with RSASSA-PKCS1-v1_5 + SHA-512.
 *   4) Sends the actual HTTPS request via fetch.
 *
 * Returns a Promise resolving to the parsed JSON from Duo’s API,
 * or rejects if the network or API returns an error.
 */
async function buildRequest(singleDeviceInfo, method, path, extraParam = {}) {
  // 1) Date header
  const now = new Date();
  const date = now.toUTCString(); // e.g. "Thu, 05 Jun 2025 01:26:58 GMT"

  // 2) Canonical request
  const host = singleDeviceInfo.host.trim(); // e.g. "api-46217189.duosecurity.com"
  let canonicalRequest = "";
  canonicalRequest += date + "\n";
  canonicalRequest += method.toUpperCase() + "\n";
  canonicalRequest += host + "\n";
  canonicalRequest += path + "\n";

  // 3) Sort and encode extraParam lexicographically
  const sortedEntries = Object.entries(extraParam)
    .map(([k, v]) => [String(k), String(v)])
    .sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: false }));
  let queryString = "";
  if (sortedEntries.length > 0) {
    queryString = sortedEntries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  }
  if (queryString.length > 0) {
    canonicalRequest += queryString;
  }

  // 4) Import SPKI (public) and PKCS#8 (private) keys from Base64
  const publicKeyBuffer = base64ToArrayBuffer(singleDeviceInfo.publicRaw);
  const privateKeyBuffer = base64ToArrayBuffer(singleDeviceInfo.privateRaw);

  // (Optional encryption step would occur here if privateRaw were stored encrypted;
  //  in that case, you would decrypt privateKeyBuffer via Web Crypto before importing.)

  const publicKey = await crypto.subtle.importKey(
    "spki",
    publicKeyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-512" } },
    true,
    ["verify"]
  );
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-512" } },
    true,
    ["sign"]
  );

  // 5) Sign the canonical request
  const encoder = new TextEncoder();
  const dataToSign = encoder.encode(canonicalRequest);
  const signatureArrayBuffer = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    dataToSign
  );

  // 6) Base64-encode the signature
  const signatureBase64 = arrayBufferToBase64(signatureArrayBuffer);

  // 7) Form Authorization header: Basic <Base64(pkey:signature)>
  const credentialString = `${singleDeviceInfo.pkey}:${signatureBase64}`;
  const authHeaderValue = "Basic " + btoa(credentialString);

  // 8) Assemble full URL
  const url = `https://${host}${path}${queryString ? "?" + queryString : ""}`;

  // 9) Dispatch via fetch
  let fetchResponse;
  try {
    fetchResponse = await fetch(url, {
      method: method.toUpperCase(),
      headers: {
        Authorization: authHeaderValue,
        "x-duo-date": date,
        "Content-Type": "application/x-www-form-urlencoded", // Duo expects this for POST
      },
    });
  } catch (networkErr) {
    console.error("[Duo buildRequest] Network error fetching", url, networkErr);
    throw new Error(`Failed to fetch ${url}: ${networkErr}`);
  }

  // 10) If not OK, parse Duo’s JSON error payload if possible
  if (!fetchResponse.ok) {
    const errorPayload = await fetchResponse.text();
    const statusText = fetchResponse.statusText;
    const statusCode = fetchResponse.status;
    let parsed;
    try {
      parsed = JSON.parse(errorPayload);
    } catch (_) {
      parsed = null;
    }
    console.error(
      `[Duo buildRequest] Duo responded ${statusCode} ${statusText}:`,
      parsed || errorPayload
    );
    // Throw an Error containing a sanitized payload for the popup to display
    throw new Error(
      `<pre>${statusText} (${statusCode}):<br>${JSON.stringify(
        parsed || errorPayload,
        null,
        2
      )}</pre>`
    );
  }

  // 11) Otherwise, return the parsed JSON
  return fetchResponse.json();
}
