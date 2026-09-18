// HOW TO SCORE A | Stage 3C - Student Account Management
// Vercel Serverless Function: /api/admin-manage-student-account
//
// Actions:
// - get_account
// - update_email
// - reset_temp_password
//
// SECURITY:
// - Caller must be logged in and have role=admin.
// - SUPABASE_SERVICE_ROLE_KEY stays only in Vercel.
// - The browser never receives the service role key.

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  "https://htzkjfztqqsbzxahxfnt.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_-2O1fEqOGCQPSiMGQVSFrQ_bC3hf4WM";

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function send(res, status, body) {
  res.status(status).json(body);
}

async function fetchJson(url, options = {}) {
  const r = await fetch(url, options);
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }

  if (!r.ok) {
    const message =
      data?.msg ||
      data?.message ||
      data?.error_description ||
      data?.error ||
      raw ||
      `HTTP ${r.status}`;
    const err = new Error(message);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function getCallerUser(accessToken) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

async function adminGetAuthUser(userId) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
}

async function adminUpdateAuthUser(userId, attributes) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(attributes),
  });
}

async function serviceRest(path, options = {}) {
  const headers = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: options.prefer || "return=representation",
    ...(options.headers || {}),
  };

  return fetchJson(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers,
  });
}

async function callerIsAdmin(userId) {
  const rows = await serviceRest(
    `user_roles?user_id=eq.${encodeURIComponent(userId)}&role=eq.admin&select=role&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function bestEffortPatch(path, body, warnings, label) {
  try {
    await serviceRest(path, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify(body),
    });
  } catch (err) {
    warnings.push(`${label}: ${err.message || "update failed"}`);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return send(res, 500, {
      ok: false,
      error: "Server is missing SUPABASE_SERVICE_ROLE_KEY.",
    });
  }

  const authHeader = req.headers.authorization || "";
  const accessToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!accessToken) {
    return send(res, 401, { ok: false, error: "Admin login token is missing." });
  }

  try {
    const caller = await getCallerUser(accessToken);
    if (!caller?.id) {
      return send(res, 401, { ok: false, error: "Invalid Admin session." });
    }

    if (!(await callerIsAdmin(caller.id))) {
      return send(res, 403, {
        ok: false,
        error: "This account does not have the admin role.",
      });
    }

    const body = req.body || {};
    const action = String(body.action || "").trim().toLowerCase();
    const userId = String(body.user_id || "").trim();

    if (!["get_account", "update_email", "reset_temp_password"].includes(action)) {
      return send(res, 400, { ok: false, error: "Invalid action." });
    }

    if (!userId) {
      return send(res, 400, { ok: false, error: "Missing student user_id." });
    }

    const authUser = await adminGetAuthUser(userId);
    if (!authUser?.id) {
      return send(res, 404, { ok: false, error: "Student Auth user not found." });
    }

    // --------------------------------------------------------
    // GET CURRENT ACCOUNT
    // --------------------------------------------------------
    if (action === "get_account") {
      return send(res, 200, {
        ok: true,
        account: {
          user_id: authUser.id,
          email: authUser.email || "",
          must_change_password:
            authUser.app_metadata?.must_change_password === true,
          display_name:
            authUser.user_metadata?.full_name ||
            authUser.user_metadata?.name ||
            "",
        },
      });
    }

    // --------------------------------------------------------
    // CHANGE LOGIN EMAIL
    // --------------------------------------------------------
    if (action === "update_email") {
      const newEmail = String(body.new_email || "").trim().toLowerCase();
      const oldEmail = String(authUser.email || "").trim().toLowerCase();

      if (!newEmail || !newEmail.includes("@")) {
        return send(res, 400, {
          ok: false,
          error: "请输入有效的新 Email。",
        });
      }

      if (newEmail === oldEmail) {
        return send(res, 400, {
          ok: false,
          error: "新 Email 与目前 Email 相同。",
        });
      }

      const updatedUser = await adminUpdateAuthUser(userId, {
        email: newEmail,
        email_confirm: true,
      });

      const warnings = [];

      // Keep cloud reflection Email synchronized by user_id.
      await bestEffortPatch(
        `scorea_daily_reflections?user_id=eq.${encodeURIComponent(userId)}`,
        { student_email: newEmail },
        warnings,
        "scorea_daily_reflections"
      );

      // Keep free diagnostic/profile/challenge Email-based records usable.
      if (oldEmail) {
        const old = encodeURIComponent(oldEmail);

        await bestEffortPatch(
          `scorea_free_diagnostics?email=eq.${old}`,
          { email: newEmail },
          warnings,
          "scorea_free_diagnostics"
        );

        await bestEffortPatch(
          `scorea_free_learning_profiles?email=eq.${old}`,
          { email: newEmail },
          warnings,
          "scorea_free_learning_profiles"
        );

        await bestEffortPatch(
          `scorea_free_challenge_days?email=eq.${old}`,
          { email: newEmail },
          warnings,
          "scorea_free_challenge_days"
        );
      }

      return send(res, 200, {
        ok: true,
        action,
        message: "学生登录 Email 已更新。",
        account: {
          user_id: updatedUser?.id || authUser.id,
          old_email: oldEmail,
          email: updatedUser?.email || newEmail,
        },
        warnings,
      });
    }

    // --------------------------------------------------------
    // RESET TEMPORARY PASSWORD
    // --------------------------------------------------------
    if (action === "reset_temp_password") {
      const temporaryPassword = String(body.temporary_password || "");

      if (temporaryPassword.length < 8) {
        return send(res, 400, {
          ok: false,
          error: "Temporary Password 至少需要 8 个字符。",
        });
      }

      const appMetadata = {
        ...(authUser.app_metadata || {}),
        role: authUser.app_metadata?.role || "student",
        must_change_password: true,
        temporary_password_issued_at: new Date().toISOString(),
      };
      delete appMetadata.password_changed_at;

      const updatedUser = await adminUpdateAuthUser(userId, {
        password: temporaryPassword,
        app_metadata: appMetadata,
      });

      return send(res, 200, {
        ok: true,
        action,
        message:
          "Temporary Password 已重设。学生下一次登录必须先建立自己的新 Password。",
        account: {
          user_id: updatedUser?.id || authUser.id,
          email: updatedUser?.email || authUser.email || "",
          must_change_password: true,
        },
      });
    }
  } catch (err) {
    console.error("admin-manage-student-account failed", err);
    return send(res, err.status || 500, {
      ok: false,
      error: err.message || "Unable to manage student account.",
      detail: err.data || null,
    });
  }
};
