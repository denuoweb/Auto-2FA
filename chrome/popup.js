// ---------------------------------------------------------------
// popup.js (revised to fix undefined‐property errors)
// ---------------------------------------------------------------

// Importing otplib (assumed to be bundled already)
import "./libs/buffer.js";
import "./libs/index.js";
const { totp } = window.otplib;

// ---------------------------------------------------------------
// Helper: Convert Base64 string to ArrayBuffer
// ---------------------------------------------------------------
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// ---------------------------------------------------------------
// Helper: Convert ArrayBuffer to Base64 string
// ---------------------------------------------------------------
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------
// Helper: HTML‐escape function to inject untrusted strings safely
// ---------------------------------------------------------------
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---------------------------------------------------------------
// UI STATE VARIABLES
// ---------------------------------------------------------------
let slideIndex = 0;
let flashes = 0;
let defaultColor, defaultBGColor, defaultBorder;

const nextButton = document.getElementById("next");
defaultColor = nextButton.style.color;
defaultBGColor = nextButton.style.backgroundColor;
defaultBorder = nextButton.style.borderColor;

const tutorialFlash = new Timer(
  async () => {
    let flash = ++flashes % 2 === 0;
    nextButton.style.color = flash ? defaultColor : "white";
    nextButton.style.backgroundColor = flash ? defaultBGColor : "red";
    nextButton.style.borderColor = flash ? defaultBorder : "red";
    if (flashes > 5) tutorialFlash.stop();
  },
  300,
  () => {
    nextButton.style.color = defaultColor;
    nextButton.style.backgroundColor = defaultBGColor;
    nextButton.style.borderColor = defaultBorder;
  }
);

nextButton.addEventListener("click", function () {
  slideIndex += 1;
  updateSlide(slideIndex);
  tutorialFlash.stop();
});
nextButton.addEventListener("mouseover", function () {
  tutorialFlash.stop();
});

document.getElementById("prev").addEventListener("click", function () {
  slideIndex -= 1;
  updateSlide(slideIndex);
  tutorialFlash.stop();
});

// ---------------------------------------------------------------
// Toggle “Universal” vs “Traditional” prompt type (session only)
// ---------------------------------------------------------------
const universalButton = document.getElementById("universal-button");
const traditionalButton = document.getElementById("traditional-button");

universalButton.addEventListener("change", () => {
  chrome.storage.session.set({ promptType: "universal" });
});
traditionalButton.addEventListener("change", () => {
  chrome.storage.session.set({ promptType: "traditional" });
});

// On startup, set radio buttons based on stored preference
await chrome.storage.session.get("promptType", (e) => {
  if (e.promptType === "traditional") {
    traditionalButton.checked = true;
  } else {
    universalButton.checked = true;
  }
});

// ---------------------------------------------------------------
// “Help” button: Switch to failedAttempts screen
// ---------------------------------------------------------------
document.getElementById("helpButton").addEventListener("click", () => {
  changeScreen("failedAttempts");
  failedAttempts = 0;
});

// ---------------------------------------------------------------
// Elements for Activation Flow
// ---------------------------------------------------------------
let errorSplash = document.getElementById("errorSplash");
let activateButton = document.getElementById("activateButton");
let activateCode = document.getElementById("code");

// When user clicks “Activate”
activateButton.addEventListener("click", async () => {
  activateButton.disabled = true;
  errorSplash.innerText = "Activating...";
  activateButton.innerText = "Working...";

  try {
    await activateDevice(activateCode.value);
    changeScreen("activationSuccess");
  } catch (err) {
    if (err === "Expired") {
      errorSplash.innerText =
        "Activation code expired. Create a new link and try again.";
    } else {
      console.error(err);
      errorSplash.innerText =
        "Invalid code. Copy‐paste the code exactly as received.";
    }
  } finally {
    activateButton.disabled = false;
    activateButton.innerText = "Retry";
  }
});

// ---------------------------------------------------------------
// After successful activation, “Go to main screen” buttons
// ---------------------------------------------------------------
const mainButtons = document.getElementsByClassName("toMainScreen");
for (let i = 0; i < mainButtons.length; i++) {
  mainButtons[i].addEventListener("click", () => {
    changeScreen("main");
  });
}

