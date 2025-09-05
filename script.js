// script.js - simplified and reliable

const unlockBtn = document.getElementById("unlockBtn");
const uploadSection = document.getElementById("uploaderSection");
const apikeyInput = document.getElementById("apikey");
const uploadBtn = document.getElementById("uploadBtn");
const resultDiv = document.getElementById("result");
const keyMessage = document.getElementById("keyMessage");
const resetBtn = document.getElementById("resetBtn");

let API_KEY = null;

// --- UI helpers ---
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

  const certLink = document.createElement("a");
  certLink.href = data.certificateUrl;
  certLink.target = "_blank";
  certLink.textContent = "Download signed certificate (PDF)";
  certLink.className = "primary";
  certLink.style.marginLeft = "8px";
  certLink.style.padding = "8px 10px";

  resultDiv.appendChild(img);
  resultDiv.appendChild(link);
  resultDiv.appendChild(certLink);
  resetBtn.style.display = "inline-block"; // show reset button
}

function escapeHtml(unsafe) {
  return (unsafe || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// --- Reset handler ---
function resetApp() {
  API_KEY = null;
  sessionStorage.clear();

  apikeyInput.disabled = false;
  apikeyInput.value = "";
  unlockBtn.disabled = false;
  unlockBtn.textContent = "Unlock Upload";

  resultDiv.innerHTML = "";
  uploadSection.style.display = "none";
  enableUploadControls();

  keyMessage.textContent = "";
  keyMessage.style.color = "";
  resetBtn.style.display = "none";
}

resetBtn.addEventListener("click", (e) => {
  e.preventDefault();
  resetApp();
});

// --- Unlock handler ---
unlockBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  const key = apikeyInput.value.trim();
  if (!key) return alert("Enter API Key");

  unlockBtn.disabled = true;
  unlockBtn.textContent = "Checking...";

  try {
    const res = await fetch("http://localhost:3000/validate-key", {
      method: "POST",
      headers: { "x-api-key": key }
    });

    if (!res.ok) {
      unlockBtn.disabled = false;
      unlockBtn.textContent = "Unlock Upload";
      keyMessage.textContent = "Invalid API key";
      keyMessage.style.color = "#ff8080";
      return;
    }

    API_KEY = key; // save key in memory
    sessionStorage.setItem("wipe_api_key", key);

    apikeyInput.disabled = true;
    apikeyInput.value = "••••••••";
    unlockBtn.textContent = "Unlocked";
    keyMessage.textContent = "Unlocked";
    keyMessage.style.color = "#7ef9a6";
    uploadSection.style.display = "block";
  } catch (err) {
    console.error("Key validation failed", err);
    unlockBtn.disabled = false;
    unlockBtn.textContent = "Unlock Upload";
    keyMessage.textContent = "Network error";
    keyMessage.style.color = "#ff8080";
  }
});

// --- Upload handler ---
uploadBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!API_KEY) return alert("Unlock with API key first");

  const fileInput = document.getElementById("report");
  if (!fileInput.files || !fileInput.files[0]) return alert("Choose a PDF file");
  const file = fileInput.files[0];
  if (file.type !== "application/pdf") return alert("Please select a PDF");

  resultDiv.innerHTML = "<p style='color:#86a5b2'>Uploading...</p>";

  const fd = new FormData();
  fd.append("report", file);

  try {
    const res = await fetch("http://localhost:3000/upload", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: fd
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || `Server responded ${res.status}`);
    }

    const data = await res.json();
    sessionStorage.setItem("wipe_last_result", JSON.stringify(data));

    showResult(data);
    disableUploadControls();
  } catch (err) {
    console.error("Upload failed", err);
    resultDiv.innerHTML = `<span style="color:#ff8686">Upload failed: ${escapeHtml(
      err.message || String(err)
    )}</span>`;
  }
});

// --- Restore previous session if any ---
window.addEventListener("DOMContentLoaded", () => {
  const savedKey = sessionStorage.getItem("wipe_api_key");
  const savedResult = sessionStorage.getItem("wipe_last_result");

  if (savedKey) {
    API_KEY = savedKey;
    apikeyInput.disabled = true;
    apikeyInput.value = "••••••••";
    unlockBtn.textContent = "Unlocked";
    unlockBtn.disabled = true;
    keyMessage.textContent = "Unlocked (previous session)";
    keyMessage.style.color = "#7ef9a6";
    uploadSection.style.display = "block";
  }

  if (savedResult) {
    try {
      const data = JSON.parse(savedResult);
      showResult(data);
      disableUploadControls();
    } catch (e) {
      console.warn("Could not restore result", e);
    }
  }
});
