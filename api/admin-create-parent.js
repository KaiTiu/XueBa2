// HOW TO SCORE A | Stage 4 - Step 2
// Vercel Serverless Function: /api/admin-create-parent
//
// Creates:
// - Parent Auth user
// - role = parent
// - scorea_parent_profiles row
// - scorea_parent_student_links row
//
// Security:
// - caller must be logged in
// - caller must have admin role
// - SUPABASE_SERVICE_ROLE_KEY stays only in Vercel

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

async function createAuthUser(email, password, fullName) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        role: "parent",
        full_name: fullName,
      },
      app_metadata: {
        role: "parent",
        must_change_password: true,
        temporary_password_issued_at: new Date().toISOString(),
      },
    }),
  });
}

async function deleteAuthUser(userId) {
  try {
    await fetchJson(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    });
  } catch (e) {
    console.error("Cleanup parent Auth user failed", e);
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

  let createdAuthUserId = null;

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
    const fullName = String(body.full_name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const phone = String(body.phone || "").trim();
    const relationship = String(body.relationship || "parent").trim();
    const studentId = String(body.student_id || "").trim();

    if (!fullName) {
      return send(res, 400, { ok: false, error: "请输入家长姓名。" });
    }
    if (!email || !email.includes("@")) {
      return send(res, 400, { ok: false, error: "请输入有效的家长 Email。" });
    }
    if (password.length < 8) {
      return send(res, 400, {
        ok: false,
        error: "Temporary Password 至少需要 8 个字符。",
      });
    }
    if (!studentId) {
      return send(res, 400, { ok: false, error: "请选择要绑定的学生。" });
    }

    // Confirm the student exists.
    const studentRows = await serviceRest(
      `students?id=eq.${encodeURIComponent(studentId)}&select=id,student_id,full_name,grade,user_id&limit=1`,
      { method: "GET" }
    );
    const student = studentRows?.[0];
    if (!student) {
      return send(res, 404, { ok: false, error: "找不到要绑定的学生。" });
    }

    // Create Parent Auth account.
    const authUser = await createAuthUser(email, password, fullName);
    const parentUserId = authUser?.id;
    if (!parentUserId) {
      throw new Error("Parent Auth user creation did not return a user ID.");
    }
    createdAuthUserId = parentUserId;

    // Parent role.
    await serviceRest("user_roles", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: JSON.stringify({
        user_id: parentUserId,
        role: "parent",
      }),
    });

    // Parent profile.
    await serviceRest("scorea_parent_profiles", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: JSON.stringify({
        user_id: parentUserId,
        full_name: fullName,
        phone: phone || null,
        status: "ACTIVE",
        updated_at: new Date().toISOString(),
      }),
    });

    // Parent ↔ Student binding.
    const linkRows = await serviceRest("scorea_parent_student_links", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: JSON.stringify({
        parent_user_id: parentUserId,
        student_id: student.id,
        relationship: relationship || "parent",
        status: "ACTIVE",
        updated_at: new Date().toISOString(),
      }),
    });

    createdAuthUserId = null;

    return send(res, 201, {
      ok: true,
      parent: {
        user_id: parentUserId,
        full_name: fullName,
        email,
        phone: phone || null,
        role: "parent",
        status: "ACTIVE",
        password_type: "TEMPORARY",
        must_change_password: true,
      },
      student: {
        id: student.id,
        student_id: student.student_id,
        full_name: student.full_name,
        grade: student.grade,
      },
      link: linkRows?.[0] || null,
      message:
        "Parent account created and linked. Parent must change the Temporary Password on first login.",
    });
  } catch (err) {
    if (createdAuthUserId) {
      await deleteAuthUser(createdAuthUserId);
    }

    console.error("admin-create-parent failed", err);
    return send(res, err.status || 500, {
      ok: false,
      error: err.message || "Unable to create parent account.",
      detail: err.data || null,
    });
  }
};
