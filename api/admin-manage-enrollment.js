// HOW TO SCORE A | Stage 3 - Step 3C
// Vercel Serverless Function: /api/admin-manage-enrollment
// Secure actions: pause, resume, extend 30/180/365 days.

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

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
  return new Date(`${s}T00:00:00Z`);
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function todayUtcDate() {
  return new Date(`${new Date().toISOString().slice(0,10)}T00:00:00Z`);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isExpired(expiryDate) {
  const d = parseDate(expiryDate);
  if (!d) return true;
  return d < todayUtcDate();
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
    const enrollmentId = Number(body.enrollment_id);
    const action = String(body.action || "").trim().toLowerCase();
    const days = Number(body.days);

    if (!Number.isInteger(enrollmentId) || enrollmentId <= 0) {
      return send(res, 400, { ok: false, error: "Invalid enrollment_id." });
    }

    if (!["pause", "resume", "extend"].includes(action)) {
      return send(res, 400, { ok: false, error: "Invalid action." });
    }

    if (action === "extend" && ![30, 180, 365].includes(days)) {
      return send(res, 400, {
        ok: false,
        error: "Extend days must be 30, 180, or 365.",
      });
    }

    const enrollmentRows = await serviceRest(
      `enrollments?id=eq.${enrollmentId}&select=id,student_id,course_id,status,start_date,expiry_date,plan_days&limit=1`,
      { method: "GET" }
    );
    const enrollment = enrollmentRows?.[0];
    if (!enrollment) {
      return send(res, 404, { ok: false, error: "Enrollment not found." });
    }

    const courseRows = await serviceRest(
      `courses?id=eq.${encodeURIComponent(enrollment.course_id)}&select=id,course_code&limit=1`,
      { method: "GET" }
    );
    const course = courseRows?.[0];
    if (!course || course.course_code !== "SCORE-A") {
      return send(res, 400, {
        ok: false,
        error: "This enrollment is not a SCORE-A enrollment.",
      });
    }

    let patch = {};
    let message = "";

    if (action === "pause") {
      patch = { status: "PAUSED" };
      message = "课程已暂停。";
    }

    if (action === "resume") {
      if (isExpired(enrollment.expiry_date)) {
        return send(res, 400, {
          ok: false,
          code: "NEEDS_EXTENSION",
          error: "课程已经到期，请先延长 30 / 180 / 365 天，再恢复课程。",
        });
      }
      patch = { status: "ACTIVE" };
      message = "课程已恢复。";
    }

    if (action === "extend") {
      const today = todayUtcDate();
      const currentExpiry = parseDate(enrollment.expiry_date);

      // If still valid, add days after the existing expiry.
      // If already expired/missing, start a fresh inclusive period from today.
      let newExpiry;
      if (currentExpiry && currentExpiry >= today) {
        newExpiry = addDays(currentExpiry, days);
      } else {
        newExpiry = addDays(today, days - 1);
      }

      const currentStatus = String(enrollment.status || "").toUpperCase();
      patch = {
        expiry_date: formatDate(newExpiry),
        plan_days: days,
        status: currentStatus === "PAUSED" ? "PAUSED" : "ACTIVE",
      };
      message =
        currentStatus === "PAUSED"
          ? `已延长 ${days} 天；课程仍保持 PAUSED。`
          : `已延长 ${days} 天并保持 ACTIVE。`;
    }

    const updatedRows = await serviceRest(
      `enrollments?id=eq.${enrollmentId}&select=id,student_id,course_id,status,start_date,expiry_date,plan_days`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    );

    const updated = updatedRows?.[0];
    if (!updated) {
      throw new Error("Enrollment update returned no row.");
    }

    return send(res, 200, {
      ok: true,
      action,
      message,
      enrollment: updated,
    });
  } catch (err) {
    console.error("admin-manage-enrollment failed", err);
    return send(res, err.status || 500, {
      ok: false,
      error: err.message || "Unable to manage enrollment.",
      detail: err.data || null,
    });
  }
};
