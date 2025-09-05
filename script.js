// script.js - robust, persist QR to sessionStorage, disable inputs after success

const unlockBtn = document.getElementById("unlockBtn");
const uploadSection = document.getElementById("uploaderSection");
const apikeyInput = document.getElementById("apikey");
const uploadBtn = document.getElementById("uploadBtn");
const resultDiv = document.getElementById("result");
const keyMessage = document.getElementById("keyMessage");

let API_KEY = null;

// restore persistent upload result if present in sessionStorage
function restoreResultIfAny() {
  try {
    const saved = sessionStorage.getItem("wipe_last_result");
    if (!saved) return false;
    const data = JSON.parse(saved);
    // show QR + links
    showResult(data);
    // disable upload controls so user doesn't re-upload accidentally
    disableUploadControls();
    return true;
  } catch (e) {
    console.warn("restoreResultIfAny failed", e);
    return false;
  }
}

function disableUploadControls() {
  const fileInput = document.getElementById("report");
  if (fileInput) fileInput.disabled = true;
  if (uploadBtn) uploadBtn.disabled = true;
}

function enableUploadControls() {
  const fileInput = document.getElementById("report");
  if (fileInput) fileInput.disabled = false;
  if (uploadBtn) uploadBtn.disabled = false;
}

function showResult(data) {
  resultDiv.innerHTML = "";
  const img = document.createElement("img");
  img.src = data.qrUrl;
  img.alt = "QR code";
  img.style.maxWidth = "320px";
  img.style.display = "block";
  img.style.margin = "12px auto";

  const link = document.createElement("a");
  link.href = data.verifyUrl;
  link.textContent = "Open verification page";
  link.target = "_blank";
  link.className = "primary";
  link.style.display = "inline-block";
  link.style.margin = "6px";
  link.style.padding = "8px 10px";
  link.style.color = "#022";
  link.style.textDecoration = "none";

  const certLink = document.createElement("a");
  certLink.href = data.certificateUrl;
  certLink.target = "_blank";
  certLink.textContent = "Download signed certificate (PDF)";
  certLink.className = "primary";
  certLink.style.marginLeft = "8px";
  certLink.style.padding = "8px 10px";
  certLink.style.color = "#022";
  certLink.style.textDecoration = "none";

  resultDiv.appendChild(img);
  resultDiv.appendChild(link);
  resultDiv.appendChild(certLink);
}

// hide any existing ephemeral messages, keep QR visible
function clearEphemeral() {
  // do not clear resultDiv if QR present in sessionStorage
  // but clear any temporary status messages
  const temp = document.getElementById("tempStatus");
  if (temp) temp.remove();
}

// initial restore
if (restoreResultIfAny()) {
  // if a previous successful result exists, show uploader as unlocked state too
  API_KEY = sessionStorage.getItem("wipe_api_key") || null;
  if (API_KEY) {
    apikeyInput.disabled = true;
    unlockBtn.disabled = true;
    unlockBtn.textContent = "Unlocked";
    keyMessage.textContent = "Unlocked (previous session)";
    uploadSection.style.display = "block";
  }
}

// --- add near the top with other element refs ---
const resetBtn = document.getElementById("resetBtn");

// show/hide reset button helper
function showResetButton(show = true) {
  if (!resetBtn) return;
  resetBtn.style.display = show ? "inline-block" : "none";
}

// call this when upload succeeds to show Reset
function onUploadSuccessShowReset() {
  showResetButton(true);
}

// reset/ logout function: clears session, re-enables UI
function resetApp() {
  // clear stored things
  try {
    sessionStorage.removeItem("wipe_api_key");
    sessionStorage.removeItem("wipe_last_result");
  } catch (e) {
    console.warn("Couldn't clear sessionStorage", e);
  }

  // clear UI: hide result, hide uploader, re-enable login input
  resultDiv.innerHTML = "";
  uploadSection.style.display = "none";

  // re-enable inputs
  apikeyInput.disabled = false;
  apikeyInput.value = "";
  unlockBtn.disabled = false;
  unlockBtn.textContent = "Unlock Upload";

  // re-enable upload controls and clear file input
  enableUploadControls();
  const fileInput = document.getElementById("report");
  if (fileInput) {
    fileInput.value = ""; // clear selected file
    fileInput.disabled = false;
  }

  // hide reset button
  showResetButton(false);

  // clear messages
  if (keyMessage) {
    keyMessage.textContent = "";
    keyMessage.style.color = "";
  }

  // clear API_KEY in memory
  API_KEY = null;
}

