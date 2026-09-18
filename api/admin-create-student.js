// HOW TO SCORE A | Stage 3 - Step 3A
// Vercel Serverless Function: /api/admin-create-student
// IMPORTANT: Never put SUPABASE_SERVICE_ROLE_KEY in admin.html or GitHub.
// Add it only in Vercel -> Project Settings -> Environment Variables.

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
  let data = null;
  const raw = await r.text();
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

async function getCallerUser(accessToken) {
  return fetchJson(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

async function callerIsAdmin(userId) {
  const url =
    `${SUPABASE_URL}/rest/v1/user_roles` +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    `&role=eq.admin&select=role&limit=1`;

  const rows = await fetchJson(url, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  return Array.isArray(rows) && rows.length > 0;
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

async function createAuthUser(email, password, fullName, grade) {
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
        role: "student",
        full_name: fullName,
        grade,
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
    console.error("Cleanup Auth user failed", e);
  }
}

function validDateString(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function expiryFrom(startDate, planDays) {
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + planDays - 1);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return send(res, 500, {
      ok: false,
      error:
        "Server is missing SUPABASE_SERVICE_ROLE_KEY in Vercel Environment Variables.",
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
    // 1) Verify the signed-in caller.
    const caller = await getCallerUser(accessToken);
    if (!caller?.id) {
      return send(res, 401, { ok: false, error: "Invalid Admin session." });
    }

    // 2) Verify ADMIN role on the server.
    if (!(await callerIsAdmin(caller.id))) {
      return send(res, 403, {
        ok: false,
        error: "This account does not have the admin role.",
      });
    }

    // 3) Read request body.
    const body = req.body || {};

    // 4) Confirm SCORE-A course exists.
    const courseRows = await serviceRest(
      "courses?course_code=eq.SCORE-A&is_active=eq.true&select=id,course_code&limit=1",
      { method: "GET" }
    );
    const course = courseRows?.[0];
    if (!course) {
      throw new Error("找不到 ACTIVE 的 SCORE-A course。");
    }

    // SAFE DRY RUN:
    // Verify Admin session + server secret + SCORE-A course BEFORE validating
    // student form fields. This creates nothing and consumes no Student ID.
    if (body.dry_run === true) {
      const existingStudents = await serviceRest(
        "students?student_id=like.SCORE-A*&select=student_id&order=student_id.desc&limit=1",
        { method: "GET" }
      );
      const highest = existingStudents?.[0]?.student_id || null;
      let nextPreview = "SCORE-A00001";
      if (highest) {
        const m = String(highest).match(/(\d+)$/);
        const n = m ? Number(m[1]) + 1 : 1;
        nextPreview = "SCORE-A" + String(n).padStart(5, "0");
      }

      return send(res, 200, {
        ok: true,
        mode: "dry_run",
        message: "Admin API is ready. No student was created.",
        admin_email: caller.email || null,
        service_role_configured: true,
        course_code: course.course_code,
        current_highest_student_id: highest,
        next_student_id_preview: nextPreview
      });
    }

    // 5) Validate real student creation input.
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.full_name || "").trim();
    const grade = String(body.grade || "").trim();
    const planDays = Number(body.plan_days);
    const startDate = validDateString(body.start_date)
      ? body.start_date
      : todayUtc();

    if (!email || !email.includes("@")) {
      return send(res, 400, { ok: false, error: "请输入有效的学生 Email。" });
    }
    if (password.length < 8) {
      return send(res, 400, {
        ok: false,
        error: "学生 Password 至少需要 8 个字符。",
      });
    }
    if (!fullName) {
      return send(res, 400, { ok: false, error: "请输入学生姓名。" });
    }
    if (!grade) {
      return send(res, 400, { ok: false, error: "请输入学生年级。" });
    }
    if (![30, 180, 365].includes(planDays)) {
      return send(res, 400, {
        ok: false,
        error: "plan_days 只允许 30、180 或 365。",
      });
    }

    // 6) Reserve the next Student ID from PostgreSQL sequence.
    const studentId = await serviceRest("rpc/next_scorea_student_id", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!studentId || typeof studentId !== "string") {
      throw new Error("无法产生 Student ID。");
    }

    // 6) Create Supabase Authentication user.
    const authUser = await createAuthUser(email, password, fullName, grade);
    const authId = authUser?.id;
    if (!authId) {
      throw new Error("Authentication user creation did not return a user ID.");
    }
    createdAuthUserId = authId;

    // 7) Create Student Profile.
    const studentRows = await serviceRest("students", {
      method: "POST",
      body: JSON.stringify({
        user_id: authId,
        student_id: studentId,
        full_name: fullName,
        grade,
        status: "ACTIVE",
      }),
    });
    const student = studentRows?.[0];
    if (!student?.id) {
      throw new Error("Student Profile creation failed.");
    }

    // 8) Mark role as student for the future Student / Parent / Admin split.
    await serviceRest("user_roles", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: JSON.stringify({
        user_id: authId,
        role: "student",
      }),
    });

    // 9) Create course entitlement.
    const expiryDate = expiryFrom(startDate, planDays);
    await serviceRest("enrollments", {
      method: "POST",
      body: JSON.stringify({
        student_id: student.id,
        course_id: course.id,
        plan_days: planDays,
        start_date: startDate,
        expiry_date: expiryDate,
        status: "ACTIVE",
      }),
    });

    createdAuthUserId = null; // Creation completed; do not cleanup.

    return send(res, 201, {
      ok: true,
      student: {
        student_id: studentId,
        full_name: fullName,
        grade,
        email,
        status: "ACTIVE",
      },
      enrollment: {
        course_code: "SCORE-A",
        plan_days: planDays,
        start_date: startDate,
        expiry_date: expiryDate,
        status: "ACTIVE",
      },
    });
  } catch (err) {
    // If a later DB step failed after Auth creation, remove the orphaned Auth user.
    if (createdAuthUserId) {
      await deleteAuthUser(createdAuthUserId);
    }

    console.error("admin-create-student failed", err);
    return send(res, err.status || 500, {
      ok: false,
      error: err.message || "Unable to create student.",
      detail: err.data || null,
    });
  }
};