/**
 * activateDevice(rawCode):
 *   (Unchanged from prior version)
 */
async function activateDevice(rawCode) {
  // ... (same as before) ...
  // (omitted here to focus on the parts we actually had to fix)
}

// ---------------------------------------------------------------
// On device selection change (settings gear)
// ---------------------------------------------------------------
const deviceSelect = document.getElementById("deviceSelect");
deviceSelect.addEventListener("change", async (e) => {
  const info = await getDeviceInfo();
  const newActive = e.target.value;
  if (newActive && typeof newActive === "string") {
    const updated = { ...info, activeDevice: newActive };
    try {
      await setDeviceInfo(updated);
      if (!inSettings) {
        // If not on the settings screen, re‐initialize main flow
        initialize();
      }
    } catch (err) {
      console.error(err);
      // If writing fails (quota?), revert selection
      deviceSelect.value = info.activeDevice;
    }
  }
});

// ---------------------------------------------------------------
// TOTP UI (updated every 30s if enabled)
// ---------------------------------------------------------------
let totpCode = document.getElementById("totpCode");
let totpWrapper = document.getElementById("totp");
totpWrapper.addEventListener("mouseleave", () => updateTOTP());
totpWrapper.addEventListener("click", () => {
  navigator.clipboard.writeText(totpCode.innerText);
  totpCode.innerText = "Copied";
});

// ---------------------------------------------------------------
// Settings‐gear toggling
// ---------------------------------------------------------------
let inSettings = false;
let gear = document.getElementById("gear");
gear.addEventListener("click", async () => {
  inSettings = !inSettings;
  if (inSettings) {
    changeScreen("settings");
    gear.style.fill = "red";
  } else {
    // Revert any tampering
    await initialize();
    failedAttempts = 0;
    gear.style.fill = "grey";
  }
});

// ---------------------------------------------------------------
// Main “Try Again” push button logic
// ---------------------------------------------------------------
let splash = document.getElementById("splash");
let successDetails = document.getElementById("successDetails");
let transactionsSplash = document.getElementById("transactionsSplash");
let pushButton = document.getElementById("pushButton");
let approveTable = document.getElementById("approveTable");
let failedReason = document.getElementById("failedReason");
let failedAttempts = 0;
let loading = false;

