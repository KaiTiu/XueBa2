// HOW TO SCORE A | Temporary Password -> Permanent Password
// Vercel Serverless Function: /api/student-change-temporary-password
//
// Security:
// - The student's current Supabase access token identifies the student.
// - The SERVICE ROLE secret stays only in Vercel.
// - The endpoint changes ONLY the authenticated user's password.
// - It clears app_metadata.must_change_password after a successful change.

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

async function updateAuthUser(userId, attributes) {
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
    return send(res, 401, {
      ok: false,
      error: "Student login token is missing.",
    });
  }

  try {
    const user = await getCallerUser(accessToken);
    if (!user?.id) {
      return send(res, 401, { ok: false, error: "Invalid student session." });
    }

    if (user.app_metadata?.must_change_password !== true) {
      return send(res, 400, {
        ok: false,
        error: "This account is not waiting for a temporary password change.",
      });
    }

    const newPassword = String(req.body?.new_password || "");
    const confirmPassword = String(req.body?.confirm_password || "");

    if (newPassword.length < 8) {
      return send(res, 400, {
        ok: false,
        error: "新 Password 至少需要 8 个字符。",
      });
    }

    if (newPassword !== confirmPassword) {
      return send(res, 400, {
        ok: false,
        error: "两次输入的新 Password 不一致。",
      });
    }

    const mergedAppMetadata = {
      ...(user.app_metadata || {}),
      must_change_password: false,
      password_changed_at: new Date().toISOString(),
    };

    // Never keep the temporary-password marker after the change.
    delete mergedAppMetadata.temporary_password_issued_at;

    await updateAuthUser(user.id, {
      password: newPassword,
      app_metadata: mergedAppMetadata,
    });

    return send(res, 200, {
      ok: true,
      message:
        "Password 已更新。为了安全，请使用新 Password 重新登录课程。",
    });
  } catch (err) {
    console.error("student-change-temporary-password failed", err);
    return send(res, err.status || 500, {
      ok: false,
      error: err.message || "Unable to change temporary password.",
      detail: err.data || null,
    });
  }
};
