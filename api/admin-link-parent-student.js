// HOW TO SCORE A | Stage 4 - Step 4 FIX
// Vercel Function: /api/admin-link-parent-student
//
// Fix:
// Do not reject an existing Parent just because user_roles lookup is missing/out-of-sync.
// The caller must still be an Admin.
// The selected account must still have an ACTIVE scorea_parent_profiles record.

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
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!r.ok) {
    const msg =
      data?.msg ||
      data?.message ||
      data?.error_description ||
      data?.error ||
      raw ||
      `HTTP ${r.status}`;

    const err = new Error(msg);
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

async function rest(path, options = {}) {
  return fetchJson(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
  });
}

async function isAdmin(userId) {
  const rows = await rest(
    `user_roles?user_id=eq.${encodeURIComponent(userId)}&role=eq.admin&select=role&limit=1`,
    { method: "GET" }
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

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) {
    return send(res, 401, {
      ok: false,
      error: "Admin login token is missing.",
    });
  }

  try {
    const caller = await getCaller(token);

    if (!caller?.id) {
      return send(res, 401, {
        ok: false,
        error: "Invalid Admin session.",
      });
    }

    if (!(await isAdmin(caller.id))) {
      return send(res, 403, {
        ok: false,
        error: "This account does not have the admin role.",
      });
    }

    const body = req.body || {};
    const parentUserId = String(body.parent_user_id || "").trim();
    const studentId = String(body.student_id || "").trim();
    const relationship = String(body.relationship || "parent").trim();

    if (!parentUserId || !studentId) {
      return send(res, 400, {
        ok: false,
        error: "请选择 Parent 和 Student。",
      });
    }

    // Parent authorization source of truth:
    // the selected account must have an ACTIVE Parent Profile.
    const parentRows = await rest(
      `scorea_parent_profiles?user_id=eq.${encodeURIComponent(parentUserId)}&select=user_id,full_name,status&limit=1`,
      { method: "GET" }
    );

    const parent = parentRows?.[0];

    if (!parent) {
      return send(res, 404, {
        ok: false,
        error: "找不到 Parent Profile。",
      });
    }

    if (String(parent.status || "").toUpperCase() !== "ACTIVE") {
      return send(res, 400, {
        ok: false,
        error: "Parent Profile 目前不是 ACTIVE。",
      });
    }

    const studentRows = await rest(
      `students?id=eq.${encodeURIComponent(studentId)}&select=id,student_id,full_name,grade&limit=1`,
      { method: "GET" }
    );

    const student = studentRows?.[0];

    if (!student) {
      return send(res, 404, {
        ok: false,
        error: "找不到 Student。",
      });
    }

    // Check whether this Parent ↔ Student pair already exists.
    const existing = await rest(
      `scorea_parent_student_links?parent_user_id=eq.${encodeURIComponent(parentUserId)}&student_id=eq.${encodeURIComponent(studentId)}&select=id,status,relationship&limit=1`,
      { method: "GET" }
    );

    if (existing?.length) {
      const row = existing[0];

      if (String(row.status || "").toUpperCase() === "ACTIVE") {
        return send(res, 200, {
          ok: true,
          already_linked: true,
          message: "这个 Parent 已经绑定这位学生。",
          parent,
          student,
        });
      }

      const updated = await rest(
        `scorea_parent_student_links?id=eq.${encodeURIComponent(row.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "ACTIVE",
            relationship,
            updated_at: new Date().toISOString(),
          }),
        }
      );

      return send(res, 200, {
        ok: true,
        reactivated: true,
        parent,
        student,
        link: updated?.[0] || null,
        message: "Parent ↔ Student 绑定已重新启用。",
      });
    }

    const created = await rest("scorea_parent_student_links", {
      method: "POST",
      body: JSON.stringify({
        parent_user_id: parentUserId,
        student_id: studentId,
        relationship,
        status: "ACTIVE",
        updated_at: new Date().toISOString(),
      }),
    });

    return send(res, 201, {
      ok: true,
      parent,
      student,
      link: created?.[0] || null,
      message: "已把另一个孩子绑定到这个 Parent Account。",
    });
  } catch (err) {
    console.error("admin-link-parent-student failed", err);

    return send(res, err.status || 500, {
      ok: false,
      error: err.message || "Unable to link Parent and Student.",
      detail: err.data || null,
    });
  }
};
