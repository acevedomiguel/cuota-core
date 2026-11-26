import "/static/webauthn/index.js";

function csrfToken() {
  return document.querySelector('input[name="_csrf"]')?.value ?? "";
}

async function postJSON(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...body, _csrf: csrfToken() }),
  });
  const data = await response.json().catch(() => ({ error: "The server could not complete the passkey request." }));
  if (!response.ok) {
    const error = new Error(data.error || "The passkey request failed. Try again.");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function platformPasskeysAvailable() {
  if (typeof PublicKeyCredential === "undefined") return false;
  if (PublicKeyCredential.getClientCapabilities) {
    const capabilities = await PublicKeyCredential.getClientCapabilities();
    return capabilities.passkeyPlatformAuthenticator === true;
  }
  if (PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  }
  return false;
}

async function signalUnknownCredential(rpId, credentialId) {
  if (!PublicKeyCredential.signalUnknownCredential) return;
  try {
    await PublicKeyCredential.signalUnknownCredential({ rpId, credentialId });
  } catch (_) {}
}

function friendlyError(error) {
  if (error?.name === "InvalidStateError") return "A matching passkey already exists on this device.";
  if (error?.name === "SecurityError") return "Passkeys need HTTPS or localhost with matching server configuration.";
  if (error?.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out.";
  if (error?.name === "AbortError") return "The passkey request was cancelled.";
  return error?.message || "The passkey request failed. Try again.";
}

async function registerPasskey(status) {
  const options = await postJSON("/passkeys/register/options");
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
  const credential = await navigator.credentials.create({ publicKey });
  if (!credential) throw new Error("No passkey was created. Try again.");
  const encoded = credential.toJSON();
  try {
    await postJSON("/passkeys/register/verify", { credential: encoded });
  } catch (error) {
    await signalUnknownCredential(publicKey.rp.id, encoded.id);
    throw error;
  }
  status.textContent = "Passkey created. Reloading…";
  window.location.reload();
}

async function authenticatePasskey(status) {
  const options = await postJSON("/login/passkey/options");
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) throw new Error("No passkey was selected. Try again.");
  const encoded = credential.toJSON();
  try {
    await postJSON("/login/passkey/verify", { credential: encoded });
  } catch (error) {
    if (error.status === 404) await signalUnknownCredential(publicKey.rpId, encoded.id);
    throw error;
  }
  status.textContent = "Passkey verified. Opening cuota…";
  window.location.assign("/");
}

async function initialize() {
  const registerButton = document.getElementById("passkeyRegisterButton");
  const loginButton = document.getElementById("passkeyLoginButton");
  const buttons = [registerButton, loginButton].filter(Boolean);
  if (!buttons.length) return;

  let available = false;
  try { available = await platformPasskeysAvailable(); } catch (_) {}
  if (!available) {
    buttons.forEach((button) => { button.disabled = true; });
    document.querySelectorAll("[data-passkey-status]").forEach((element) => {
      element.textContent = "Platform passkeys are unavailable in this browser. Use your password.";
    });
    return;
  }

  for (const button of buttons) {
    button.disabled = false;
    button.addEventListener("click", async () => {
      const status = button === registerButton
        ? document.getElementById("passkeyRegisterStatus")
        : document.getElementById("passkeyLoginStatus");
      button.disabled = true;
      try {
        if (button === registerButton) await registerPasskey(status);
        else await authenticatePasskey(status);
      } catch (error) {
        status.textContent = friendlyError(error);
      } finally {
        button.disabled = false;
      }
    });
  }
}

initialize().catch((error) => {
  document.querySelectorAll("[data-passkey-status]").forEach((element) => {
    element.textContent = friendlyError(error);
  });
});
