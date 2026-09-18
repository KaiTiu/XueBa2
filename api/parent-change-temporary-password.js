// HOW TO SCORE A | Stage 4 - Step 3
// Vercel Serverless Function: /api/parent-change-temporary-password
//
// Parent can change their own password.
// On first login, must_change_password=true is cleared only after success.

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

async function getCaller(token) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
}

async function isParent(userId) {
  const rows = await fetchJson(
    `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(userId)}&role=eq.parent&select=role&limit=1`,
    {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    }
  );
  return Array.isArray(rows) && rows.length > 0;
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
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    return send(res, 401, { ok: false, error: "Parent login token is missing." });
  }

  try {
    const caller = await getCaller(token);
    if (!caller?.id) {
      return send(res, 401, { ok: false, error: "Invalid Parent session." });
    }

    if (!(await isParent(caller.id))) {
      return send(res, 403, {
        ok: false,
        error: "This account is not authorized as a Parent.",
      });
    }

    const body = req.body || {};
    const newPassword = String(body.new_password || "");
    const confirmPassword = String(body.confirm_password || "");

    if (newPassword.length < 8) {
      return send(res, 400, {
        ok: false,
        error: "New Password 至少需要 8 个字符。",
      });
    }

    if (newPassword !== confirmPassword) {
      return send(res, 400, {
        ok: false,
        error: "两次输入的 New Password 不一致。",
      });
    }

    const existingAppMeta = caller.app_metadata || {};
    const newAppMeta = {
      ...existingAppMeta,
      role: "parent",
      must_change_password: false,
      password_changed_at: new Date().toISOString(),
    };
    delete newAppMeta.temporary_password_issued_at;

    await fetchJson(`${SUPABASE_URL}/auth/v1/admin/users/${caller.id}`, {
      method: "PUT",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        password: newPassword,
        app_metadata: newAppMeta,
      }),
    });

    return send(res, 200, {
      ok: true,
      message: "Password updated successfully.",
    });
  } catch (err) {
    console.error("parent-change-temporary-password failed", err);
    return send(res, err.status || 500, {
      ok: false,
      error: err.message || "Unable to update Parent password.",
      detail: err.data || null,
    });
  }
};
