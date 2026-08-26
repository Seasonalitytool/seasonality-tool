(function () {
  const supabaseUrl = window.SUPABASE_URL;
  const supabaseKey = window.SUPABASE_ANON_KEY;
  const client =
    window.supabase && supabaseUrl && supabaseKey ? window.supabase.createClient(supabaseUrl, supabaseKey) : null;

  let session = null;
  let profile = null; // { id, email, is_pro }
  const listeners = [];

  function state() {
    return {
      isSignedIn: !!session,
      isPro: !!(profile && profile.is_pro),
      email: session ? session.user.email : null,
    };
  }

  function notify() {
    const s = state();
    listeners.forEach((fn) => {
      try {
        fn(s);
      } catch (e) {
        console.error(e);
      }
    });
  }

  async function refreshProfile() {
    if (!client || !session) {
      profile = null;
      return;
    }
    const { data, error } = await client.from("profiles").select("is_pro, email").eq("id", session.user.id).single();
    if (!error) profile = data;
  }

  // ---- Modal + form elements --------------------------------------------------
  const overlay = document.getElementById("authModalOverlay");
  const closeBtn = document.getElementById("authModalClose");
  const accountBtn = document.getElementById("accountBtn");
  const form = document.getElementById("authForm");
  const emailInput = document.getElementById("authEmail");
  const passwordInput = document.getElementById("authPassword");
  const errorEl = document.getElementById("authError");
  const signUpBtn = document.getElementById("authSignUpBtn");
  const signedInPanel = document.getElementById("authSignedInPanel");
  const accountEmailEl = document.getElementById("authAccountEmail");
  const planBadgeEl = document.getElementById("authPlanBadge");
  const signOutBtn = document.getElementById("authSignOutBtn");
  const upgradeBtn = document.getElementById("upgradeBtn");
  const modalSub = document.getElementById("authModalSub");
  const DEFAULT_SUB = modalSub ? modalSub.textContent : "";

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  }

  function openModal(promptText) {
    if (!overlay) return;
    modalSub.textContent = promptText || DEFAULT_SUB;
    overlay.hidden = false;
    showError("");
  }

  function closeModal() {
    if (overlay) overlay.hidden = true;
  }

  function updateUI() {
    const s = state();
    if (accountBtn) {
      accountBtn.textContent = s.isSignedIn ? (s.isPro ? "★ Pro" : s.email.split("@")[0]) : "Sign In";
      accountBtn.classList.toggle("is-pro", s.isPro);
    }
    if (form) form.hidden = s.isSignedIn;
    if (signedInPanel) signedInPanel.hidden = !s.isSignedIn;
    if (s.isSignedIn) {
      if (accountEmailEl) accountEmailEl.textContent = s.email;
      if (planBadgeEl) {
        planBadgeEl.textContent = s.isPro ? "Pro plan — all features unlocked" : "Free plan";
        planBadgeEl.classList.toggle("is-pro", s.isPro);
      }
      if (upgradeBtn) upgradeBtn.hidden = s.isPro;
    }
  }

  if (accountBtn) accountBtn.addEventListener("click", () => openModal());
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!client) {
        showError("Auth isn't configured.");
        return;
      }
      showError("");
      const { error } = await client.auth.signInWithPassword({
        email: emailInput.value,
        password: passwordInput.value,
      });
      if (error) {
        showError(error.message);
        return;
      }
      closeModal();
    });
  }

  if (signUpBtn) {
    signUpBtn.addEventListener("click", async () => {
      if (!client) {
        showError("Auth isn't configured.");
        return;
      }
      showError("");
      const { error } = await client.auth.signUp({ email: emailInput.value, password: passwordInput.value });
      if (error) {
        showError(error.message);
        return;
      }
      showError("Check your email to confirm your account, then sign in.");
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      if (client) await client.auth.signOut();
      closeModal();
    });
  }

  if (upgradeBtn) {
    upgradeBtn.addEventListener("click", () => {
      showError("Stripe checkout isn't wired up yet — coming soon!");
    });
  }

  async function init() {
    updateUI();
    if (!client) return;
    const { data } = await client.auth.getSession();
    session = data.session;
    await refreshProfile();
    updateUI();
    notify();

    client.auth.onAuthStateChange(async (_event, newSession) => {
      session = newSession;
      await refreshProfile();
      updateUI();
      notify();
    });
  }

  init();

  window.SeasonalityAuth = {
    isPro: () => state().isPro,
    isSignedIn: () => state().isSignedIn,
    onChange: (fn) => listeners.push(fn),
    promptUpgrade: (msg) => openModal(msg),
  };
})();
