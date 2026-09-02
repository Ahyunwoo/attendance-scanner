/*
 * Change this one constant when the Google Apps Script Web App URL changes.
 * The value must be the deployed Web App URL ending in /exec.
 */
const API_URL = "https://script.google.com/macros/s/REPLACE_WITH_YOUR_SCRIPT_ID/exec";

const JSONP_TIMEOUT_MS = 12000;
const QR_CODE_MIN_LENGTH = 4;
const QR_CODE_MAX_LENGTH = 32;

const elements = {
  pinForm: document.querySelector("#pin-form"),
  pinInput: document.querySelector("#pin-input"),
  togglePin: document.querySelector("#toggle-pin"),
  startCamera: document.querySelector("#start-camera"),
  stopCamera: document.querySelector("#stop-camera"),
  reader: document.querySelector("#reader"),
  manualForm: document.querySelector("#manual-form"),
  attendanceId: document.querySelector("#attendance-id"),
  statusCard: document.querySelector("#status-card"),
  statusTitle: document.querySelector("#status-title"),
  statusMessage: document.querySelector("#status-message"),
  resultCard: document.querySelector("#result-card"),
  resultName: document.querySelector("#result-name"),
  resultRegion: document.querySelector("#result-region"),
  resultCenter: document.querySelector("#result-center"),
  resultTime: document.querySelector("#result-time"),
  scanAnother: document.querySelector("#scan-another"),
};

let scanner = null;
let isScannerRunning = false;
let isSubmitting = false;
let hasHandledScan = false;

document.addEventListener("DOMContentLoaded", () => {
  elements.pinForm.addEventListener("submit", handlePinSubmit);
  elements.stopCamera.addEventListener("click", () => stopScanner());
  elements.manualForm.addEventListener("submit", handleManualSubmit);
  elements.togglePin.addEventListener("click", togglePinVisibility);
  elements.scanAnother.addEventListener("click", prepareForAnotherScan);
  elements.pinInput.addEventListener("input", updateControlState);
  window.addEventListener("pagehide", () => stopScanner({ silent: true }));
  updateControlState();
});

async function handlePinSubmit(event) {
  event.preventDefault();

  const pin = getPin();
  if (!pin) {
    showStatus("warning", "PIN을 입력해 주세요", "PIN 입력 후 카메라를 시작할 수 있습니다.");
    elements.pinInput.focus();
    return;
  }

  if (!isApiConfigured()) {
    showStatus(
      "error",
      "API_URL 설정이 필요합니다",
      "js/app.js의 API_URL에 Google Apps Script Web App 주소를 입력한 뒤 다시 시도해 주세요.",
    );
    return;
  }

  await startScanner();
}

async function handleManualSubmit(event) {
  event.preventDefault();

  if (isSubmitting) return;

  const pin = getPin();
  const attendanceId = normalizeAttendanceId(elements.attendanceId.value);

  if (!pin) {
    showStatus("warning", "PIN을 입력해 주세요", "출석 등록 전에 직원 PIN이 필요합니다.");
    elements.pinInput.focus();
    return;
  }

  if (!attendanceId) {
    showStatus(
      "warning",
      "출석ID를 확인해 주세요",
      `영문 대문자와 숫자로 ${QR_CODE_MIN_LENGTH}~${QR_CODE_MAX_LENGTH}자리를 입력해 주세요.`,
    );
    elements.attendanceId.focus();
    return;
  }

  if (!isApiConfigured()) {
    showStatus(
      "error",
      "API_URL 설정이 필요합니다",
      "js/app.js의 API_URL에 Google Apps Script Web App 주소를 입력해 주세요.",
    );
    return;
  }

  await stopScanner({ silent: true });
  await submitAttendance(attendanceId, pin, "manual");
}

async function startScanner() {
  if (isScannerRunning || isSubmitting) return;

  if (
    typeof window.Html5Qrcode !== "function" ||
    !window.Html5QrcodeSupportedFormats ||
    window.Html5QrcodeSupportedFormats.QR_CODE === undefined
  ) {
    showStatus(
      "error",
      "스캐너를 불러오지 못했습니다",
      "인터넷 연결을 확인하고 페이지를 새로고침해 주세요.",
    );
    return;
  }

  hasHandledScan = false;
  elements.resultCard.hidden = true;
  showStatus("loading", "카메라를 준비하는 중입니다", "브라우저의 카메라 권한 요청이 나타나면 허용해 주세요.");
  updateControlState();

  const cameraConfigs = [
    { facingMode: { exact: "environment" } },
    { facingMode: "environment" },
  ];
  let lastError = null;

  for (const cameraConfig of cameraConfigs) {
    let nextScanner = null;

    try {
      nextScanner = createScanner();
      await nextScanner.start(cameraConfig, getScannerConfig(), handleScanSuccess, handleScanError);
      scanner = nextScanner;
      isScannerRunning = true;
      showStatus("loading", "QR을 스캔하는 중입니다", "출석 QR을 파란 가이드 안에 맞춰주세요.");
      updateControlState();
      return;
    } catch (error) {
      lastError = error;
      if (nextScanner) {
        try {
          await nextScanner.clear();
        } catch {
          // The scanner may not have created a video element when start() failed.
        }
      }
    }
  }

  showStatus("error", "카메라를 시작할 수 없습니다", getCameraErrorMessage(lastError));
  updateControlState();
}