// wire reset button
if (resetBtn) {
  resetBtn.addEventListener("click", (e) => {
    e.preventDefault();
    resetApp();
  });
}


// Unlock handler (validate key)
unlockBtn.addEventListener("click", async (ev) => {
  ev?.preventDefault();
  clearEphemeral();

  const key = apikeyInput.value.trim();
  if (!key) return alert("Enter API Key");

  try {
    unlockBtn.disabled = true;
    unlockBtn.textContent = "Checking...";
    const res = await fetch("http://localhost:3000/validate-key", {
      method: "POST",
      headers: { "x-api-key": key }
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      unlockBtn.disabled = false;
      unlockBtn.textContent = "Unlock Upload";
      keyMessage.textContent = body.error || "Invalid API key";
      keyMessage.style.color = "#ff8080";
      return;
    }

    API_KEY = key;
    // store api key in sessionStorage (safer than localStorage for dev)
    sessionStorage.setItem("wipe_api_key", key);

    apikeyInput.disabled = true;
    apikeyInput.value = "••••••••";
    unlockBtn.disabled = true;
    unlockBtn.textContent = "Unlocked";
    keyMessage.textContent = "Unlocked";
    keyMessage.style.color = "#7ef9a6";
    uploadSection.style.display = "block";
  } catch (err) {
    console.error("Key validation failed", err);
    unlockBtn.disabled = false;
    unlockBtn.textContent = "Unlock Upload";
    keyMessage.textContent = "Network error validating key";
    keyMessage.style.color = "#ff8080";
  }
});

// Upload handler
uploadBtn.addEventListener("click", async (ev) => {
  ev?.preventDefault();
  clearEphemeral();

  if (!API_KEY) return alert("Unlock with API key first");
  const fileInput = document.getElementById("report");
  if (!fileInput.files || !fileInput.files[0]) return alert("Choose a PDF file");
  const file = fileInput.files[0];
  if (file.type !== "application/pdf") return alert("Please select a PDF");

  // UI: show uploading status but don't touch resultDiv if QR already shown
  const temp = document.createElement("div");
  temp.id = "tempStatus";
  temp.textContent = "Uploading...";
  temp.style.color = "#86a5b2";
  temp.style.marginTop = "8px";
  resultDiv.appendChild(temp);

  const fd = new FormData();
  fd.append("report", file);
  const deviceVal = document.getElementById("device")?.value;
  if (deviceVal) fd.append("device", deviceVal);

  try {
    const res = await fetch("http://localhost:3000/upload", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: fd
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => `Server responded ${res.status}`);
      throw new Error(txt || `Server responded ${res.status}`);
    }

    const data = await res.json();

    // persist result in sessionStorage so QR remains even on accidental reload
    sessionStorage.setItem("wipe_last_result", JSON.stringify(data));

    // show QR + links
    showResult(data);
    // after showResult(data) and sessionStorage.setItem(...)
    onUploadSuccessShowReset();

    // disable upload controls to avoid reupload
    disableUploadControls();

    // remove temp status
    const t = document.getElementById("tempStatus");
    if (t) t.remove();

    // keep page as-is (no reload)
  } catch (err) {
    console.error(err);
    const t = document.getElementById("tempStatus");
    if (t) t.remove();
    resultDiv.innerHTML = `<span style="color:#ff8686">Upload failed: ${escapeHtml(err.message || String(err))}</span>`;
  }
});

// helper
function escapeHtml(unsafe) {
  return (unsafe || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
