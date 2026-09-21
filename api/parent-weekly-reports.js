// HOW TO SCORE A with AI
// Stage 5A - Parent Weekly Growth Report History
// Vercel Serverless Function: /api/parent-weekly-reports
// Security: a Parent can only read reports for ACTIVE linked children.

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
    return send(res, 401, { ok: false, error: "Parent login token is missing." });
  }

  try {
    const caller = await getCaller(token);
    if (!caller?.id) {
      return send(res, 401, { ok: false, error: "Invalid Parent session." });
    }

    // Parent profile is the server-side authorization source of truth.
    const parentRows = await rest(
      `scorea_parent_profiles?user_id=eq.${encodeURIComponent(caller.id)}&status=eq.ACTIVE&select=user_id,full_name,status&limit=1`,
      { method: "GET" }
    );
    const parent = parentRows?.[0];
    if (!parent) {
      return send(res, 403, { ok: false, error: "This account is not an ACTIVE Parent Account." });
    }

    const studentId = String(req.body?.student_id || "").trim();
    if (!studentId) {
      return send(res, 400, { ok: false, error: "student_id is required." });
    }

    // The Parent must have an ACTIVE link to this exact student UUID.
    const links = await rest(
      `scorea_parent_student_links?parent_user_id=eq.${encodeURIComponent(caller.id)}` +
        `&student_id=eq.${encodeURIComponent(studentId)}` +
        `&status=eq.ACTIVE&select=id,student_id,relationship,status&limit=1`,
      { method: "GET" }
    );
    if (!links?.length) {
      return send(res, 403, {
        ok: false,
        error: "This Parent Account is not authorised to view this student's reports.",
      });
    }

    const reports = await rest(
      `scorea_weekly_reports?student_id=eq.${encodeURIComponent(studentId)}` +
        `&status=eq.GENERATED` +
        `&select=id,student_id,week_start,week_end,current_cycle,current_day,xp,focus,time_management,self_learning,reflection_count,active_days,strengths,improvement_focus,trend_topics,next_actions,parent_tip,reflection_summary,status,source_version,generated_at,created_at,updated_at` +
        `&order=week_end.desc&limit=12`,
      { method: "GET" }
    );

    return send(res, 200, {
      ok: true,
      parent: { full_name: parent.full_name || "Parent" },
      student_id: studentId,
      reports: Array.isArray(reports) ? reports : [],
    });
  } catch (err) {
    console.error("parent-weekly-reports failed", err);
    return send(res, err.status || 500, {
      ok: false,
      error: err.message || "Unable to load weekly reports.",
      detail: err.data || null,
    });
  }
};