function createScanner() {
  return new window.Html5Qrcode("reader", {
    formatsToSupport: [window.Html5QrcodeSupportedFormats.QR_CODE],
    verbose: false,
  });
}

function getScannerConfig() {
  return {
    fps: 10,
    qrbox: (viewfinderWidth, viewfinderHeight) => {
      const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.74);
      const size = Math.min(300, Math.max(160, edge));
      return { width: size, height: size };
    },
    aspectRatio: 1,
    disableFlip: false,
  };
}

function handleScanSuccess(decodedText) {
  if (hasHandledScan || isSubmitting) return;
  hasHandledScan = true;
  void processScanResult(decodedText);
}

function handleScanError() {
  // html5-qrcode calls this for every frame without a QR code. No user-facing
  // message is needed because the scanner is still working normally.
}

async function processScanResult(decodedText) {
  const attendanceId = normalizeAttendanceId(decodedText);

  await stopScanner({ silent: true });

  if (!attendanceId) {
    hasHandledScan = false;
    showStatus(
      "error",
      "올바른 출석 QR이 아닙니다",
      `QR에는 영문 대문자와 숫자로 된 출석ID(${QR_CODE_MIN_LENGTH}~${QR_CODE_MAX_LENGTH}자)가 있어야 합니다.`,
    );
    return;
  }

  const pin = getPin();
  if (!pin) {
    hasHandledScan = false;
    showStatus("warning", "PIN을 입력해 주세요", "QR은 인식했지만 출석 등록에는 직원 PIN이 필요합니다.");
    elements.pinInput.focus();
    return;
  }

  await submitAttendance(attendanceId, pin, "scan");
}

async function stopScanner(options = {}) {
  const { silent = false } = options;
  const activeScanner = scanner;
  scanner = null;
  isScannerRunning = false;
  updateControlState();

  if (activeScanner) {
    try {
      await activeScanner.stop();
    } catch {
      // A scanner that has already stopped does not need another action.
    }
    try {
      await activeScanner.clear();
    } catch {
      // clear() can fail if camera initialization was interrupted.
    }
  }

  if (!silent && !isSubmitting) {
    showStatus("neutral", "스캔을 중지했습니다", "카메라를 다시 시작하거나 출석ID를 직접 입력하세요.");
  }
}

async function submitAttendance(attendanceId, pin, source) {
  if (isSubmitting) return;

  isSubmitting = true;
  updateControlState();
  showStatus(
    "loading",
    "출석을 확인하는 중입니다",
    source === "scan" ? `${attendanceId} 출석ID를 전송하고 있습니다.` : "입력한 출석ID를 전송하고 있습니다.",
  );

  try {
    const response = await requestAttendance(attendanceId, pin);
    renderAttendanceResponse(response, attendanceId);
  } catch (error) {
    showStatus("error", "출석 등록에 실패했습니다", getRequestErrorMessage(error));
  } finally {
    isSubmitting = false;
    updateControlState();
  }
}