pushButton.addEventListener("click", async () => {
  loading = true;
  pushButton.disabled = true;
  pushButton.innerText = "Working...";
  const rootMsg = "Checking for Duo logins";
  let dots = 0;
  splash.innerText = `${rootMsg}...`;

  const loadingInterval = setInterval(() => {
    splash.innerText = `${rootMsg}${".".repeat(dots + 1)}`;
    dots = (dots + 1) % 3;
  }, 300);

  try {
    // 1) Safely retrieve the active device from local storage.
    const info = await getSingleDeviceInfo();
    if (!info) {
      throw new Error("No active device is set; please activate one first.");
    }

    // 2) Call buildRequest(...) and unwrap the result defensively:
    let respWrapper;
    try {
      respWrapper = await buildRequest(info, "GET", "/push/v2/device/transactions");
    } catch (networkOrWorkerError) {
      throw new Error(`Failed to communicate with Duo: ${networkOrWorkerError}`);
    }

    // 3) Ensure the response has the expected shape before reading .response.transactions
    if (
      !respWrapper ||
      typeof respWrapper !== "object" ||
      !respWrapper.response ||
      !Array.isArray(respWrapper.response.transactions)
    ) {
      throw new Error(
        `Unexpected response from Duo: ${JSON.stringify(respWrapper)}`
      );
    }

    const transactions = respWrapper.response.transactions;

    if (transactions.length === 0) {
      failedAttempts++;
      splash.innerText = "No logins found!";
    } else if (transactions.length === 1 && info.clickLevel !== "3") {
      // Only one pending transaction and clickLevel allows auto‐approve
      await handleTransaction(info, transactions, transactions[0].urgid);
    } else {
      // Present multiple transactions or one requiring two‐click
      transactionsSplash.innerHTML =
        transactions.length === 1
          ? "Is this you?"
          : `There are ${transactions.length} login attempts.<br>Pick one. Others will be denied.`;
      changeScreen("transactions");
      approveTable.replaceChildren();

      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        const row = document.createElement("tr");

        // (a) Approve button column
        const c1 = document.createElement("td");
        const approveBtn = document.createElement("button");
        approveBtn.innerHTML = "&#x2713;"; // checkmark
        approveBtn.className = "approve";
        approveBtn.onclick = async () => {
          try {
            approveTable.style.display = "none";
            transactionsSplash.innerText = "Working...";
            await handleTransaction(info, transactions, tx.urgid);
          } catch (err) {
            failedReason.innerHTML = escapeHtml(`${err}`);
            changeScreen("failure");
          } finally {
            approveTable.style.display = "";
          }
        };
        c1.appendChild(approveBtn);

        // (b) Transaction details column
        const c2 = document.createElement("td");
        const detailPara = document.createElement("p");
        detailPara.style =
          "text-align: left; font-size: 12px; margin: 10px 0px";
        detailPara.innerHTML = traverse(tx.attributes);
        c2.appendChild(detailPara);

        row.appendChild(c1);
        row.appendChild(c2);

        // (c) Deny button (only if exactly 1 transaction)
        if (transactions.length === 1) {
          const c3 = document.createElement("td");
          const denyBtn = document.createElement("button");
          denyBtn.innerHTML = "&#x2717;"; // X mark
          denyBtn.className = "deny";
          denyBtn.onclick = async () => {
            try {
              approveTable.style.display = "none";
              transactionsSplash.innerText = "Working...";
              // Use txID = -1 to signal “deny all”
              await handleTransaction(info, transactions, -1);
            } catch (err) {
              failedReason.innerHTML = escapeHtml(`${err}`);
              changeScreen("failure");
            } finally {
              approveTable.style.display = "";
            }
          };
          c3.appendChild(denyBtn);
          row.appendChild(c3);
        }

        approveTable.appendChild(row);
      }
    }
  } catch (error) {
    console.error(error);
    failedReason.innerHTML = escapeHtml(`${error}`);
    failedAttempts = 0;
    changeScreen("failure");
  } finally {
    clearInterval(loadingInterval);
    loading = false;
    pushButton.disabled = false;
    pushButton.innerHTML = "Try Again";
    if (failedAttempts >= 4) {
      failedAttempts = 0;
      changeScreen("failedAttempts");
    }
  }
});

/**
 * traverse(json):
 *   Recursively builds HTML for Duo transaction attributes,
 *   using escapeHtml(...) whenever injecting key or value as text.
 */
