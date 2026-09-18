// HOW TO SCORE A | Stage 4 - Step 3
// Vercel Serverless Function: /api/parent-dashboard-data
//
// Security model:
// 1. Reads Parent's current Supabase access token.
// 2. Verifies the caller is role=parent.
// 3. Reads only ACTIVE Parent ↔ Student links for that Parent.
// 4. Returns only those linked children's data.
// 5. SUPABASE_SERVICE_ROLE_KEY stays server-side in Vercel.

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

async function getCaller(accessToken) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
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

async function hasParentRole(userId) {
  const rows = await rest(
    `user_roles?user_id=eq.${encodeURIComponent(userId)}&role=eq.parent&select=role&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows.length > 0;
}

function isExpired(dateStr) {
  if (!dateStr) return false;
  const end = new Date(`${dateStr}T23:59:59`);
  return Number.isFinite(end.getTime()) && end.getTime() < Date.now();
}

async function loadChild(link) {
  const studentRows = await rest(
    `students?id=eq.${encodeURIComponent(link.student_id)}&select=id,user_id,student_id,full_name,grade,status&limit=1`,
    { method: "GET" }
  );
  const student = studentRows?.[0] || null;
  if (!student) return null;

  const enrollments = await rest(
    `enrollments?student_id=eq.${encodeURIComponent(student.id)}&select=id,status,start_date,expiry_date,plan_days,course_id&order=expiry_date.desc`,
    { method: "GET" }
  );
  const enrollment = (enrollments || [])[0] || null;

  const progressRows = await rest(
    `scorea_student_progress?student_id=eq.${encodeURIComponent(student.id)}&select=current_cycle,current_day,xp,streak,focus,time_management,self_learning,completed_days_count,total_completed,updated_at&order=updated_at.desc&limit=1`,
    { method: "GET" }
  );
  const progress = progressRows?.[0] || null;

  const reflections = await rest(
    `scorea_daily_reflections?student_id=eq.${encodeURIComponent(student.id)}&cycle_number=neq.999&lesson_type=neq.SYSTEM%20TEST&select=cycle_number,day_number,lesson_type,lesson_title,lesson_question,reflection_text,completed_at&order=completed_at.desc&limit=60`,
    { method: "GET" }
  );

  const enrollmentView = enrollment
    ? {
        ...enrollment,
        computed_status:
          String(enrollment.status || "").toUpperCase() === "PAUSED"
            ? "PAUSED"
            : isExpired(enrollment.expiry_date)
              ? "EXPIRED"
              : String(enrollment.status || "ACTIVE").toUpperCase(),
      }
    : null;

  return {
    relationship: link.relationship || "parent",
    link_status: link.status || "ACTIVE",
    student,
    enrollment: enrollmentView,
    progress,
    reflections: reflections || [],
  };
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

    if (!(await hasParentRole(caller.id))) {
      return send(res, 403, {
        ok: false,
        error: "This account is not authorized as a Parent.",
      });
    }

    const profileRows = await rest(
      `scorea_parent_profiles?user_id=eq.${encodeURIComponent(caller.id)}&select=user_id,full_name,phone,status,created_at,updated_at&limit=1`,
      { method: "GET" }
    );
    const profile = profileRows?.[0] || null;

    if (!profile || String(profile.status || "").toUpperCase() !== "ACTIVE") {
      return send(res, 403, {
        ok: false,
        error: "Parent profile is not ACTIVE.",
      });
    }

    const links = await rest(
      `scorea_parent_student_links?parent_user_id=eq.${encodeURIComponent(caller.id)}&status=eq.ACTIVE&select=id,parent_user_id,student_id,relationship,status,created_at&order=created_at.asc`,
      { method: "GET" }
    );

    const children = [];
    for (const link of links || []) {
      const child = await loadChild(link);
      if (child) children.push(child);
    }

    return send(res, 200, {
      ok: true,
      parent: {
        user_id: caller.id,
        email: caller.email || "",
        full_name: profile.full_name,
        phone: profile.phone || null,
        status: profile.status,
      },
      children,
    });
  } catch (err) {
    console.error("parent-dashboard-data failed", err);
    return send(res, err.status || 500, {
      ok: false,
      error: err.message || "Unable to load Parent Dashboard.",
      detail: err.data || null,
    });
  }
};