function requestAttendance(attendanceId, pin) {
  return new Promise((resolve, reject) => {
    const callbackName = `attendanceCallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, JSONP_TIMEOUT_MS);

    function cleanup() {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (payload) => {
      cleanup();
      resolve(payload);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("network"));
    };

    try {
      const requestUrl = new URL(API_URL);
      requestUrl.searchParams.set("action", "attendance");
      requestUrl.searchParams.set("attendanceId", attendanceId);
      requestUrl.searchParams.set("pin", pin);
      requestUrl.searchParams.set("callback", callbackName);
      script.src = requestUrl.toString();
      document.head.appendChild(script);
    } catch {
      cleanup();
      reject(new Error("invalid-url"));
    }
  });
}

function renderAttendanceResponse(rawResponse, attendanceId) {
  const response = normalizeResponse(rawResponse);

  if (!response || typeof response !== "object") {
    showStatus("error", "API 응답을 확인할 수 없습니다", "Apps Script API가 올바른 JSONP 응답을 반환하는지 확인해 주세요.");
    return;
  }

  const status = String(response.status ?? response.result ?? response.code ?? "").toLowerCase();
  const isDuplicate =
    response.duplicate === true ||
    response.alreadyAttended === true ||
    response.already_attended === true ||
    status.includes("duplicate") ||
    status.includes("already");

  if (isDuplicate) {
    elements.resultCard.hidden = true;
    showStatus(
      "warning",
      "이미 출석 처리된 ID입니다",
      getResponseMessage(response, `${attendanceId}는 이미 출석 등록되었습니다.`),
    );
    return;
  }

  const isSuccess = response.success === true || response.ok === true || ["success", "ok", "checked_in", "checkedin"].includes(status);

  if (!isSuccess) {
    elements.resultCard.hidden = true;
    showStatus("error", "출석 등록이 처리되지 않았습니다", getResponseMessage(response, "출석ID 또는 PIN을 확인한 뒤 다시 시도해 주세요."));
    return;
  }

  setText(elements.resultName, getResponseValue(response, ["name", "employeeName", "employee_name"]));
  setText(elements.resultRegion, getResponseValue(response, ["region", "area", "district"]));
  setText(elements.resultCenter, getResponseValue(response, ["center", "centerName", "center_name"]));
  setText(
    elements.resultTime,
    formatAttendanceTime(getResponseValue(response, ["attendanceTime", "attendance_time", "checkedInAt", "timestamp", "time"])),
  );
  elements.resultCard.hidden = false;
  showStatus("success", "출석이 완료되었습니다", `${attendanceId} 출석 등록이 정상적으로 처리되었습니다.`);
  elements.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function normalizeResponse(rawResponse) {
  let response = rawResponse;

  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      return null;
    }
  }

  if (!response || typeof response !== "object") return null;

  if (response.data && typeof response.data === "object" && !Array.isArray(response.data)) {
    return { ...response, ...response.data };
  }

  return response;
}

function getResponseValue(response, keys) {
  for (const key of keys) {
    if (response[key] !== undefined && response[key] !== null && String(response[key]).trim() !== "") {
      return String(response[key]);
    }
  }
  return "-";
}

function getResponseMessage(response, fallback) {
  return getResponseValue(response, ["message", "error", "reason"]) === "-"
    ? fallback
    : getResponseValue(response, ["message", "error", "reason"]);
}

function formatAttendanceTime(value) {
  if (!value || value === "-") return "-";

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function normalizeAttendanceId(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  const pattern = new RegExp(`^[A-Z0-9]{${QR_CODE_MIN_LENGTH},${QR_CODE_MAX_LENGTH}}$`);
  return pattern.test(normalized) ? normalized : "";
}

function getPin() {
  return String(elements.pinInput.value ?? "").trim();
}

function isApiConfigured() {
  return API_URL.startsWith("https://script.google.com/macros/s/") && !API_URL.includes("REPLACE_WITH_YOUR_SCRIPT_ID");
}

function togglePinVisibility() {
  const isPassword = elements.pinInput.type === "password";
  elements.pinInput.type = isPassword ? "text" : "password";
  elements.togglePin.setAttribute("aria-label", isPassword ? "PIN 숨기기" : "PIN 표시");
}

function prepareForAnotherScan() {
  elements.resultCard.hidden = true;
  elements.attendanceId.value = "";
  hasHandledScan = false;
  showStatus("neutral", "다음 출석을 준비했습니다", "카메라를 시작하거나 출석ID를 직접 입력하세요.");
  elements.manualForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

function updateControlState() {
  elements.startCamera.disabled = isScannerRunning || isSubmitting;
  elements.stopCamera.disabled = !isScannerRunning || isSubmitting;
  elements.pinInput.disabled = isSubmitting;
  elements.attendanceId.disabled = isSubmitting;
}

function showStatus(kind, title, message) {
  elements.statusCard.className = `status-card${kind === "neutral" ? "" : ` is-${kind}`}`;
  elements.statusTitle.textContent = title;
  elements.statusMessage.textContent = message;
}

function setText(element, value) {
  element.textContent = value || "-";
}

function getCameraErrorMessage(error) {
  const errorName = String(error?.name ?? "").toLowerCase();
  const errorText = String(error?.message ?? "").toLowerCase();

  if (errorName.includes("notallowed") || errorText.includes("permission") || errorText.includes("denied")) {
    return "카메라 권한이 거부되었습니다. 브라우저 설정에서 이 사이트의 카메라 권한을 허용한 뒤 다시 시도해 주세요.";
  }
  if (errorName.includes("notfound") || errorText.includes("camera")) {
    return "사용할 수 있는 카메라를 찾지 못했습니다. 카메라가 있는 기기에서 HTTPS로 접속해 주세요.";
  }
  if (errorName.includes("secure") || errorText.includes("secure") || errorText.includes("https")) {
    return "카메라는 HTTPS 환경에서만 사용할 수 있습니다. GitHub Pages 주소로 접속해 주세요.";
  }
  return "카메라 권한, 다른 앱의 카메라 사용 여부, HTTPS 접속 상태를 확인한 뒤 다시 시도해 주세요.";
}

function getRequestErrorMessage(error) {
  switch (error?.message) {
    case "timeout":
      return "API 응답 시간이 초과되었습니다. 네트워크 상태와 Apps Script 배포 상태를 확인해 주세요.";
    case "network":
      return "API에 연결하지 못했습니다. API_URL, 네트워크 연결, Apps Script 접근 권한을 확인해 주세요.";
    case "invalid-url":
      return "API_URL 형식이 올바르지 않습니다. js/app.js의 API_URL을 확인해 주세요.";
    default:
      return "일시적인 오류가 발생했습니다. 잠시 후 다시 시도하거나 교육 담당자에게 문의해 주세요.";
  }
}