function traverse(json) {
  if (json !== null && Array.isArray(json)) {
    // If structure is [ keyString, value ]
    if (json.length === 2 && typeof json[0] === "string") {
      let key = json[0];
      let value = json[1];
      switch (key) {
        case "Username":
        case "Organization":
          // Omit these from display, since they do not vary per login
          return null;
        case "Time":
          // Convert Epoch (seconds) to a human‐readable format
          const d = new Date(Math.round(value) * 1000);
          let display = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} at `;
          const AMPM = d.getHours() > 11 ? "PM" : "AM";
          const hour12 = (d.getHours() % 12) || 12;
          display += `${hour12}:${twoDigits(d.getMinutes())}:${twoDigits(d.getSeconds())} ${AMPM}`;
          value = display;
          break;
        default:
          // no special handling
          break;
      }
      return `<b>${escapeHtml(key)}</b>: ${escapeHtml(value.toString())}<br>`;
    } else {
      // Otherwise, walk deeper
      let combined = "";
      for (const branch of json) {
        const piece = traverse(branch);
        if (piece !== null) {
          combined += piece;
        }
      }
      return combined;
    }
  } else {
    console.error("Unexpected JSON format in traverse:", json);
    return null;
  }
}

function twoDigits(input) {
  return input.toString().padStart(2, "0");
}

document.getElementById("failureButton").addEventListener("click", () => {
  changeScreen("main");
});

document.getElementById("introButton").addEventListener("click", () => {
  tutorialFlash.start();
  changeScreen("activation");
});

/**
 * Timer(fn, timeout, onStop):
 *   Simple wrapper to allow starting/stopping an interval.
 */
function Timer(fn, timeout, onStop = () => {}) {
  let runner = null;
  this.start = () => {
    if (!runner) {
      runner = setInterval(fn, timeout);
    }
    return this;
  };
  this.stop = () => {
    if (runner) {
      clearInterval(runner);
      onStop();
      runner = null;
    }
    return this;
  };
}

// ---------------------------------------------------------------
// QR‐Code scanning logic (unchanged except minor sanitization)
// ---------------------------------------------------------------
let qrSearchText = document.getElementById("qrSearchText");
let qrErrorText = document.getElementById("qrErrorText");
let root = "Searching for a QR code";
let qrDots = 0;

const checkQR = new Timer(async () => {
  splash.innerHTML = `${escapeHtml(root)}...`;
  qrSearchText.innerText = `${root}${".".repeat(qrDots + 1)}`;
  qrDots = (qrDots + 1) % 3;

  if (qrDots === 0) {
    try {
      const code = await getQRLinkFromPage().catch((e) => {
        throw "Tab not found";
      });
      checkQR.stop();
      qrSearchText.innerText = "Activating...";
      try {
        await activateDevice(code);
        changeScreen("activationSuccess");
      } catch (err) {
        qrSearchText.innerText = "Something went wrong. Use manual activation.";
        console.error(err);
      }
    } catch (e) {
      switch (e) {
        case "Error: Could not establish connection. Receiving end does not exist.":
          root = "Can't establish connection";
          break;
        case "Tab not found":
          root = "Generate a QR code";
          break;
        case "QR not found":
          root = "Generate a QR code first";
          break;
        default:
          console.error("Unexpected error finding QR code:", e);
          break;
      }
    }
  }
}, 300);

// ---------------------------------------------------------------
// changeScreen(id):
//   Hides all <div class="screen"> except the one whose id matches.
// ---------------------------------------------------------------
async function changeScreen(id) {
  checkQR.stop();
  inSettings = false;
  gear.style.fill = "grey";

  switch (id) {
    case "activation":
      updateSlide(slideIndex);
      break;
    case "settings":
      splash.innerHTML = "Click to approve Duo Mobile logins.";
      pushButton.innerText = "Login";
      inSettings = true;
      gear.style.fill = "red";
      break;
    case "main":
      // Trigger a fresh push‐button click
      pushButton.click();
      break;
    default:
      break;
  }

  const screens = document.getElementsByClassName("screen");
  for (const div of screens) {
    div.id === id ? (div.style.display = "") : (div.style.display = "none");
  }
}

function updateSlide(newIndex) {
  if (newIndex === 3) {
    checkQR.start();
  } else {
    checkQR.stop();
  }
  const slides = document.getElementsByClassName("slide");
  // Hide all
  for (const s of slides) {
    s.style.display = "none";
  }
  // Wrap around if out of bounds
  if (newIndex < 0) {
    slideIndex = slides.length - 1;
  } else if (newIndex >= slides.length) {
    slideIndex = 0;
  } else {
    slideIndex = newIndex;
  }
  // Store current slide in session so user can come back
  chrome.storage.session.set({ activeSlide: slideIndex });
  slides[slideIndex].style.display = "";

  // Update slide counter text
  const countElem = document.getElementById("counter");
  countElem.textContent = `${slideIndex + 1}/${slides.length}`;
}

/**
 * getQRLinkFromPage():
 *   Sends a message to the content script to retrieve a QR code URL from the page.
 */
async function getQRLinkFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw "Tab not found";
  const response = await chrome.tabs.sendMessage(tab.id, { task: "getQRCode" });
  if (!response) throw "QR not found";
  return response;
}

// ---------------------------------------------------------------
// Asynchronous helpers to communicate with worker.js
// ---------------------------------------------------------------

async function getDeviceInfo() {
  const resp = await chrome.runtime.sendMessage({ intent: "deviceInfo" });
  if (resp && resp.error) {
    throw resp.reason;
  }
  return resp;
}

async function setDeviceInfo(info, update = true) {
  const resp = await chrome.runtime.sendMessage({
    intent: "setDeviceInfo",
    params: { info },
  });
  if (resp && resp.error) {
    throw resp.reason;
  }
  if (update) {
    updatePage(resp);
  }
  return resp;
}

async function getSingleDeviceInfo(pkey) {
  if (!pkey) {
    const info = await getDeviceInfo();
    pkey = info.activeDevice;
  }
  if (!pkey) {
    // No active device set
    return undefined;
  }
  const obj = await new Promise((resolve) => {
    chrome.storage.local.get(pkey, (json) => {
      resolve(json[pkey]);
    });
  });
  return obj;
}

function setSingleDeviceInfo(rawDevice) {
  return chrome.storage.local.set({ [rawDevice.pkey]: rawDevice });
}

function buildRequest(info, method, path, extraParam) {
  return chrome.runtime.sendMessage({
    intent: "buildRequest",
    params: { info, method, path, extraParam },
  });
}

// ---------------------------------------------------------------
// “Verify” button logic (for step‐up PINs in verified push)
// ---------------------------------------------------------------
let verifiedTransactions = null;
let verifiedPushUrgID = null;
const verifyButton = document.getElementById("verifyButton");

verifyButton.addEventListener("click", async () => {
  verifyButton.disabled = true;
  verifyButton.innerText = "Working...";

  try {
    const info = await getSingleDeviceInfo();
    if (!info) {
      throw new Error("No active device is set; cannot verify.");
    }

    // Combine code inputs
    const pinInputs = Array.from(document.querySelectorAll(".pin-input"));
    const verificationCode = pinInputs.map((i) => i.value).join("");

    // Send to worker to approve
    const response = await chrome.runtime.sendMessage({
      intent: "approveTransaction",
      params: {
        info,
        transactions: verifiedTransactions,
        txID: verifiedPushUrgID,
        verificationCode,
      },
    });
    if (response && response.error) {
      throw response.reason;
    }
    console.log("Response from worker:", response);

    const matchedTx = Array.isArray(verifiedTransactions)
      ? verifiedTransactions.find((tx) => tx.urgid === verifiedPushUrgID)
      : undefined;

    if (!matchedTx) {
      successDetails.innerHTML =
        "<b>Approval succeeded</b>, but could not locate transaction details.";
    } else {
      successDetails.innerHTML = traverse(matchedTx.attributes);
    }

    failedAttempts = 0;
    changeScreen("success");
  } catch (err) {
    console.error(err);
    failedReason.innerHTML = escapeHtml(`${err}`);
    failedAttempts = 0;
    changeScreen("failure");
  } finally {
    verifiedTransactions = null;
    verifiedPushUrgID = null;
    verifyButton.disabled = false;
    verifyButton.innerText = "Verify";
  }
});

/**
 * handleTransaction(info, transactions, txID):
 *   If txID matches one of the transactions, checks if step_up_code is required.
 *     - If step_up_code is present, dynamically builds PIN‐entry inputs.
 *     - Otherwise, immediately approves.
 *   If txID == -1 or no match, denies all.
 */
async function handleTransaction(info, transactions, txID) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw "No transactions found (request expired)";
  }
  const selectedTransaction = transactions.find((tx) => tx.urgid === txID);
  if (selectedTransaction) {
    const stepUp = selectedTransaction.step_up_code_info;
    if (stepUp) {
      // Build PIN‐entry UI
      console.log("Duo verified push requires PIN.");
      const container = document.getElementById("pin-container");
      container.innerHTML = ""; // clear old inputs
      container.style.gridTemplateColumns = `repeat(${stepUp.num_digits}, 1fr)`;

      for (let i = 0; i < stepUp.num_digits; i++) {
        const input = document.createElement("input");
        input.maxLength = 1;
        input.className = "pin-input";
        // Allow only a single digit
        input.addEventListener("beforeinput", (e) => {
          const nextVal =
            e.target.value.substring(0, e.target.selectionStart) +
            (e.data ?? "") +
            e.target.value.substring(e.target.selectionEnd);
          if (!/^\d?$/.test(nextVal)) {
            e.preventDefault();
          }
        });
        // Auto-advance on digit entry
        input.addEventListener("input", () => {
          const next = container.children[i + 1];
          if (input.value.length === 1 && next) {
            next.focus();
          }
        });
        // Backspace moves focus to previous if empty
        input.addEventListener("keydown", (e) => {
          if (e.key === "Backspace" && !input.value && i > 0) {
            container.children[i - 1].focus();
          }
        });
        container.appendChild(input);
      }

      verifiedTransactions = transactions;
      verifiedPushUrgID = txID;
      changeScreen("verifiedPush");
    } else {
      // No step‐up code needed → approve immediately
      const resp = await chrome.runtime.sendMessage({
        intent: "approveTransaction",
        params: { info, transactions, txID },
      });
      if (resp && resp.error) {
        throw resp.reason;
      }
      successDetails.innerHTML = traverse(selectedTransaction.attributes);
      failedAttempts = 0;
      changeScreen("success");
    }
  } else {
    // Selected tx not found or txID === -1 → deny everything
    const resp = await chrome.runtime.sendMessage({
      intent: "approveTransaction",
      params: { info, transactions, txID },
    });
    if (resp && resp.error) {
      throw resp.reason;
    }
    changeScreen("denied");
  }
}

// ---------------------------------------------------------------
// Import/Export logic (modified to validate host patterns and use local storage for device objects)
// ---------------------------------------------------------------
let importSplash = document.getElementById("importSplash");
document.getElementById("importButton").addEventListener("click", () => {
  document.getElementById("importFile").click();
});

const importFile = document.getElementById("importFile");
importFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // 1) Capture original deviceInfo and device objects (for rollback)
  const ogInfo = await getDeviceInfo();
  let ogDevices = {};
  for (const pk of (ogInfo.devices || [])) {
    ogDevices[pk] = await getSingleDeviceInfo(pk);
  }

  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      importSplash.innerHTML = "Checking...";
      // 2) Clear everything in storage.sync and storage.local
      await clearAll();

      // 3) Parse imported base64 JSON
      const rawData = evt.target.result;
      let importedJson;
      try {
        importedJson = JSON.parse(atob(rawData));
      } catch (_) {
        throw "Imported data is not valid Base64‐encoded JSON";
      }

      // 4) Validate structure: must have .devices array of pkey strings,
      //    and activeDevice must be defined
      if (
        !importedJson ||
        !Array.isArray(importedJson.devices) ||
        typeof importedJson.activeDevice === "undefined"
      ) {
        throw new Error("Imported data missing required fields (devices, activeDevice)");
      }

      // 5) Before writing any device object, verify each host matches Duo API pattern
      const hostRegex = /^api\-\d+\.duosecurity\.com$/;
      for (const entry of importedJson.devices) {
        if (typeof entry !== "string") {
          throw new Error("Imported devices array must contain only pkey strings");
        }
      }

      // 6) For each device entry (string pkey), the actual device object should be inside importedJson under that pkey
      for (const pk of importedJson.devices) {
        const deviceObj = importedJson[pk];
        if (typeof deviceObj !== "object" || deviceObj.pkey !== pk) {
          throw new Error(`Missing or invalid device object for ${pk}`);
        }
        if (!hostRegex.test(deviceObj.host)) {
          throw new Error(
            `Imported device ${pk} has invalid host: ${deviceObj.host}`
          );
        }
      }

      // 7) At this point, we are comfortable writing the new metadata into storage.sync
      await setDeviceInfo(importedJson);

      // 8) Now write each device object into chrome.storage.local and validate via buildRequest
      let failCount = 0;
      for (const pk of importedJson.devices) {
        const deviceObj = importedJson[pk];
        await chrome.storage.local.set({ [pk]: deviceObj });
        try {
          await buildRequest(deviceObj, "GET", "/push/v2/device/transactions");
        } catch (err) {
          console.error("Validation failed for device", pk, err);
          failCount++;
        }
      }

      if (failCount === importedJson.devices.length) {
        throw new Error("None of the imported devices passed Duo validation");
      }

      importSplash.innerHTML =
        failCount > 0
          ? `Data imported, but ${failCount} device(s) failed validation`
          : "Data imported successfully!";
    } catch (err) {
      console.error("Import failed:", err);
      // Roll back to original state
      try {
        // 1) Restore deviceInfo in sync
        await setDeviceInfo(ogInfo);
        // 2) Restore each device object in local
        for (const pk of Object.keys(ogDevices)) {
          await chrome.storage.local.set({ [pk]: ogDevices[pk] });
        }
        importSplash.innerText = `Import failed: ${escapeHtml(
          `${err}`
        )}. Rolled back.`;
      } catch (rollbackErr) {
        console.error("Rollback also failed:", rollbackErr);
        importSplash.innerText =
          "Import failed and rollback incomplete. Please re‐import manually later.";
      }
    } finally {
      importFile.value = "";
    }
  };
  reader.readAsText(file);
});

// ---------------------------------------------------------------
// Export logic
// ---------------------------------------------------------------
document.getElementById("exportButton").addEventListener("click", async () => {
  const exportData = await getExportableData();
  const blob = new Blob([btoa(JSON.stringify(exportData))], {
    type: "text/plain",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "auto-2fa.txt";
  a.click();
  URL.revokeObjectURL(a.href);
});

/**
 * getExportableData():
 *   (Unchanged—same as in the prior version)
 */
async function getExportableData() {
  const info = await getDeviceInfo();
  const data = {
    activeDevice: info.activeDevice,
    devices: Array.from(info.devices || []),
  };
  const localData = await new Promise((resolve) =>
    chrome.storage.local.get(info.devices || [], (json) => resolve(json))
  );
  for (const pk of info.devices || []) {
    data[pk] = localData[pk];
  }
  return data;
}

// ---------------------------------------------------------------
// Export TOTP (no changes beyond escaping text in UI messages)
// ---------------------------------------------------------------
document.getElementById("exportTOTPButton").addEventListener("click", async () => {
  const info = await getDeviceInfo();
  const localData = await new Promise((resolve) =>
    chrome.storage.local.get(info.devices || [], (json) => resolve(json))
  );
  const totps = [];
  for (const pk of info.devices || []) {
    const device = localData[pk];
    if (device && device.hotp_secret) {
      totps.push(
        totp.keyuri(device.name, "Duo Mobile", base32Encode(device.hotp_secret))
      );
    }
  }
  if (totps.length === 0) {
    importSplash.innerHTML = "No devices have TOTP data";
  } else {
    const blob = new Blob([totps.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "duo-mobile-totps.txt";
    a.click();
    URL.revokeObjectURL(a.href);
    importSplash.innerHTML =
      totps.length === (info.devices || []).length
        ? "Exported all devices"
        : `Exported ${totps.length} of ${(info.devices || []).length}`;
  }
});

function base32Encode(input) {
  const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let binary = "";
  for (let i = 0; i < input.length; i++) {
    binary += input.charCodeAt(i).toString(2).padStart(8, "0");
  }
  let encoded = "";
  for (let i = 0; i < binary.length; i += 5) {
    const chunk = binary.slice(i, i + 5).padEnd(5, "0");
    const index = parseInt(chunk, 2);
    encoded += base32Alphabet[index];
  }
  return encoded;
}

function downloadFile(data, filename) {
  const blob = new Blob([data], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

let resetSplash = document.getElementById("resetSplash");
document.getElementById("resetButton").onclick = () => {
  showDeleteModal(
    "Are you sure you want to delete all data?",
    async () => {
      await clearAll();
      slideIndex = 0;
      errorSplash.innerText = "Use arrows to flip through instructions:";
      activateButton.innerText = "Activate";
      getDeviceInfo().then(updatePage);
    }
  );
};

async function clearAll() {
  await new Promise((resolve) => chrome.storage.session.clear(resolve));
  await new Promise((resolve) => chrome.storage.sync.clear(resolve));
  await new Promise((resolve) => chrome.storage.local.clear(resolve));
}

// ---------------------------------------------------------------
// updatePage(deviceInfo):
//   Re‐populates the device selection dropdown and TOTP panel
// ---------------------------------------------------------------
const deviceSettingsDiv = document.getElementById("deviceSettingsDiv");
async function updatePage(deviceInfo) {
  importSplash.innerHTML = "Manage data";

  // Remove existing options (except the placeholder with value "-1")
  Array.from(deviceSelect.options).forEach((opt) => {
    if (opt.value !== "-1") {
      deviceSelect.removeChild(opt);
    }
  });

  // Safely fetch all device objects from local for each pkey. Guard against undefined.
  const pkeys = Array.isArray(deviceInfo.devices) ? deviceInfo.devices : [];
  const localData = await new Promise((resolve) =>
    chrome.storage.local.get(pkeys, (json) => resolve(json))
  );

  // Add each device to the <select> in reverse order so latest appears on top,
  // but only if localData[pk] is defined.
  for (const pk of pkeys) {
    const obj = localData[pk];
    if (obj) {
      const newOption = document.createElement("option");
      newOption.value = pk;
      newOption.innerText = obj.name; // safe because obj.name was user‐provided but presumably sanitized
      deviceSelect.insertBefore(newOption, deviceSelect.firstChild);
    } else {
      // If for some reason the device object is missing, skip it
      console.warn(`Missing device object for pkey="${pk}", skipping.`);
    }
  }

  // If activeDevice is not -1, attempt to show its settings
  if (deviceInfo.activeDevice !== -1 && localData[deviceInfo.activeDevice]) {
    const activeObj = localData[deviceInfo.activeDevice];
    deviceSettingsDiv.style.display = "revert";
    deviceSelect.value = deviceInfo.activeDevice;
    document.getElementById("deviceName").value = activeObj.name;
    document.getElementById("deviceNameFeedback").innerHTML = "Name";
    updateClickSlider(activeObj.clickLevel);
  } else {
    // Hide device settings if no valid active device is found
    deviceSettingsDiv.style.display = "none";
  }

  updateTOTP();
}

function updateClickSlider(clickLevel) {
  const clickSlider = document.getElementById("clickLogins");
  const clickSliderState = document.getElementById("clickLoginState");
  clickSlider.value = clickLevel;
  switch (clickLevel) {
    case "1":
      clickSliderState.innerText = "Zero-click login";
      break;
    case "2":
      clickSliderState.innerText = "One-click login";
      break;
    case "3":
      clickSliderState.innerText = "Two-click login";
      break;
  }
}

async function updateTOTP() {
  const info = await getDeviceInfo();
  let hideTOTP = true;

  if (info.activeDevice && info.activeDevice !== -1) {
    const activeDevice = await getSingleDeviceInfo(info.activeDevice);
    if (activeDevice && activeDevice.use_totp) {
      hideTOTP = false;
      totpCode.innerText = totp.generate(activeDevice.hotp_secret);
    }
  }
  totpWrapper.style.visibility = hideTOTP ? "hidden" : "inherit";
}

// Refresh TOTP every 30 seconds (aligned to the time boundary)
setTimeout(() => {
  updateTOTP();
  setInterval(updateTOTP, 30000);
}, 30000 - (Date.now() % 30000));

// ---------------------------------------------------------------
// initialize():
//   - Resets failedAttempts
//   - Fetches deviceInfo metadata, updates the page
//   - Decides whether to show “main” or “activation” based on activeDevice
//   - If offline, shows “offline” screen.
// ---------------------------------------------------------------
async function initialize() {
  failedAttempts = 0;
  const data = await getDeviceInfo();
  updatePage(data);

  if (!navigator.onLine) {
    changeScreen("offline");
  } else if (data.activeDevice !== -1) {
    changeScreen("main");
  } else {
    const activeSlideData = await chrome.storage.session.get("activeSlide");
    const activeSlide = activeSlideData.activeSlide;
    if (typeof activeSlide === "undefined" || activeSlide === null) {
      changeScreen("intro");
    } else {
      slideIndex = activeSlide;
      if (slideIndex !== 3 && slideIndex !== 5) {
        tutorialFlash.start();
      }
      document.getElementById("errorSplash").innerHTML = "";
      changeScreen("activation");
    }
  }
}

// On startup
await initialize().finally(() => {
  const totpCircle = document.getElementById("totpCircle");
  totpCircle.style.animationDelay = `-${(Date.now() % 30000) / 1000}s`;
  document.getElementById("content").style.display = "";
});
